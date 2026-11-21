// SPDX-License-Identifier: MIT

/**
 * Keeper helpers and Soroban settlement client for refund liveness and
 * split-path confirmation recovery (issue #1123).
 *
 * Provides:
 * - Protocol constants (`MAX_LIST_BATCH`, `MIN_DISPATCH_WINDOW_SECS`,
 *   `CROSS_CHAIN_LATENCY_BUDGET_SECS`, `DISPATCH_REWARD_GRACE_LEDGERS`)
 *   and `dispatchCutoff(deadline)`.
 * - Pure profitability evaluators for Soroban (`evaluateSorobanKeeperProfitability`)
 *   and EVM (`evaluateEvmCancelCostGuard`).
 * - `PerihelionSettlementClient` for querying and invoking keeper entrypoints
 *   on the Soroban settlement contract (`cancel_expired_intent`,
 *   `dispatch_confirmation`, `list_undispatched_intents`, fee/reward views,
 *   and contract event scanning).
 */

import {
  Account,
  Address as StellarSdkAddress,
  Asset,
  Contract,
  Keypair,
  Operation,
  SorobanRpc,
  TransactionBuilder,
  nativeToScVal,
  scValToNative,
  xdr,
  type Transaction,
} from "@stellar/stellar-sdk";
import { OnChainIntentStatus, decodeIntentStatus, type Hex } from "./types.js";
import {
  quoteInclusionFee,
  resolveInclusionFeePolicy,
  submitAndWait,
  submitWithFeeEscalation,
  type InclusionFeePolicy,
  type SubmitAndWaitOptions,
} from "./soroban-submit.js";

// ---------------------------------------------------------------------------
// Protocol Constants & Pure Helpers
// ---------------------------------------------------------------------------

/**
 * Maximum number of intent hashes accepted by `list_undispatched_intents` in a
 * single Soroban invocation (issue #1075). Inputs larger than this revert with
 * `PerihelionError::BatchTooLarge`.
 */
export const MAX_LIST_BATCH = 100;

/**
 * Minimum time window (in seconds) required after `deliver_intent` for
 * `dispatch_confirmation` to complete (`MIN_DISPATCH_WINDOW = 1_800` in
 * `contracts/soroban/settlement/src/lib.rs`).
 */
export const MIN_DISPATCH_WINDOW_SECS = 1_800;

/**
 * Cross-chain latency budget `L` (in seconds) reserved for LayerZero DVN
 * verification and executor delivery before the earliest possible EVM refund
 * boundary (`CROSS_CHAIN_LATENCY_BUDGET = 1_200` in
 * `contracts/soroban/settlement/src/lib.rs`, issue #1067).
 */
export const CROSS_CHAIN_LATENCY_BUDGET_SECS = 1_200;

/**
 * Minimum ledgers a fill must remain unconfirmed before a third-party caller
 * (`caller != solver`) is eligible for `DispatchKeeperReward`
 * (`DISPATCH_REWARD_GRACE_LEDGERS = 360` in
 * `contracts/soroban/settlement/src/lib.rs`, issues #913 / #914).
 */
export const DISPATCH_REWARD_GRACE_LEDGERS = 360;

/**
 * Latest Stellar ledger timestamp at which `dispatch_confirmation` may still
 * dispatch a `FillConfirmed` message for an intent with `deadline` (issue #1067).
 *
 * Mirrors `dispatch_cutoff(deadline)` in `contracts/soroban/settlement/src/lib.rs`:
 * `deadline + MIN_DISPATCH_WINDOW - CROSS_CHAIN_LATENCY_BUDGET` (`deadline + 600s`).
 */
export function dispatchCutoff(deadline: bigint | number): bigint {
  return (
    BigInt(deadline) + BigInt(MIN_DISPATCH_WINDOW_SECS) - BigInt(CROSS_CHAIN_LATENCY_BUDGET_SECS)
  );
}

// ---------------------------------------------------------------------------
// Profitability Guards
// ---------------------------------------------------------------------------

/** Inputs to {@link evaluateSorobanKeeperProfitability}. */
export interface SorobanProfitabilityInput {
  /** Configured on-chain keeper reward in stroops (`keeper_reward` or `dispatch_keeper_reward`). */
  readonly rewardStroops: bigint;
  /** Quoted LayerZero native fee in stroops (including any configured buffer). */
  readonly lzFeeStroops: bigint;
  /** Estimated Soroban inclusion + resource fee in stroops. */
  readonly inclusionFeeStroops: bigint;
  /** Minimum net profit in stroops required to execute. Defaults to `0n`. */
  readonly minNetProfitStroops?: bigint;
  /**
   * Optional native token (XLM) balance of the settlement contract in stroops.
   * When provided and less than a positive `rewardStroops`, the decision fails
   * with `"insufficient_reserve"`.
   */
  readonly contractReserveStroops?: bigint;
  /**
   * Whether the caller is currently eligible to receive `rewardStroops`.
   * For `dispatch_confirmation`, this is `caller !== solver && currentLedger - fillLedger >= DISPATCH_REWARD_GRACE_LEDGERS`.
   * Defaults to `true`.
   */
  readonly rewardEligible?: boolean;
}

/** Reasons a keeper action may be skipped by a profitability or cost guard. */
export type ProfitabilitySkipReason =
  | "unprofitable"
  | "insufficient_reserve"
  | "awaiting_dispatch_reward_grace"
  | "gas_price_exceeds_cap"
  | "cancel_cost_exceeds_cap";

