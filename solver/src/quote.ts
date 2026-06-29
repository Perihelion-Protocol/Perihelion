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
 * than hard-coded. The default stub uses 6→7 (EVM USDC → Stellar USDC) only as
 * a documented example; any other corridor must supply the correct decimals.
 */

import { isExpired, fromSmallestUnits, toSmallestUnits } from "@perihelion/sdk";
import type { Intent } from "@perihelion/sdk";
import { zeroAddress, isAddressEqual, type Address } from "viem";
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
 * source-asset human unit. E.g. for USDC→USDC on a 1:1 corridor: 1.0.
 */
export type PriceOracle = (sourceAsset: string, destAsset: string) => Promise<number>;

/**
 * Returns the total fee cost expressed in dest-asset smallest units, covering
 * both the source-chain gas leg and the dest-chain (Stellar + LayerZero) leg.
 */
export type FeeEstimator = (intent: Intent) => Promise<bigint>;

// ─── defaults ────────────────────────────────────────────────────────────────

/**
 * Known decimal configurations for common assets.
 * Extend or replace with a live lookup in production.
 */
const KNOWN_DECIMALS: Record<string, number> = {
  // Stellar (7dp)
  "native": 7,
  // EVM stablecoins (6dp) — matched by lower-cased address prefix check below
};

/** Fallback decimal lookup: known table → 7dp for Stellar assets → error. */
export const defaultDecimalsLookup: DecimalsLookup = (assetId: string): number => {
  if (KNOWN_DECIMALS[assetId] !== undefined) return KNOWN_DECIMALS[assetId];
  // Stellar issued asset: "CODE:ISSUER"
  if (assetId.includes(":")) return 7;
  // EVM address (0x...): 6dp is the stablecoin convention; operators must
  // override for 18dp tokens. Throw to force explicit configuration.
  throw new Error(
    `[Perihelion] decimals not configured for asset "${assetId}". ` +
    `Provide a DecimalsLookup that returns the correct precision.`,
  );
};

/** 1:1 stub oracle — suitable only for same-value stablecoin corridors. */
export const defaultPriceOracle: PriceOracle = async () => 1.0;

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

  if (rate <= 0) throw new Error("[Perihelion] price oracle returned non-positive rate");

  // Convert source amount to human units, apply rate, convert to dest units.
  const humanSrc = fromSmallestUnits(intent.sourceAmount, srcDecimals);
  const humanDst = (parseFloat(humanSrc) * rate).toFixed(dstDecimals);
  return BigInt(toSmallestUnits(humanDst, dstDecimals));
}

// ─── decision types ──────────────────────────────────────────────────────────

export interface FillDecision {
  readonly fill: boolean;
  readonly reason: string;
  /**
   * True when the skip reason is durable (intent will never become profitable
   * or fillable). False indicates a transient condition worth retrying.
   */
  readonly terminal: boolean;
  /** Estimated profit in basis points of capital deployed, when computed. */
  readonly profitBps?: number;
}

// ─── evaluate ────────────────────────────────────────────────────────────────

/**
 * Decide whether to fill an intent.
 *
 * profit_bps = (proceeds - deliveryCost - fees) * 10_000 / proceeds
 * where deliveryCost = minDestAmount (solver must deliver at least this).
 */
// Decimal places for corridor assets.
// EVM stablecoins (USDC, EURC, …) use 6dp; Stellar assets use 7dp.
const SOURCE_DECIMALS = 6;
const DEST_DECIMALS = 7;

export async function priceDestAsset(intent: Intent): Promise<bigint> {
  // Convert source smallest-units → human → dest smallest-units for 1:1 rate.
  // This centralises the 6↔7 decimal corridor rather than baking in * 10n.
  const humanAmount = fromSmallestUnits(intent.sourceAmount, SOURCE_DECIMALS);
  return BigInt(toSmallestUnits(humanAmount, DEST_DECIMALS));

  // In production, fetch live quotes from an oracle or DEX:
  // const rate = await fetchStellarDexRate(intent.sourceAsset, intent.destAsset);
}

/**
 * Returns true when the intent is open to any solver or is reserved for
 * `solverAddress`. Uses viem helpers for checksum-insensitive comparison.
 */
export function isSolverEligible(
  preferredSolver: string,
  solverAddress: Address,
): boolean {
  const preferred = preferredSolver as Address;
  return (
    isAddressEqual(preferred, zeroAddress) ||
    isAddressEqual(preferred, solverAddress)
  );
}

/** Decide whether to fill an intent given current config and pricing. */
export async function evaluate(
  intent: Intent,
  config: SolverConfig,
  inventory: InventoryProvider = new UnlimitedInventoryProvider(),
  inFlight?: InFlightTracker,
): Promise<FillDecision> {
  // ── terminal checks ──────────────────────────────────────────────────────
  if (isExpired(intent)) {
    return { fill: false, reason: "intent expired", terminal: true };
  }
  if (!config.supportedDestAssets.includes(intent.destAsset)) {
    return { fill: false, reason: `unsupported dest asset ${intent.destAsset}`, terminal: true };
  }
  if (!isSolverEligible(intent.preferredSolver, config.solverAddress)) {
    return { fill: false, reason: "reserved for another solver" };
  }

  const minOut = BigInt(intent.minDestAmount);
  if (proceeds < minOut) {
    return { fill: false, reason: "cannot meet minDestAmount", terminal: false };
  }

  // ── profit check ─────────────────────────────────────────────────────────
  // profit = proceeds - delivery - fees
  // profitBps = profit * 10_000 / proceeds
  const profit = proceeds - minOut - fees;
  if (profit <= 0n) {
    return { fill: false, reason: "fee-inclusive profit is non-positive", terminal: false };
  }

  // Inventory check: ensure we can fund the fill after accounting for in-flight fills.
  const required = deliverable;
  const available = await inventory.availableBalance(intent.destAsset);
  const reserved = inFlight?.reservedFor(intent.destAsset) ?? 0n;
  if (available - reserved < required) {
    return { fill: false, reason: "insufficient inventory", marginBps };
  }

  return { fill: true, reason: "profitable", marginBps };
}
