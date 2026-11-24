// SPDX-License-Identifier: MIT

/**
 * Profitability evaluation for the reference solver.
 *
 * Economic model
 * ──────────────
 * profit = proceeds - deliveryCost - fees - riskBuffer
 *
 *   proceeds      = sourceAmount converted to dest-asset units at the cross rate
 *   deliveryCost  = amount of destAsset the solver must actually deliver (≥ minDestAmount)
 *   fees          = source-leg gas + dest-leg (Stellar/LayerZero) fees, in dest-asset units
 *   riskBuffer    = configurable bps of capital deployed to cover FX/inventory risk
 *
 * All inputs are explicit and injectable so production operators can wire in
 * real oracles without touching the decision logic.
 *
 * Decimal normalization
 * ─────────────────────
 * Source and destination decimals are passed in as explicit parameters rather
 * than hard-coded. The canonical asset table and corridor conversion rule live
 * in docs/assets.md; any production corridor must supply decimals that match
 * that table.
 */

import { isExpired, MIN_FILL_HEADROOM_SECS } from "@perihelion/sdk";
import type { Intent } from "@perihelion/sdk";
import { zeroAddress, isAddress, isAddressEqual, type Address } from "viem";
import type { SolverConfig } from "./config.js";
import type { InventoryProvider, InFlightTracker } from "./inventory.js";
import { UnlimitedInventoryProvider } from "./inventory.js";

// ─── injectable interfaces ───────────────────────────────────────────────────

/**
 * Returns the number of decimal places for the given asset identifier.
 * `assetId` is a Stellar asset string ("USDC:GA5Z...") or EVM token address.
 */
export type DecimalsLookup = (assetId: string) => number | Promise<number>;

/**
 * Returns the exchange rate: how many dest-asset human units equal one
 * source-asset human unit, scaled by {@link RATE_SCALE} (10^18). E.g. for a
 * 1:1 USDC→USDC corridor: `RATE_SCALE` itself.
 */
export type PriceOracle = (sourceAsset: string, destAsset: string) => Promise<bigint>;

/** Fixed-point scale for {@link PriceOracle} rates: `RATE_SCALE` == a rate of 1.0. */
export const RATE_SCALE = 10n ** 18n;

/**
 * Returns the total fee cost expressed in dest-asset smallest units, covering
 * both the source-chain gas leg and the dest-chain (Stellar + LayerZero) leg.
 */
export type FeeEstimator = (intent: Intent) => Promise<bigint>;

// ─── defaults ────────────────────────────────────────────────────────────────

/**
 * Known decimal configurations for common assets. Keep this aligned with
 * docs/assets.md, or replace it with a live lookup in production.
 */
const KNOWN_DECIMALS: Record<string, number> = {
  // Stellar (7dp)
  "native": 7,
};

/**
 * Thrown when an asset's decimals cannot be resolved. This is a durable
 * condition for the current configuration (retrying the same intent will
 * fail the same way), so {@link evaluate} classifies it as a terminal
 * `unsupported_asset` skip rather than a transient `pricing_error`.
 */
export class UnsupportedAssetError extends Error {
  readonly assetId: string;
  constructor(assetId: string, message: string) {
    super(message);
    this.name = "UnsupportedAssetError";
    this.assetId = assetId;
  }
}

/** Soroban contract id (SEP-41 token), e.g. `C…` strkey (56 chars). */
const SOROBAN_CONTRACT_ID = /^C[A-Z2-7]{55}$/;

/**
 * Fallback decimal lookup: known table → 7dp for Stellar assets → error.
 * Soroban contract tokens (`C…`) are not resolved here because that needs an
 * RPC simulation of `decimals()`; supply them via {@link createDecimalsLookup}
 * or a custom {@link DecimalsLookup}. Unresolvable assets throw
 * {@link UnsupportedAssetError}.
 */
export const defaultDecimalsLookup: DecimalsLookup = (assetId: string): number => {
  if (KNOWN_DECIMALS[assetId] !== undefined) return KNOWN_DECIMALS[assetId];
  // Stellar issued asset: "CODE:ISSUER" uses 7dp.
  if (assetId.includes(":")) return 7;
  if (SOROBAN_CONTRACT_ID.test(assetId)) {
    throw new UnsupportedAssetError(
      assetId,
      `[Perihelion] decimals not configured for Soroban contract token "${assetId}". ` +
      `Configure its decimals in the solver's decimals table.`,
    );
  }
  // EVM token address (0x...): decimals vary by token (6dp stablecoins, 18dp
  // WETH/DAI, etc.) and cannot be guessed safely — mispricing here moves real
  // money. Callers must supply a DecimalsLookup (e.g. an on-chain
  // erc20.decimals() reader) for EVM assets.
  throw new UnsupportedAssetError(
    assetId,
    `[Perihelion] decimals not configured for asset "${assetId}". ` +
    `Provide a DecimalsLookup that returns the correct precision.`,
  );
};