/** Outcome of {@link evaluateSorobanKeeperProfitability}. */
export interface ProfitabilityDecision {
  readonly profitable: boolean;
  readonly netProfitStroops: bigint;
  readonly totalCostStroops: bigint;
  readonly effectiveRewardStroops: bigint;
  readonly reason?: ProfitabilitySkipReason;
}

/**
 * Evaluate whether a Soroban keeper invocation (`cancel_expired_intent` or
 * `dispatch_confirmation`) satisfies the operator's profitability policy.
 */
export function evaluateSorobanKeeperProfitability(
  input: SorobanProfitabilityInput,
): ProfitabilityDecision {
  const totalCostStroops = input.lzFeeStroops + input.inclusionFeeStroops;
  const minNetProfitStroops = input.minNetProfitStroops ?? 0n;
  const rewardEligible = input.rewardEligible ?? true;

  if (
    input.contractReserveStroops !== undefined &&
    input.rewardStroops > 0n &&
    input.contractReserveStroops < input.rewardStroops
  ) {
    return {
      profitable: false,
      netProfitStroops: -totalCostStroops,
      totalCostStroops,
      effectiveRewardStroops: 0n,
      reason: "insufficient_reserve",
    };
  }

  if (!rewardEligible) {
    const effectiveRewardStroops = 0n;
    const netProfitStroops = -totalCostStroops;
    if (netProfitStroops >= minNetProfitStroops) {
      return {
        profitable: true,
        netProfitStroops,
        totalCostStroops,
        effectiveRewardStroops,
      };
    }
    const potentialNetProfit = input.rewardStroops - totalCostStroops;
    if (input.rewardStroops > 0n && potentialNetProfit >= minNetProfitStroops) {
      return {
        profitable: false,
        netProfitStroops,
        totalCostStroops,
        effectiveRewardStroops,
        reason: "awaiting_dispatch_reward_grace",
      };
    }
    return {
      profitable: false,
      netProfitStroops,
      totalCostStroops,
      effectiveRewardStroops,
      reason: "unprofitable",
    };
  }

  const effectiveRewardStroops = input.rewardStroops;
  const netProfitStroops = effectiveRewardStroops - totalCostStroops;
  if (netProfitStroops < minNetProfitStroops) {
    return {
      profitable: false,
      netProfitStroops,
      totalCostStroops,
      effectiveRewardStroops,
      reason: "unprofitable",
    };
  }

  return {
    profitable: true,
    netProfitStroops,
    totalCostStroops,
    effectiveRewardStroops,
  };
}

/** Inputs to {@link evaluateEvmCancelCostGuard}. */
export interface EvmCancelCostGuardInput {
  readonly gasPriceWei: bigint;
  readonly estimatedGas: bigint;
  readonly maxGasPriceWei?: bigint;
  readonly maxCancelCostWei?: bigint;
  readonly rewardWei?: bigint;
  readonly minNetProfitWei?: bigint;
}

/** Outcome of {@link evaluateEvmCancelCostGuard}. */
export interface EvmCancelCostGuardDecision {
  readonly allowed: boolean;
  readonly totalCostWei: bigint;
  readonly netProfitWei: bigint;
  readonly reason?: ProfitabilitySkipReason;
}

/**
 * Evaluate whether an EVM `cancelExpired` call is within the operator's gas
 * price, total cost, and optional net-profit caps.
 */
export function evaluateEvmCancelCostGuard(
  input: EvmCancelCostGuardInput,
): EvmCancelCostGuardDecision {
  const totalCostWei = input.gasPriceWei * input.estimatedGas;
  const rewardWei = input.rewardWei ?? 0n;
  const netProfitWei = rewardWei - totalCostWei;

  if (input.maxGasPriceWei !== undefined && input.gasPriceWei > input.maxGasPriceWei) {
    return {
      allowed: false,
      totalCostWei,
      netProfitWei,
      reason: "gas_price_exceeds_cap",
    };
  }

  if (input.maxCancelCostWei !== undefined && totalCostWei > input.maxCancelCostWei) {
    return {
      allowed: false,
      totalCostWei,
      netProfitWei,
      reason: "cancel_cost_exceeds_cap",
    };
  }

  if (input.minNetProfitWei !== undefined && netProfitWei < input.minNetProfitWei) {
    return {
      allowed: false,
      totalCostWei,
      netProfitWei,
      reason: "unprofitable",
    };
  }

  return {
    allowed: true,
    totalCostWei,
    netProfitWei,
  };
}

// ---------------------------------------------------------------------------
// Soroban Settlement Client Types
// ---------------------------------------------------------------------------

/**
 * Decoded representation of the on-chain Soroban `IntentRecord`
 * (`contracts/soroban/settlement/src/types.rs`).
 */
export interface SorobanIntentRecord {
  readonly intentHash: Hex;
  readonly srcEid: number;
  readonly recipient: string;
  readonly destAsset: string;
  readonly minDestAmount: bigint;
  readonly deadline: bigint;
  readonly preferredSolver?: string;
  readonly reservationExpires: bigint;
  readonly status: OnChainIntentStatus;
  readonly solver?: string;
  readonly solverEvm?: Hex;
  readonly fillAmount: bigint;
  readonly fillLedger: number;
  readonly registeredLedger: number;
}