/**
 * Build a {@link DecimalsLookup} from an operator-configured table (asset id →
 * decimals), falling back to {@link defaultDecimalsLookup} for anything not in
 * the table. Use this to price `C…` SEP-41 tokens without an RPC lookup.
 */
export function createDecimalsLookup(
  configured: Readonly<Record<string, number>>,
  fallback: DecimalsLookup = defaultDecimalsLookup,
): DecimalsLookup {
  return (assetId: string) => {
    const dp = configured[assetId];
    if (dp !== undefined) return dp;
    return fallback(assetId);
  };
}

/** 1:1 stub oracle — suitable only for same-value stablecoin corridors. */
export const defaultPriceOracle: PriceOracle = async () => RATE_SCALE;

/** Zero-fee stub — operators must replace with real gas/LayerZero estimates. */
export const defaultFeeEstimator: FeeEstimator = async () => 0n;

// ─── core pricing function ───────────────────────────────────────────────────

export interface PricingDeps {
  decimalsLookup?: DecimalsLookup;
  priceOracle?: PriceOracle;
  feeEstimator?: FeeEstimator;
}

/**
 * Compute the solver's proceeds from an intent in dest-asset smallest units.
 * proceeds = sourceAmount × rate, with decimal normalization applied.
 */
export async function computeProceeds(
  intent: Intent,
  deps: PricingDeps = {},
): Promise<bigint> {
  const decimals = deps.decimalsLookup ?? defaultDecimalsLookup;
  const oracle = deps.priceOracle ?? defaultPriceOracle;

  const srcDecimals = await decimals(intent.sourceAsset);
  const dstDecimals = await decimals(intent.destAsset);
  const rate = await oracle(intent.sourceAsset, intent.destAsset);

  if (rate <= 0n) throw new Error("[Perihelion] price oracle returned non-positive rate");

  // Exact bigint arithmetic: sourceAmount * rate, rescaled from src decimals
  // and RATE_SCALE to dst decimals. Truncates toward zero (conservative).
  const srcAmount = BigInt(intent.sourceAmount);
  const scaleDiff = BigInt(dstDecimals) - BigInt(srcDecimals);
  const numerator = srcAmount * rate;
  return scaleDiff >= 0n
    ? (numerator * 10n ** scaleDiff) / RATE_SCALE
    : numerator / (RATE_SCALE * 10n ** -scaleDiff);
}

// ─── decision types ──────────────────────────────────────────────────────────

/**
 * Stable code from a closed set for metric labeling and programmatic handling.
 */
export type SkipCode =
  | "wrong_chain"
  | "expired"
  | "unsupported_asset"
  | "reserved"
  | "pricing_error"
  | "below_margin"
  | "implausible_profit"
  | "insufficient_inventory"
  | "insufficient_native_balance"
  | "missing_trustline";

export interface FillDecision {
  readonly fill: boolean;
  readonly reason: string;
  /** Stable skip code for metrics exposition when fill is false. */
  readonly code?: SkipCode;
  /**
   * True when the skip reason is durable (intent will never become profitable
   * or fillable). False indicates a transient condition worth retrying.
   */
  readonly terminal: boolean;
  /** Estimated profit in basis points of capital deployed, when computed. */
  readonly profitBps?: number;
  /** Estimated net profit in dest-asset smallest units (proceeds - minOut - fees). */
  readonly estimatedProfitSmallestUnits?: bigint;
  /** Estimated fee cost in dest-asset smallest units. */
  readonly estimatedFeeSmallestUnits?: bigint;
  /**
   * Set when the skip is caused by the solver lacking the *native* balance to
   * pay a fill leg's fees (source-chain gas + LayerZero, or Stellar XLM).
   * Distinct from an ordinary skip: it is an operator-actionable funding
   * condition that blocks every intent, not a property of this one, so callers
   * should surface it as an alert rather than a routine info log.
   */
  readonly nativeShortfall?: boolean;
  /**
   * Set when the skip is caused by profit exceeding the sanity bound (config.maxPlausibleProfitBps).
   * Indicates pricing or decimals misconfiguration.
   */
  readonly implausibleProfit?: boolean;
}