/** Lifecycle event types emitted by the Soroban settlement contract. */
export type SorobanIntentEventType =
  | "registered"
  | "filled"
  | "confirmation_sent"
  | "cancelled"
  | "cancelled_inbound"
  | "cancelled_before_registration";

/** A decoded lifecycle event from the Soroban settlement contract. */
export interface SorobanIntentEvent {
  readonly type: SorobanIntentEventType;
  readonly intentHash: Hex;
  readonly ledger: number;
  readonly txHash?: string;
  readonly srcEid?: number;
  readonly deadline?: bigint;
  readonly solver?: string;
  readonly destAsset?: string;
  readonly fillAmount?: bigint;
  readonly feePaid?: bigint;
}

/** Result of {@link PerihelionSettlementClient.scanIntentEvents}. */
export interface SorobanIntentEventScanResult {
  readonly events: SorobanIntentEvent[];
  readonly registered: Array<{
    readonly intentHash: Hex;
    readonly srcEid: number;
    readonly deadline: bigint;
    readonly ledger: number;
    readonly txHash?: string;
  }>;
  readonly filled: Array<{
    readonly intentHash: Hex;
    readonly solver: string;
    readonly destAsset: string;
    readonly fillAmount: bigint;
    readonly srcEid: number;
    readonly ledger: number;
    readonly txHash?: string;
  }>;
  readonly confirmationSent: Hex[];
  readonly cancelled: Hex[];
  readonly latestLedger: number;
  readonly latestLedgerTimestamp?: bigint;
  readonly nextLedger: number;
}

/** Result of a state-mutating Soroban keeper call. */
export interface SorobanKeeperTxResult {
  readonly txHash: string;
  readonly intentHash: Hex;
  readonly lzFeeStroops: bigint;
  readonly inclusionFeeStroops: number;
  readonly feeChargedStroops: bigint;
  readonly attempts: number;
}

/** Configuration for {@link PerihelionSettlementClient}. */
export interface PerihelionSettlementClientConfig {
  /** Soroban RPC endpoint URL. */
  readonly rpcUrl: string;
  /** Stellar network passphrase (e.g., "Test SDF Network ; September 2015"). */
  readonly networkPassphrase: string;
  /** Soroban settlement contract ID (C... strkey). */
  readonly settlementContractId: string;
  /**
   * Signer secret key (S... strkey). Required for state-mutating operations
   * (`cancelExpiredIntent`, `dispatchConfirmation`); optional for read views.
   */
  readonly signerSecret?: string;
  /**
   * Optional Stellar Asset Contract (SAC) ID for the native token (XLM), used
   * to query the settlement contract's keeper reward reserve balance.
   */
  readonly nativeTokenContractId?: string;
  /** Safety buffer (in stroops) added to quoted LayerZero fees. Defaults to 0n. */
  readonly lzFeeBufferStroops?: bigint;
  /** Operator policy for Soroban inclusion fees. */
  readonly inclusionFee?: InclusionFeePolicy;
  /** Transaction timeout in seconds. Defaults to 30. */
  readonly timeoutSeconds?: number;
  /** Polling and backoff options for transaction confirmation. */
  readonly submitOptions?: SubmitAndWaitOptions;
  /** Optional pre-constructed `SorobanRpc.Server` instance (for testing). */
  readonly rpc?: SorobanRpc.Server;
  /** Optional logger for fee escalation warnings. */
  readonly logger?: { warn(message: string, meta?: Record<string, unknown>): void };
}

// ---------------------------------------------------------------------------
// PerihelionSettlementClient
// ---------------------------------------------------------------------------

/**
 * Client for querying and invoking keeper and settlement entrypoints on the
 * Soroban settlement contract (`contracts/soroban/settlement/src/lib.rs`).
 */
export class PerihelionSettlementClient {
  private readonly rpc: SorobanRpc.Server;
  private readonly networkPassphrase: string;
  private readonly settlementContractId: string;
  private readonly signerKeypair?: Keypair;
  private readonly readKeypair: Keypair;
  private readonly nativeTokenContractId?: string;
  private readonly lzFeeBufferStroops: bigint;
  private readonly inclusionFee: Required<InclusionFeePolicy>;
  private readonly timeoutSeconds: number;
  private readonly submitOptions?: SubmitAndWaitOptions;
  private readonly logger?: { warn(message: string, meta?: Record<string, unknown>): void };

  constructor(config: PerihelionSettlementClientConfig) {
    this.rpc =
      config.rpc ??
      new SorobanRpc.Server(config.rpcUrl, {
        allowHttp: config.rpcUrl.startsWith("http://"),
      });
    this.networkPassphrase = config.networkPassphrase;
    this.settlementContractId = config.settlementContractId;
    this.signerKeypair = config.signerSecret ? Keypair.fromSecret(config.signerSecret) : undefined;
    this.readKeypair = this.signerKeypair ?? Keypair.random();
    this.nativeTokenContractId = config.nativeTokenContractId;
    this.lzFeeBufferStroops = config.lzFeeBufferStroops ?? 0n;
    this.inclusionFee = resolveInclusionFeePolicy(config.inclusionFee);
    this.timeoutSeconds = config.timeoutSeconds ?? 30;
    this.submitOptions = config.submitOptions;
    this.logger = config.logger;
  }

  /** Stellar public key (`G...` strkey) of the configured signer, if present. */
  get callerPublicKey(): string | undefined {
    return this.signerKeypair?.publicKey();
  }

  /**
   * Read the authoritative `status(intent_hash)` view on the settlement contract.
   * Returns `undefined` when the intent is not registered.
   */
  async status(intentHash: Hex): Promise<OnChainIntentStatus | undefined> {
    const retval = await this.simulateView("status", [this.intentHashScVal(intentHash)]);
    if (!retval) return undefined;
    if (typeof retval === "object" && "switch" in retval && typeof retval.switch === "function") {
      if (retval.switch().name === "scvVoid") return undefined;
    }
    try {
      const native: unknown = scValToNative(retval);
      if (native === undefined || native === null) return undefined;
      return decodeIntentStatus(typeof native === "bigint" ? Number(native) : native);
    } catch {
      return decodeIntentStatus(retval);
    }
  }

  /**
   * Read `get_intent(intent_hash)` on the settlement contract.
   * Returns `undefined` when no live `IntentRecord` exists.
   */
  async getIntent(intentHash: Hex): Promise<SorobanIntentRecord | undefined> {
    const retval = await this.simulateView("get_intent", [this.intentHashScVal(intentHash)]);
    if (!retval) return undefined;
    if (typeof retval === "object" && "switch" in retval && typeof retval.switch === "function") {
      if (retval.switch().name === "scvVoid") return undefined;
    }
    let native: unknown;
    try {
      native = scValToNative(retval);
    } catch {
      return undefined;
    }
    return decodeSorobanIntentRecord(native, intentHash);
  }

  /**
   * Read `keeper_reward()` (in stroops) paid to callers of `cancel_expired_intent`.
   */
  async keeperReward(): Promise<bigint> {
    const retval = await this.simulateView("keeper_reward", []);
    if (!retval) return 0n;
    return BigInt(scValToNative(retval) as bigint | number | string);
  }

  /**
   * Read `dispatch_keeper_reward()` (in stroops) paid to eligible third-party
   * callers of `dispatch_confirmation`.
   */
  async dispatchKeeperReward(): Promise<bigint> {
    const retval = await this.simulateView("dispatch_keeper_reward", []);
    if (!retval) return 0n;
    return BigInt(scValToNative(retval) as bigint | number | string);
  }

  /**
   * Quote the LayerZero native fee (in stroops) required to dispatch a
   * 35-byte `CancelIntent` message to `dstEid` via `quote_cancel_fee(dst_eid)`.
   */
  async quoteCancelFee(dstEid: number): Promise<bigint> {
    const retval = await this.simulateView("quote_cancel_fee", [
      nativeToScVal(dstEid, { type: "u32" }),
    ]);
    if (!retval) {
      throw new Error(`quote_cancel_fee returned no value for dstEid ${dstEid}`);
    }
    return BigInt(scValToNative(retval) as bigint | number | string);
  }

  /**
   * Quote the LayerZero native fee (in stroops) required to dispatch a
   * 90-byte `FillConfirmed` message to `dstEid` via `quote_fill_confirmed_fee(dst_eid)`.
   */
  async quoteFillConfirmedFee(dstEid: number): Promise<bigint> {
    const retval = await this.simulateView("quote_fill_confirmed_fee", [
      nativeToScVal(dstEid, { type: "u32" }),
    ]);
    if (!retval) {
      throw new Error(`quote_fill_confirmed_fee returned no value for dstEid ${dstEid}`);
    }
    return BigInt(scValToNative(retval) as bigint | number | string);
  }

  /**
   * Quote the current Soroban inclusion fee bid (in stroops) according to the
   * configured {@link InclusionFeePolicy}.
   */
  async estimateInclusionFeeStroops(): Promise<bigint> {
    const fee = await quoteInclusionFee(this.rpc, this.inclusionFee, this.logger);
    return BigInt(fee);
  }