// ─── native-balance deps ─────────────────────────────────────────────────────

/**
 * Per-fill native-cost estimators. A fill spends three balances and only the
 * destination asset is covered by {@link InventoryProvider.availableBalance};
 * these cover the two native legs. Both are optional — when an estimator is
 * omitted, {@link evaluate} falls back to the corresponding configured floor
 * (`config.sourceNativeFeeFloor` / `config.stellarNativeFeeFloor`).
 */
export interface NativeCostDeps {
  /**
   * Estimated source-chain native cost of one fill, in wei: the LayerZero
   * quote for the intent plus the gas for `PerihelionEscrow.lock`. See
   * {@link escrowSourceNativeCost} for a factory over `PerihelionEscrowClient`.
   */
  sourceNativeCost?: (intent: Intent) => Promise<bigint> | bigint;
  /**
   * Estimated Stellar native cost of one fill, in stroops: `deliver_intent`
   * plus `dispatch_confirmation` (the latter including its `lz_fee`).
   */
  destNativeCost?: (intent: Intent) => Promise<bigint> | bigint;
}

/**
 * Build a {@link NativeCostDeps.sourceNativeCost} estimator from an escrow
 * client: the LayerZero quote for the intent, plus a fixed gas buffer (wei)
 * for the `lock` call itself. Wire this in production so the source-native
 * check reflects the real, per-intent cost rather than a static floor.
 */
export function escrowSourceNativeCost(
  escrow: { quoteFee(intent: Intent): Promise<bigint> },
  lockGasBufferWei: bigint = 0n,
): (intent: Intent) => Promise<bigint> {
  return async (intent: Intent) => (await escrow.quoteFee(intent)) + lockGasBufferWei;
}

// ─── recipient trustline deps ────────────────────────────────────────────────

/**
 * Result of a recipient-readiness probe: whether the Stellar recipient can
 * actually receive `destAsset` via the destination SAC `transfer`.
 *
 * For classic assets (`CODE:ISSUER`) the account must exist and hold an
 * authorised trustline; for `native` the account must exist. Soroban contract
 * tokens (`C…`) need no trustline and are always ready.
 */
export interface RecipientReadiness {
  readonly ready: boolean;
  /** Human-readable explanation when `ready` is false. */
  readonly reason?: string;
}

/**
 * Checks whether the intent's Stellar recipient can receive `destAsset`.
 * See {@link RecipientReadiness}. Wire this to an RPC `getLedgerEntries`
 * probe (the SDK ships a helper) so the solver never locks EVM funds for a
 * fill that `deliver_intent` would reject.
 */
export type RecipientReadinessCheck = (intent: Intent) => Promise<RecipientReadiness>;

/**
 * Default readiness check used when no {@link RecipientReadinessCheck} is
 * injected: assumes the recipient is ready. Operators should wire a real
 * `getLedgerEntries`-backed probe in production; without it the trustline
 * guard is a no-op.
 */
export const defaultRecipientReadinessCheck: RecipientReadinessCheck = async () => ({
  ready: true,
});

// ─── evaluate ────────────────────────────────────────────────────────────────

/**
 * Decide whether to fill an intent.
 *
 * profit_bps = (proceeds - deliveryCost - fees) * 10_000 / proceeds
 * where deliveryCost = minDestAmount (solver must deliver at least this).
 */
/**
 * Returns true when the intent is open to any solver or is reserved for
 * `solverAddress`. Uses viem helpers for checksum-insensitive comparison.
 *
 * `solverAddress` is `config.solverAddress` (`PERIHELION_SOLVER_ADDRESS`).
 * When executor configuration is present, startup validates that this address
 * equals the one derived from `PERIHELION_EVM_PRIVATE_KEY` (the identity the
 * escrow sees as `msg.sender`), so reserved-intent matching here cannot
 * diverge from the signing identity. In watch-only mode no key is present and
 * the explicit address is used as-is.
 */
export function isSolverEligible(
  preferredSolver: string,
  solverAddress: Address,
): boolean {
  // A malformed `preferredSolver` must not reach `isAddressEqual`, which throws
  // `InvalidAddressError` on invalid input. Treat it as ineligible so the
  // caller produces a terminal skip instead of an escaping exception.
  if (!isAddress(preferredSolver)) return false;
  const preferred = preferredSolver;
  return (
    isAddressEqual(preferred, zeroAddress) ||
    isAddressEqual(preferred, solverAddress)
  );
}