  /**
   * Query the settlement contract's native token (XLM) reserve balance in stroops.
   * Returns `undefined` if the balance cannot be queried.
   */
  async getContractReserveStroops(): Promise<bigint | undefined> {
    try {
      const tokenContractId =
        this.nativeTokenContractId ?? Asset.native().contractId(this.networkPassphrase);
      const account = await this.getReadAccount();
      const contract = new Contract(tokenContractId);
      const tx = new TransactionBuilder(account, {
        fee: "100",
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(
          contract.call("balance", new StellarSdkAddress(this.settlementContractId).toScVal()),
        )
        .setTimeout(this.timeoutSeconds)
        .build();

      const simulated = await this.rpc.simulateTransaction(tx);
      if (!SorobanRpc.Api.isSimulationSuccess(simulated) || !simulated.result) {
        return undefined;
      }
      return BigInt(scValToNative(simulated.result.retval) as bigint | number | string);
    } catch {
      return undefined;
    }
  }

  /**
   * Filter `intentHashes` down to those currently in `Filled` status (where
   * `Settled` is present and `ConfirmationSent` is absent) by calling
   * `list_undispatched_intents` on the settlement contract.
   *
   * Automatically batches inputs into chunks of {@link MAX_LIST_BATCH} (100)
   * so large backlogs never revert with `BatchTooLarge` (issue #1075).
   */
  async listUndispatchedIntents(intentHashes: readonly Hex[]): Promise<Hex[]> {
    if (intentHashes.length === 0) return [];

    const undispatched: Hex[] = [];
    for (let i = 0; i < intentHashes.length; i += MAX_LIST_BATCH) {
      const chunk = intentHashes.slice(i, i + MAX_LIST_BATCH);
      const vecScVal = xdr.ScVal.scvVec(chunk.map((h) => this.intentHashScVal(h)));
      const retval = await this.simulateView("list_undispatched_intents", [vecScVal]);
      if (!retval) continue;
      const native: unknown = scValToNative(retval);
      if (Array.isArray(native)) {
        for (const item of native) {
          const hex = coerceBytes32Hex(item);
          if (hex) undispatched.push(hex);
        }
      }
    }
    return undispatched;
  }

  /**
   * Scan Soroban settlement contract events (`registered`, `filled`,
   * `confirmation_sent`, `cancelled`, `cancelled_inbound`,
   * `cancelled_before_registration`) from `fromLedger` through `toLedger`
   * (or the latest ledger).
   */
  async scanIntentEvents(
    fromLedger: number,
    toLedger?: number,
  ): Promise<SorobanIntentEventScanResult> {
    const latest = await this.rpc.getLatestLedger();
    const latestLedger = latest.sequence;
    const latestLedgerTimestamp = extractLedgerTimestamp(latest);
    const effectiveEndLedger =
      toLedger !== undefined ? Math.min(toLedger, latestLedger) : latestLedger;

    const events: SorobanIntentEvent[] = [];
    const registered: SorobanIntentEventScanResult["registered"] = [];
    const filled: SorobanIntentEventScanResult["filled"] = [];
    const confirmationSent: Hex[] = [];
    const cancelled: Hex[] = [];

    if (fromLedger <= 0 || fromLedger > effectiveEndLedger) {
      return {
        events,
        registered,
        filled,
        confirmationSent,
        cancelled,
        latestLedger,
        ...(latestLedgerTimestamp !== undefined ? { latestLedgerTimestamp } : {}),
        nextLedger: latestLedger + 1,
      };
    }

    const requestParams: Parameters<SorobanRpc.Server["getEvents"]>[0] = {
      startLedger: fromLedger,
      filters: [
        {
          type: "contract",
          contractIds: [this.settlementContractId],
        },
      ],
      limit: 200,
    };

    const response = await this.rpc.getEvents(requestParams);
    const rawEvents = response.events ?? [];

    for (const rawEvent of rawEvents) {
      if (rawEvent.ledger < fromLedger || rawEvent.ledger > effectiveEndLedger) {
        continue;
      }
      const decoded = decodeSettlementEvent(rawEvent);
      if (!decoded) continue;

      events.push(decoded);
      switch (decoded.type) {
        case "registered":
          registered.push({
            intentHash: decoded.intentHash,
            srcEid: decoded.srcEid ?? 0,
            deadline: decoded.deadline ?? 0n,
            ledger: decoded.ledger,
            ...(decoded.txHash ? { txHash: decoded.txHash } : {}),
          });
          break;
        case "filled":
          filled.push({
            intentHash: decoded.intentHash,
            solver: decoded.solver ?? "",
            destAsset: decoded.destAsset ?? "",
            fillAmount: decoded.fillAmount ?? 0n,
            srcEid: decoded.srcEid ?? 0,
            ledger: decoded.ledger,
            ...(decoded.txHash ? { txHash: decoded.txHash } : {}),
          });
          break;
        case "confirmation_sent":
          confirmationSent.push(decoded.intentHash);
          break;
        case "cancelled":
        case "cancelled_inbound":
        case "cancelled_before_registration":
          cancelled.push(decoded.intentHash);
          break;
      }
    }

    return {
      events,
      registered,
      filled,
      confirmationSent,
      cancelled,
      latestLedger,
      ...(latestLedgerTimestamp !== undefined ? { latestLedgerTimestamp } : {}),
      nextLedger: effectiveEndLedger + 1,
    };
  }

  /**
   * Cancel an expired intent on Soroban via `cancel_expired_intent(caller, intent_hash, lz_fee)`.
   *
   * When `lzFeeStroops` is omitted, fetches the intent's `srcEid`, quotes
   * `quote_cancel_fee(srcEid)`, and adds the configured `lzFeeBufferStroops`.
   * Restores archived persistent entries if needed and submits with inclusion
   * fee escalation.
   */
  async cancelExpiredIntent(
    intentHash: Hex,
    lzFeeStroops?: bigint,
  ): Promise<SorobanKeeperTxResult> {
    const keypair = this.requireSigner();
    const resolvedLzFee = lzFeeStroops ?? (await this.resolveCancelFeeForIntent(intentHash));

    const args = [
      new StellarSdkAddress(keypair.publicKey()).toScVal(),
      this.intentHashScVal(intentHash),
      nativeToScVal(resolvedLzFee, { type: "i128" }),
    ];

    return this.invokeWrite("cancel_expired_intent", intentHash, resolvedLzFee, args);
  }

  /**
   * Dispatch a `FillConfirmed` message for a filled-but-undispatched intent on
   * Soroban via `dispatch_confirmation(caller, intent_hash, lz_fee)`.
   *
   * When `lzFeeStroops` is omitted, fetches the intent's `srcEid`, quotes
   * `quote_fill_confirmed_fee(srcEid)`, and adds the configured `lzFeeBufferStroops`.
   * Restores archived persistent entries if needed and submits with inclusion
   * fee escalation.
   */
  async dispatchConfirmation(
    intentHash: Hex,
    lzFeeStroops?: bigint,
  ): Promise<SorobanKeeperTxResult> {
    const keypair = this.requireSigner();
    const resolvedLzFee = lzFeeStroops ?? (await this.resolveFillConfirmedFeeForIntent(intentHash));

    const args = [
      new StellarSdkAddress(keypair.publicKey()).toScVal(),
      this.intentHashScVal(intentHash),
      nativeToScVal(resolvedLzFee, { type: "i128" }),
    ];

    return this.invokeWrite("dispatch_confirmation", intentHash, resolvedLzFee, args);
  }

  // -------------------------------------------------------------------------
  // Internal Helpers
  // -------------------------------------------------------------------------

  private requireSigner(): Keypair {
    if (!this.signerKeypair) {
      throw new Error(
        "PerihelionSettlementClient requires signerSecret for state-mutating operations",
      );
    }
    return this.signerKeypair;
  }

  private async resolveCancelFeeForIntent(intentHash: Hex): Promise<bigint> {
    const record = await this.getIntent(intentHash);
    if (!record) {
      throw new Error(`Intent ${intentHash} not found on Soroban settlement contract`);
    }
    const quoted = await this.quoteCancelFee(record.srcEid);
    return quoted + this.lzFeeBufferStroops;
  }

  private async resolveFillConfirmedFeeForIntent(intentHash: Hex): Promise<bigint> {
    const record = await this.getIntent(intentHash);
    if (!record) {
      throw new Error(`Intent ${intentHash} not found on Soroban settlement contract`);
    }
    const quoted = await this.quoteFillConfirmedFee(record.srcEid);
    return quoted + this.lzFeeBufferStroops;
  }

  private async getReadAccount(): Promise<Account> {
    const pubKey = this.readKeypair.publicKey();
    try {
      return await this.rpc.getAccount(pubKey);
    } catch {
      return new Account(pubKey, "0");
    }
  }

  private async simulateView(method: string, args: xdr.ScVal[]): Promise<xdr.ScVal | undefined> {
    const contract = new Contract(this.settlementContractId);
    const account = await this.getReadAccount();
    const tx = new TransactionBuilder(account, {
      fee: "100",
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(contract.call(method, ...args))
      .setTimeout(this.timeoutSeconds)
      .build();

    const simulated = await this.rpc.simulateTransaction(tx);
    if (SorobanRpc.Api.isSimulationError(simulated)) {
      throw new Error(`${method} simulation failed: ${simulated.error}`);
    }
    if (!SorobanRpc.Api.isSimulationSuccess(simulated) || !simulated.result) {
      return undefined;
    }
    return simulated.result.retval;
  }

  private async invokeWrite(
    method: string,
    intentHash: Hex,
    lzFeeStroops: bigint,
    args: xdr.ScVal[],
  ): Promise<SorobanKeeperTxResult> {
    const keypair = this.requireSigner();
    const contract = new Contract(this.settlementContractId);

    // 1. Check if footprint restoration is needed before reading the sequence number.
    const preAccount = await this.rpc.getAccount(keypair.publicKey());
    const preTx = this.buildInvocationTx(preAccount, contract, method, args, 100);
    const preSim = await this.rpc.simulateTransaction(preTx);
    if (SorobanRpc.Api.isSimulationRestore(preSim)) {
      await this.restoreFootprint(keypair, preSim.restorePreamble);
    }

    // 2. Read the signer account sequence once for fee-escalating submission.
    const account = await this.rpc.getAccount(keypair.publicKey());

    const landed = await submitWithFeeEscalation({
      rpc: this.rpc,
      signerPublicKey: keypair.publicKey(),
      sequence: account.sequenceNumber(),
      policy: this.inclusionFee,
      submitOptions: this.submitOptions,
      logger: this.logger,
      prepare: async (attemptAccount, inclusionFeeStroops) => {
        const tx = this.buildInvocationTx(
          attemptAccount,
          contract,
          method,
          args,
          inclusionFeeStroops,
        );
        const simulated = await this.rpc.simulateTransaction(tx);
        if (!SorobanRpc.Api.isSimulationSuccess(simulated)) {
          const errMsg = SorobanRpc.Api.isSimulationError(simulated)
            ? simulated.error
            : "simulation did not succeed";
          throw new Error(`${method} simulation failed: ${String(errMsg)}`);
        }
        return SorobanRpc.assembleTransaction(tx, simulated).build();
      },
      sign: (transaction) => transaction.sign(keypair),
    });

    return {
      txHash: landed.hash,
      intentHash,
      lzFeeStroops,
      inclusionFeeStroops: landed.inclusionFeeStroops,
      feeChargedStroops: landed.feeChargedStroops,
      attempts: landed.attempts,
    };
  }

  private buildInvocationTx(
    account: Account,
    contract: Contract,
    method: string,
    args: xdr.ScVal[],
    inclusionFeeStroops: number,
  ): Transaction {
    return new TransactionBuilder(account, {
      fee: String(inclusionFeeStroops),
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(contract.call(method, ...args))
      .setTimeout(this.timeoutSeconds)
      .build();
  }

  private async restoreFootprint(
    keypair: Keypair,
    preamble: SorobanRpc.Api.SimulateTransactionRestoreResponse["restorePreamble"],
  ): Promise<void> {
    const account = await this.rpc.getAccount(keypair.publicKey());
    const transaction = new TransactionBuilder(account, {
      fee: preamble.minResourceFee,
      networkPassphrase: this.networkPassphrase,
    })
      .setSorobanData(preamble.transactionData.build())
      .addOperation(Operation.restoreFootprint({}))
      .setTimeout(this.timeoutSeconds)
      .build();

    transaction.sign(keypair);
    await submitAndWait(this.rpc, transaction, this.submitOptions);
  }

  private intentHashScVal(intentHash: Hex): xdr.ScVal {
    if (!/^0x[0-9a-fA-F]{64}$/.test(intentHash)) {
      throw new Error(`Invalid intent hash: expected 32-byte 0x-prefixed hex, got "${intentHash}"`);
    }
    return nativeToScVal(Buffer.from(intentHash.slice(2), "hex"), { type: "bytes" });
  }
}

// ---------------------------------------------------------------------------
// Decoding Helpers
// ---------------------------------------------------------------------------

function coerceBytes32Hex(value: unknown): Hex | undefined {
  if (typeof value === "string") {
    const clean = value.startsWith("0x") ? value.slice(2) : value;
    if (/^[0-9a-fA-F]{64}$/.test(clean)) {
      return `0x${clean.toLowerCase()}`;
    }
    return undefined;
  }
  if (value instanceof Uint8Array || Buffer.isBuffer(value)) {
    if (value.length === 32) {
      return `0x${Buffer.from(value).toString("hex").toLowerCase()}`;
    }
  }
  return undefined;
}

function coerceStringAddress(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value.length > 0 ? value : undefined;
  if (value instanceof StellarSdkAddress) return value.toString();
  if (typeof value === "object" && "toString" in value) {
    const fn = (value as { toString?: unknown }).toString;
    if (typeof fn === "function") {
      const s = String((fn as () => unknown).call(value));
      return s && s !== "[object Object]" ? s : undefined;
    }
  }
  return undefined;
}

/**
 * Decode a native value returned by `scValToNative` for `get_intent` into a
 * typed {@link SorobanIntentRecord}.
 */
export function decodeSorobanIntentRecord(
  native: unknown,
  fallbackHash?: Hex,
): SorobanIntentRecord | undefined {
  if (!native || typeof native !== "object") return undefined;
  const rec = native as Record<string, unknown>;

  const intentHash = coerceBytes32Hex(rec.intent_hash ?? rec.intentHash) ?? fallbackHash;
  if (!intentHash) return undefined;

  const srcEidRaw = rec.src_eid ?? rec.srcEid;
  const deadlineRaw = rec.deadline;
  if (srcEidRaw === undefined || deadlineRaw === undefined) return undefined;

  const rawStatus = rec.status;
  const status =
    decodeIntentStatus(typeof rawStatus === "bigint" ? Number(rawStatus) : rawStatus) ??
    OnChainIntentStatus.Locked;

  const preferredSolver = coerceStringAddress(rec.preferred_solver ?? rec.preferredSolver);
  const solver = coerceStringAddress(rec.solver);
  const solverEvm = coerceBytes32Hex(rec.solver_evm ?? rec.solverEvm);

  return {
    intentHash,
    srcEid: Number(srcEidRaw),
    recipient: coerceStringAddress(rec.recipient) ?? "",
    destAsset: coerceStringAddress(rec.dest_asset ?? rec.destAsset) ?? "",
    minDestAmount: BigInt(
      (rec.min_dest_amount ?? rec.minDestAmount ?? 0) as bigint | number | string,
    ),
    deadline: BigInt(deadlineRaw as bigint | number | string),
    ...(preferredSolver !== undefined ? { preferredSolver } : {}),
    reservationExpires: BigInt(
      (rec.reservation_expires ?? rec.reservationExpires ?? 0) as bigint | number | string,
    ),
    status,
    ...(solver !== undefined ? { solver } : {}),
    ...(solverEvm !== undefined ? { solverEvm } : {}),
    fillAmount: BigInt((rec.fill_amount ?? rec.fillAmount ?? 0) as bigint | number | string),
    fillLedger: Number(rec.fill_ledger ?? rec.fillLedger ?? 0),
    registeredLedger: Number(rec.registered_ledger ?? rec.registeredLedger ?? 0),
  };
}

function parseScValOrNative(raw: unknown): unknown {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === "string") {
    try {
      const scv = xdr.ScVal.fromXDR(raw, "base64");
      return scValToNative(scv);
    } catch {
      return raw;
    }
  }
  if (typeof raw === "object") {
    if ("xdr" in (raw as Record<string, unknown>)) {
      return parseScValOrNative((raw as { xdr: unknown }).xdr);
    }
    try {
      return scValToNative(raw as xdr.ScVal);
    } catch {
      return raw;
    }
  }
  return raw;
}

const KNOWN_EVENT_TYPES = new Set<SorobanIntentEventType>([
  "registered",
  "filled",
  "confirmation_sent",
  "cancelled",
  "cancelled_inbound",
  "cancelled_before_registration",
]);

function decodeSettlementEvent(
  rawEvent: SorobanRpc.Api.EventResponse,
): SorobanIntentEvent | undefined {
  const topics = (rawEvent.topic ?? []).map((t) => parseScValOrNative(t));
  if (topics.length < 2) return undefined;

  const eventName = typeof topics[0] === "string" ? topics[0] : undefined;
  if (!eventName || !KNOWN_EVENT_TYPES.has(eventName as SorobanIntentEventType)) {
    return undefined;
  }
  const type = eventName as SorobanIntentEventType;
  const intentHash = coerceBytes32Hex(topics[1]);
  if (!intentHash) return undefined;

  const value = parseScValOrNative(rawEvent.value);
  const ledger = Number(rawEvent.ledger);
  const txHash = (rawEvent as { txHash?: string }).txHash;

  if (type === "registered") {
    let srcEid = 0;
    let deadline = 0n;
    if (Array.isArray(value)) {
      srcEid = Number(value[0] ?? 0);
      deadline = BigInt((value[1] ?? 0) as bigint | number | string);
    } else if (value && typeof value === "object") {
      const obj = value as Record<string, unknown>;
      srcEid = Number(obj.src_eid ?? obj.srcEid ?? 0);
      deadline = BigInt((obj.deadline ?? 0) as bigint | number | string);
    }
    return {
      type,
      intentHash,
      ledger,
      ...(txHash ? { txHash } : {}),
      srcEid,
      deadline,
    };
  }

  if (type === "filled") {
    let solver = "";
    let destAsset = "";
    let fillAmount = 0n;
    let srcEid = 0;
    if (Array.isArray(value)) {
      solver = coerceStringAddress(value[0]) ?? "";
      destAsset = coerceStringAddress(value[1]) ?? "";
      fillAmount = BigInt((value[2] ?? 0) as bigint | number | string);
      srcEid = Number(value[3] ?? 0);
    } else if (value && typeof value === "object") {
      const obj = value as Record<string, unknown>;
      solver = coerceStringAddress(obj.solver) ?? "";
      destAsset = coerceStringAddress(obj.dest_asset ?? obj.destAsset) ?? "";
      fillAmount = BigInt((obj.fill_amount ?? obj.fillAmount ?? 0) as bigint | number | string);
      srcEid = Number(obj.src_eid ?? obj.srcEid ?? 0);
    }
    return {
      type,
      intentHash,
      ledger,
      ...(txHash ? { txHash } : {}),
      solver,
      destAsset,
      fillAmount,
      srcEid,
    };
  }

  if (type === "confirmation_sent") {
    let solver: string | undefined;
    let feePaid: bigint | undefined;
    if (Array.isArray(value)) {
      solver = coerceStringAddress(value[0]);
      if (value[1] !== undefined) {
        feePaid = BigInt(value[1] as bigint | number | string);
      }
    } else if (value && typeof value === "object") {
      const obj = value as Record<string, unknown>;
      solver = coerceStringAddress(obj.solver);
      const rawFee = obj.fee_paid ?? obj.feePaid;
      if (rawFee !== undefined) {
        feePaid = BigInt(rawFee as bigint | number | string);
      }
    } else {
      solver = coerceStringAddress(value);
    }
    return {
      type,
      intentHash,
      ledger,
      ...(txHash ? { txHash } : {}),
      ...(solver ? { solver } : {}),
      ...(feePaid !== undefined ? { feePaid } : {}),
    };
  }

  if (type === "cancelled") {
    let srcEid = 0;
    let deadline = 0n;
    let feePaid: bigint | undefined;
    if (Array.isArray(value)) {
      srcEid = Number(value[0] ?? 0);
      deadline = BigInt((value[1] ?? 0) as bigint | number | string);
      if (value[2] !== undefined) {
        feePaid = BigInt(value[2] as bigint | number | string);
      }
    } else if (value && typeof value === "object") {
      const obj = value as Record<string, unknown>;
      srcEid = Number(obj.src_eid ?? obj.srcEid ?? 0);
      deadline = BigInt((obj.deadline ?? 0) as bigint | number | string);
      const rawFee = obj.fee_paid ?? obj.feePaid;
      if (rawFee !== undefined) {
        feePaid = BigInt(rawFee as bigint | number | string);
      }
    }
    return {
      type,
      intentHash,
      ledger,
      ...(txHash ? { txHash } : {}),
      srcEid,
      deadline,
      ...(feePaid !== undefined ? { feePaid } : {}),
    };
  }

  // cancelled_inbound or cancelled_before_registration
  let srcEid = 0;
  if (Array.isArray(value)) {
    srcEid = Number(value[0] ?? 0);
  } else if (typeof value === "number" || typeof value === "bigint") {
    srcEid = Number(value);
  } else if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    srcEid = Number(obj.src_eid ?? obj.srcEid ?? 0);
  }

  return {
    type,
    intentHash,
    ledger,
    ...(txHash ? { txHash } : {}),
    srcEid,
  };
}

function extractLedgerTimestamp(latest: unknown): bigint | undefined {
  if (!latest || typeof latest !== "object") return undefined;
  const obj = latest as Record<string, unknown>;
  const raw = obj.closeTime ?? obj.timestamp ?? obj.closedAt;
  if (typeof raw === "number" || typeof raw === "bigint") return BigInt(raw);
  if (typeof raw === "string" && /^\d+$/.test(raw)) return BigInt(raw);
  return undefined;
}