/**
 * Third argument to {@link evaluate}: an optional bag of injectable pricing
 * dependencies that may also double as the inventory provider. Callers can pass
 * pricing overrides (`priceOracle`/`feeEstimator`/`decimalsLookup`), an
 * inventory provider (`availableBalance`), or an object satisfying both.
 */
export type EvaluateDeps = PricingDeps &
  Partial<InventoryProvider> &
  NativeCostDeps & {
    /**
     * Probes whether the Stellar recipient can receive `destAsset` (exists and,
     * for classic assets, holds an authorised trustline). Defaults to
     * {@link defaultRecipientReadinessCheck}, which assumes readiness.
     */
    recipientReadiness?: RecipientReadinessCheck;
  };

/** Decide whether to fill an intent given current config and pricing. */
export async function evaluate(
  intent: Intent,
  config: SolverConfig,
  deps: EvaluateDeps = {},
  inFlight?: InFlightTracker,
): Promise<FillDecision> {
  // ── terminal checks ──────────────────────────────────────────────────────
  if (intent.sourceChainId !== config.sourceChainId) {
    return {
      fill: false,
      code: "wrong_chain",
      reason: `wrong chain ${intent.sourceChainId} (solver is on ${config.sourceChainId})`,
      terminal: true,
    };
  }
  if (isExpired(intent)) {
    return { fill: false, code: "expired", reason: "intent expired", terminal: true };
  }
  // Reject intents that lack sufficient deadline headroom for the Soroban
  // settlement contract.  The contract's validate_and_stage_fill guard is:
  //   if now.saturating_add(MIN_DISPATCH_WINDOW) > rec.deadline { return Err(IntentExpired) }
  // where MIN_DISPATCH_WINDOW = 1_800 s.  An intent that passes the plain
  // isExpired() check above but falls inside this window will have its EVM
  // lock succeed and its LayerZero fee paid, only for deliver_intent to reject
  // the fill — leaving the user's funds locked until cancelExpired.
  //
  // isExpired(intent, now, clockSkew) = intent.deadline <= now - clockSkew.
  // Passing clockSkew = -MIN_FILL_HEADROOM_SECS gives:
  //   intent.deadline <= now + MIN_FILL_HEADROOM_SECS
  // which rejects precisely when the remaining time is below the headroom.
  // This verdict is terminal: an intent inside the window now can never
  // regain headroom — time only moves forward.
  const nowSec = Math.floor(Date.now() / 1000);
  if (isExpired(intent, nowSec, -MIN_FILL_HEADROOM_SECS)) {
    return {
      fill: false,
      code: "expired",
      reason: `insufficient deadline headroom: ${intent.deadline - nowSec}s remaining, need >${MIN_FILL_HEADROOM_SECS}s`,
      terminal: true,
    };
  }
  if (!config.supportedDestAssets.includes(intent.destAsset)) {
    return { fill: false, code: "unsupported_asset", reason: `unsupported dest asset ${intent.destAsset}`, terminal: true };
  }
  if (!isSolverEligible(intent.preferredSolver, config.solverAddress)) {
    return { fill: false, code: "reserved", reason: "reserved for another solver", terminal: true };
  }
  // The destination SAC `transfer` to a `G…` recipient requires the account to
  // exist and, for classic assets, to hold an authorised trustline. Neither
  // the EVM escrow nor the Soroban registration checks this, so a fill would
  // lock the user's funds until cancelExpired while the solver pays the
  // LayerZero fee for nothing. Probe before any on-chain action and skip
  // terminally: a missing trustline is a durable property of the recipient,
  // not a transient condition.
  const readiness = await (deps.recipientReadiness ?? defaultRecipientReadinessCheck)(intent);
  if (!readiness.ready) {
    return {
      fill: false,
      code: "missing_trustline",
      reason: readiness.reason ?? `recipient cannot receive ${intent.destAsset}`,
      terminal: true,
    };
  }

  // ── pricing (transient failures → non-terminal skip so we retry later) ────
  let proceeds: bigint;
  let fees: bigint;
  try {
    proceeds = await computeProceeds(intent, deps);
    fees = await (deps.feeEstimator ?? defaultFeeEstimator)(intent);
  } catch (err) {
    // An asset whose decimals cannot be resolved will never price, so skip it
    // terminally instead of retrying it every tick.
    if (err instanceof UnsupportedAssetError) {
      return { fill: false, code: "unsupported_asset", reason: err.message, terminal: true };
    }
    return { fill: false, code: "pricing_error", reason: `pricing error: ${String(err)}`, terminal: false };
  }

  // The solver must deliver at least minDestAmount of the dest asset.
  const minOut = BigInt(intent.minDestAmount);
  if (proceeds < minOut) {
    return { fill: false, code: "below_margin", reason: "cannot meet minDestAmount", terminal: false };
  }

  // ── profit check ─────────────────────────────────────────────────────────
  // profit = proceeds - deliveryCost - fees, where deliveryCost = minDestAmount
  // profitBps = profit * 10_000 / proceeds
  const profit = proceeds - minOut - fees;
  if (profit <= 0n) {
    return { fill: false, code: "below_margin", reason: "fee-inclusive profit is non-positive", terminal: false };
  }
  // Carry profit at hundredths of a basis point so a sub-bps margin is not
  // truncated to zero before the gate. Compare against the minimum scaled by
  // 100, then convert to whole bps only for reporting.
  const profitBpsScaled = (profit * 1_000_000n) / proceeds;
  const minMarginBpsScaled = BigInt(config.minMarginBps) * 100n;
  if (profitBpsScaled < minMarginBpsScaled) {
    const profitBps = Number(profitBpsScaled / 100n);
    return {
      fill: false,
      code: "below_margin",
      reason: `margin ${profitBps}bps below minimum ${config.minMarginBps}bps`,
      terminal: false,
      profitBps,
    };
  }
  const profitBps = Number(profitBpsScaled / 100n);

  // ── sanity bound ──────────────────────────────────────────────────────────
  // A stablecoin corridor should never yield >10% profit; a figure this large
  // is far more likely to be a decimals/pricing misconfiguration than a real
  // opportunity, so refuse to fill rather than risk a catastrophic mis-quote.
  const maxPlausibleBps = config.maxPlausibleProfitBps ?? 1000;
  if (profitBps > maxPlausibleBps) {
    return {
      fill: false,
      code: "implausible_profit",
      reason: `implausible profit ${profitBps}bps exceeds sanity bound ${maxPlausibleBps}bps — check decimals/pricing config`,
      terminal: false,
      profitBps,
      implausibleProfit: true,
    };
  }

  // ── inventory check ───────────────────────────────────────────────────────
  // Use the caller-supplied provider if it exposes a balance, else unlimited.
  const inventory: InventoryProvider =
    typeof deps.availableBalance === "function"
      ? (deps as InventoryProvider)
      : new UnlimitedInventoryProvider();
  const required = minOut;
  const available = await inventory.availableBalance(intent.destAsset);
  const reserved = inFlight?.reservedFor(intent.destAsset) ?? 0n;
  if (available - reserved < required) {
    return { fill: false, code: "insufficient_inventory", reason: "insufficient inventory", terminal: false };
  }

  // ── native balance check ─────────────────────────────────────────────────
  // A fill also spends native gas on both legs, and neither spend is drawn
  // from destAsset: the payable EVM `lock` must cover the LayerZero quote plus
  // the gas to pull tokens and dispatch the message, and the Stellar leg
  // (deliver_intent + dispatch_confirmation, the latter taking an lz_fee)
  // needs a funded XLM account. Running dry *after* committing is far worse
  // than skipping — the worst ordering leaves the user's funds locked on the
  // source chain with the destination leg unpayable until cancelExpired — so a
  // shortfall on either side is a distinct, alertable skip, not a property of
  // this one intent. Each side is only checked when its balance is observable;
  // the cost falls back to the configured floor when no estimator is wired.
  if (typeof deps.nativeBalanceSource === "function") {
    const have = await deps.nativeBalanceSource();
    const need = deps.sourceNativeCost
      ? BigInt(await deps.sourceNativeCost(intent))
      : config.sourceNativeFeeFloor;
    if (have < need) {
      return {
        fill: false,
        code: "insufficient_native_balance",
        reason: "insufficient native balance on source chain (gas + LayerZero fee)",
        terminal: false,
        nativeShortfall: true,
      };
    }
  }
  if (typeof deps.nativeBalanceDest === "function") {
    const have = await deps.nativeBalanceDest();
    const need = deps.destNativeCost
      ? BigInt(await deps.destNativeCost(intent))
      : config.stellarNativeFeeFloor;
    if (have < need) {
      return {
        fill: false,
        code: "insufficient_native_balance",
        reason: "insufficient native XLM on Stellar (delivery + confirmation fees)",
        terminal: false,
        nativeShortfall: true,
      };
    }
  }

  return {
    fill: true,
    reason: "profitable",
    terminal: false,
    profitBps,
    estimatedProfitSmallestUnits: profit,
    estimatedFeeSmallestUnits: fees,
  };
}
