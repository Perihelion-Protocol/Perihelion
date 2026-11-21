// SPDX-License-Identifier: MIT

/**
 * Reference Keeper for `cancelExpired` (EVM), `cancel_expired_intent` (Soroban),
 * and `dispatch_confirmation` (Soroban) — issue #1123.
 *
 * Scans both chains for abandoned or stalled intents:
 * 1. EVM `Locked` events past `deadline + confirmationGrace` -> calls `cancelExpired(intentHash)`.
 * 2. Soroban `registered` intents in `Locked` status past `deadline` -> calls `cancel_expired_intent(caller, intent_hash, lz_fee)`.
 * 3. Soroban `Filled` intents (Settled without `ConfirmationSent`) discovered via
 *    `list_undispatched_intents` -> calls `dispatch_confirmation(caller, intent_hash, lz_fee)`.
 *
 * Supports dry-run mode (`keeperDryRun`), Soroban and EVM profitability/cost
 * guards, checkpoint persistence, and Prometheus metrics exposition.
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  type Address,
  type Hex,
  type Log,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  DISPATCH_REWARD_GRACE_LEDGERS,
  ESCROW_ABI,
  OnChainIntentStatus,
  PerihelionClient,
  PerihelionEscrowClient,
  PerihelionSettlementClient,
  dispatchCutoff,
  evaluateEvmCancelCostGuard,
  evaluateSorobanKeeperProfitability,
  type InclusionFeePolicy,
  type MempoolIntentStatus,
  type SorobanIntentEventScanResult,
  type SorobanIntentRecord,
  type SorobanKeeperTxResult,
} from "@perihelion/sdk";
import { BackoffState, FatalError, noopLogger, type Logger } from "@perihelion/node-common";
import type { RelayerConfig } from "./config.js";
import { NoopCheckpointStore, type CheckpointStore } from "./checkpoint.js";

// ---------------------------------------------------------------------------
// Metrics & Readiness Types
// ---------------------------------------------------------------------------

/** Counters and cumulative fee/reward totals tracked by the keeper. */
export interface KeeperMetrics {
  ticksTotal: number;
  evmScansTotal: number;
  sorobanScansTotal: number;
  evmCancelledTotal: number;
  sorobanCancelledTotal: number;
  confirmationsDispatchedTotal: number;
  dryRunActionsTotal: number;
  skippedUnprofitableTotal: number;
  skippedAwaitingGraceTotal: number;
  skippedExpiredWindowTotal: number;
  failedActionsTotal: number;
  evmGasSpentWei: bigint;
  sorobanFeesSpentStroops: bigint;
  sorobanRewardsEarnedStroops: bigint;
}

/** Readiness snapshot for the keeper daemon. */
export interface KeeperReadinessState {
  lastTickOk: boolean;
  lastTickAt: number;
  evmCursor: number;
  evmHead: number;
  sorobanCursor: number;
  sorobanHead: number;
}

/** Outcome of a single keeper action evaluated during a tick. */
export interface KeeperActionRecord {
  readonly chain: "evm" | "soroban";
  readonly action: "cancelExpired" | "cancel_expired_intent" | "dispatch_confirmation";
  readonly intentHash: Hex;
  readonly status: "executed" | "dry_run" | "skipped" | "failed";
  readonly txHash?: string;
  readonly reason?: string;
  readonly gasCostWei?: bigint;
  readonly feePaidStroops?: bigint;
  readonly rewardEarnedStroops?: bigint;
}

/** Aggregated result returned by {@link Keeper.tick}. */
export interface KeeperTickResult {
  readonly actions: KeeperActionRecord[];
  readonly evmCancelled: Hex[];
  readonly sorobanCancelled: Hex[];
  readonly confirmationsDispatched: Hex[];
  readonly dryRunActions: KeeperActionRecord[];
  readonly skipped: KeeperActionRecord[];
  readonly failed: KeeperActionRecord[];
}

/**
 * Render keeper metrics and readiness state in Prometheus exposition format
 * (`text/plain; version=0.0.4`).
 */
export function renderKeeperPrometheusMetrics(
  metrics: KeeperMetrics,
  readiness: KeeperReadinessState,
): string {
  const lines = [
    "# HELP keeper_ticks_total Total keeper polling ticks executed",
    "# TYPE keeper_ticks_total counter",
    `keeper_ticks_total ${metrics.ticksTotal}`,
    "",
    "# HELP keeper_evm_scans_total Total EVM event scans performed",
    "# TYPE keeper_evm_scans_total counter",
    `keeper_evm_scans_total ${metrics.evmScansTotal}`,
    "",
    "# HELP keeper_soroban_scans_total Total Soroban event scans performed",
    "# TYPE keeper_soroban_scans_total counter",
    `keeper_soroban_scans_total ${metrics.sorobanScansTotal}`,
    "",
    "# HELP keeper_evm_cancelled_total Expired EVM escrow locks refunded via cancelExpired",
    "# TYPE keeper_evm_cancelled_total counter",
    `keeper_evm_cancelled_total ${metrics.evmCancelledTotal}`,
    "",
    "# HELP keeper_soroban_cancelled_total Expired Soroban intents cancelled via cancel_expired_intent",
    "# TYPE keeper_soroban_cancelled_total counter",
    `keeper_soroban_cancelled_total ${metrics.sorobanCancelledTotal}`,
    "",
    "# HELP keeper_confirmations_dispatched_total Stalled FillConfirmed messages dispatched via dispatch_confirmation",
    "# TYPE keeper_confirmations_dispatched_total counter",
    `keeper_confirmations_dispatched_total ${metrics.confirmationsDispatchedTotal}`,
    "",
    "# HELP keeper_dry_run_actions_total Keeper actions evaluated in dry-run mode without submitting transactions",
    "# TYPE keeper_dry_run_actions_total counter",
    `keeper_dry_run_actions_total ${metrics.dryRunActionsTotal}`,
    "",
    "# HELP keeper_skipped_unprofitable_total Keeper actions skipped due to profitability or gas cost guards",
    "# TYPE keeper_skipped_unprofitable_total counter",
    `keeper_skipped_unprofitable_total ${metrics.skippedUnprofitableTotal}`,
    "",
    "# HELP keeper_skipped_awaiting_grace_total Stalled confirmations deferred until DISPATCH_REWARD_GRACE_LEDGERS elapses",
    "# TYPE keeper_skipped_awaiting_grace_total counter",
    `keeper_skipped_awaiting_grace_total ${metrics.skippedAwaitingGraceTotal}`,
    "",
    "# HELP keeper_skipped_expired_window_total Undispatched fills skipped because dispatch_cutoff has passed",
    "# TYPE keeper_skipped_expired_window_total counter",
    `keeper_skipped_expired_window_total ${metrics.skippedExpiredWindowTotal}`,
    "",
    "# HELP keeper_failed_actions_total Keeper actions that threw an error during execution",
    "# TYPE keeper_failed_actions_total counter",
    `keeper_failed_actions_total ${metrics.failedActionsTotal}`,
    "",
    "# HELP keeper_evm_gas_spent_wei Cumulative EVM native gas spent by the keeper in wei",
    "# TYPE keeper_evm_gas_spent_wei counter",
    `keeper_evm_gas_spent_wei ${metrics.evmGasSpentWei.toString()}`,
    "",
    "# HELP keeper_soroban_fees_spent_stroops Cumulative Soroban LayerZero and network fees spent in stroops",
    "# TYPE keeper_soroban_fees_spent_stroops counter",
    `keeper_soroban_fees_spent_stroops ${metrics.sorobanFeesSpentStroops.toString()}`,
    "",
    "# HELP keeper_soroban_rewards_earned_stroops Cumulative Soroban keeper rewards earned in stroops",
    "# TYPE keeper_soroban_rewards_earned_stroops counter",
    `keeper_soroban_rewards_earned_stroops ${metrics.sorobanRewardsEarnedStroops.toString()}`,
    "",
    "# HELP keeper_evm_cursor_block Current EVM scan cursor block",
    "# TYPE keeper_evm_cursor_block gauge",
    `keeper_evm_cursor_block ${readiness.evmCursor}`,
    "",
    "# HELP keeper_soroban_cursor_ledger Current Soroban scan cursor ledger",
    "# TYPE keeper_soroban_cursor_ledger gauge",
    `keeper_soroban_cursor_ledger ${readiness.sorobanCursor}`,
    "",
    "# HELP keeper_last_tick_timestamp_seconds Unix timestamp of last successful keeper tick",
    "# TYPE keeper_last_tick_timestamp_seconds gauge",
    `keeper_last_tick_timestamp_seconds ${readiness.lastTickAt > 0 ? Math.floor(readiness.lastTickAt / 1000) : 0}`,
    "",
  ];
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Adapter Interfaces
// ---------------------------------------------------------------------------

/** Event scan output from the EVM escrow contract. */
export interface EvmKeeperScanResult {
  readonly head: number;
  readonly blockTimestamp: bigint;
  readonly confirmationGrace: bigint;
  readonly locked: Array<{
    readonly intentHash: Hex;
    readonly deadline: bigint;
    readonly blockNumber: number;
  }>;
  readonly finalized: Array<{
    readonly intentHash: Hex;
    readonly blockNumber: number;
  }>;
}

/** Injectable adapter for EVM escrow keeper operations. */
export interface EvmKeeperAdapter {
  /** Scan `Locked` and terminal (`Released`, `Refunded`, `RefundedLocalTimeout`) events from `fromBlock`. */
  scanEvents(fromBlock: number): Promise<EvmKeeperScanResult>;
  /** Check on-chain whether `cancelExpired(intentHash)` is currently callable. */
  checkRefundable(intentHash: Hex): Promise<{
    readonly refundable: boolean;
    readonly reason?: string;
    readonly refundableAt?: bigint;
    readonly blockTimestamp?: bigint;
  }>;
  /** Estimate gas and current gas price for `cancelExpired(intentHash)`. */
  estimateCancelGasAndPrice(intentHash: Hex): Promise<{
    readonly gasPriceWei: bigint;
    readonly estimatedGas: bigint;
  }>;
  /** Submit `cancelExpired(intentHash)` and wait for confirmation. */
  cancelExpired(intentHash: Hex): Promise<{
    readonly txHash: Hex;
    readonly gasUsedWei?: bigint;
  }>;
}

/** Injectable adapter for Soroban settlement keeper operations. */
export interface SorobanKeeperAdapter {
  /** Stellar public key (`G...` strkey) of the keeper account. */
  readonly callerPublicKey?: string;
  /** Scan settlement lifecycle events from `fromLedger`. */
  scanEvents(fromLedger: number): Promise<SorobanIntentEventScanResult>;
  /** Query authoritative on-chain status for `intentHash`. */
  status(intentHash: Hex): Promise<OnChainIntentStatus | undefined>;
  /** Fetch the full `IntentRecord` for `intentHash`, if present. */
  getIntent(intentHash: Hex): Promise<SorobanIntentRecord | undefined>;
  /** Batch-filter candidate hashes to those in `Filled` (undispatched) status. */
  listUndispatchedIntents(intentHashes: readonly Hex[]): Promise<Hex[]>;
  /** Read `keeper_reward()` in stroops. */
  keeperReward(): Promise<bigint>;
  /** Read `dispatch_keeper_reward()` in stroops. */
  dispatchKeeperReward(): Promise<bigint>;
  /** Quote LayerZero fee in stroops for `cancel_expired_intent` to `dstEid`. */
  quoteCancelFee(dstEid: number): Promise<bigint>;
  /** Quote LayerZero fee in stroops for `dispatch_confirmation` to `dstEid`. */
  quoteFillConfirmedFee(dstEid: number): Promise<bigint>;
  /** Estimate Soroban network inclusion fee in stroops. */
  estimateInclusionFeeStroops(): Promise<bigint>;
  /** Optional check of the settlement contract's native XLM reserve in stroops. */
  getContractReserveStroops?(): Promise<bigint | undefined>;
  /** Submit `cancel_expired_intent(caller, intent_hash, lz_fee)`. */
  cancelExpiredIntent(intentHash: Hex, lzFeeStroops: bigint): Promise<SorobanKeeperTxResult>;
  /** Submit `dispatch_confirmation(caller, intent_hash, lz_fee)`. */
  dispatchConfirmation(intentHash: Hex, lzFeeStroops: bigint): Promise<SorobanKeeperTxResult>;
}

// ---------------------------------------------------------------------------
// Default Concrete Adapters
// ---------------------------------------------------------------------------

const LOCKED_EVENT = {
  type: "event",
  name: "Locked",
  inputs: [
    { name: "intentHash", type: "bytes32", indexed: true },
    { name: "solver", type: "address", indexed: true },
    { name: "user", type: "address", indexed: true },
    { name: "asset", type: "address", indexed: false },
    { name: "amount", type: "uint256", indexed: false },
    { name: "destination", type: "string", indexed: false },
    { name: "destAsset", type: "string", indexed: false },
    { name: "minDestAmount", type: "uint128", indexed: false },
    { name: "deadline", type: "uint64", indexed: false },
  ],
} as const;

const TERMINAL_EVENTS = [
  {
    type: "event",
    name: "Released",
    inputs: [
      { name: "intentHash", type: "bytes32", indexed: true },
      { name: "solver", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
      { name: "fillAmount", type: "uint128", indexed: false },
      { name: "fillLedger", type: "uint64", indexed: false },
      { name: "minDestAmount", type: "uint128", indexed: false },
    ],
  },
  {
    type: "event",
    name: "Refunded",
    inputs: [
      { name: "intentHash", type: "bytes32", indexed: true },
      { name: "user", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
      { name: "reason", type: "uint8", indexed: false },
    ],
  },
  {
    type: "event",
    name: "RefundedLocalTimeout",
    inputs: [
      { name: "intentHash", type: "bytes32", indexed: true },
      { name: "user", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
] as const;

/** Configuration for {@link ViemEvmKeeperAdapter}. */
export interface ViemEvmKeeperAdapterConfig {
  readonly rpcUrl: string;
  readonly escrowAddress: Address;
  readonly privateKey?: Hex;
  readonly maxBlockRange?: number;
  readonly publicClient?: PublicClient;
  readonly walletClient?: WalletClient;
  readonly logger?: Logger;
}

/**
 * Concrete {@link EvmKeeperAdapter} backed by viem and {@link PerihelionEscrowClient}.
 */
export class ViemEvmKeeperAdapter implements EvmKeeperAdapter {
  private readonly publicClient: PublicClient;
  private readonly walletClient: WalletClient;
  private readonly escrowClient: PerihelionEscrowClient;
  private readonly escrowAddress: Address;
  private readonly logger: Logger;
  private maxBlockRange: number;

  constructor(config: ViemEvmKeeperAdapterConfig) {
    this.escrowAddress = config.escrowAddress;
    this.maxBlockRange = config.maxBlockRange ?? 2000;
    this.logger = config.logger ?? noopLogger;

    const transport = http(config.rpcUrl);
    this.publicClient = config.publicClient ?? createPublicClient({ transport });

    if (config.walletClient) {
      this.walletClient = config.walletClient;
    } else if (config.privateKey) {
      const account = privateKeyToAccount(config.privateKey);
      this.walletClient = createWalletClient({ account, transport });
    } else {
      this.walletClient = createWalletClient({ transport });
    }

    this.escrowClient = new PerihelionEscrowClient(
      this.publicClient,
      this.walletClient,
      this.escrowAddress,
    );
  }

  async scanEvents(fromBlock: number): Promise<EvmKeeperScanResult> {
    const latestBlock = await this.publicClient.getBlock({ blockTag: "latest" });
    const head = Number(latestBlock.number);
    const blockTimestamp = latestBlock.timestamp;
    const confirmationGrace = await this.escrowClient.confirmationGrace();

    const locked: Array<{ intentHash: Hex; deadline: bigint; blockNumber: number }> = [];
    const finalized: Array<{ intentHash: Hex; blockNumber: number }> = [];

    let scanHead = Math.max(0, fromBlock);
    while (scanHead <= head) {
      const toBlock = Math.min(scanHead + this.maxBlockRange - 1, head);
      let lockedLogs: Log[] = [];
      let terminalLogs: Log[] = [];

      try {
        [lockedLogs, terminalLogs] = await Promise.all([
          this.publicClient.getLogs({
            address: this.escrowAddress,
            event: LOCKED_EVENT,
            fromBlock: BigInt(scanHead),
            toBlock: BigInt(toBlock),
          }),
          this.publicClient.getLogs({
            address: this.escrowAddress,
            events: TERMINAL_EVENTS,
            fromBlock: BigInt(scanHead),
            toBlock: BigInt(toBlock),
          }),
        ]);
      } catch (err) {
        if (this.isRangeError(err) && this.maxBlockRange > 1) {
          this.maxBlockRange = Math.max(1, Math.floor(this.maxBlockRange / 2));
          this.logger.warn("ViemEvmKeeperAdapter: halving block range", {
            newMaxBlockRange: this.maxBlockRange,
            err: String(err),
          });
          continue;
        }
        throw err;
      }

      for (const log of lockedLogs) {
        const rawHash =
          (log as { args?: { intentHash?: Hex } }).args?.intentHash ?? log.topics?.[1];
        if (!rawHash || !/^0x[0-9a-fA-F]{64}$/.test(rawHash)) continue;
        const intentHash = rawHash.toLowerCase() as Hex;
        const rawDeadline = (log as { args?: { deadline?: bigint | number } }).args?.deadline;
        let deadline = rawDeadline !== undefined ? BigInt(rawDeadline) : undefined;
        if (deadline === undefined) {
          const lock = await this.escrowClient.getLock(intentHash);
          deadline = lock?.deadline ?? 0n;
        }
        locked.push({
          intentHash,
          deadline,
          blockNumber: Number(log.blockNumber ?? scanHead),
        });
      }

      for (const log of terminalLogs) {
        const rawHash =
          (log as { args?: { intentHash?: Hex } }).args?.intentHash ?? log.topics?.[1];
        if (!rawHash || !/^0x[0-9a-fA-F]{64}$/.test(rawHash)) continue;
        finalized.push({
          intentHash: rawHash.toLowerCase() as Hex,
          blockNumber: Number(log.blockNumber ?? scanHead),
        });
      }

      scanHead = toBlock + 1;
    }

    return {
      head,
      blockTimestamp,
      confirmationGrace,
      locked,
      finalized,
    };
  }

  async checkRefundable(intentHash: Hex): Promise<{
    readonly refundable: boolean;
    readonly reason?: string;
    readonly refundableAt?: bigint;
    readonly blockTimestamp?: bigint;
  }> {
    const status = await this.escrowClient.refundStatus(intentHash);
    return {
      refundable: status.refundable,
      ...(status.reason ? { reason: status.reason } : {}),
      ...(status.refundableAt !== undefined ? { refundableAt: status.refundableAt } : {}),
      blockTimestamp: status.blockTimestamp,
    };
  }

  async estimateCancelGasAndPrice(intentHash: Hex): Promise<{
    readonly gasPriceWei: bigint;
    readonly estimatedGas: bigint;
  }> {
    const gasPriceWei = await this.publicClient.getGasPrice();
    let estimatedGas = 100_000n;
    try {
      estimatedGas = await this.publicClient.estimateContractGas({
        address: this.escrowAddress,
        abi: ESCROW_ABI,
        functionName: "cancelExpired",
        args: [intentHash],
        account: this.walletClient.account,
      });
    } catch {
      // Fallback to conservative 100k gas estimate if eth_estimateGas is unsupported.
    }
    return { gasPriceWei, estimatedGas };
  }

  async cancelExpired(intentHash: Hex): Promise<{
    readonly txHash: Hex;
    readonly gasUsedWei?: bigint;
  }> {
    const txHash = await this.escrowClient.cancelExpired(intentHash);
    let gasUsedWei: bigint | undefined;
    try {
      const receipt = await this.publicClient.waitForTransactionReceipt({ hash: txHash });
      if (receipt.gasUsed !== undefined && receipt.effectiveGasPrice !== undefined) {
        gasUsedWei = receipt.gasUsed * receipt.effectiveGasPrice;
      }
    } catch {
      // Receipt wait is best-effort for gas accounting.
    }
    return {
      txHash,
      ...(gasUsedWei !== undefined ? { gasUsedWei } : {}),
    };
  }

  private isRangeError(err: unknown): boolean {
    if (!(err instanceof Error)) return false;
    const msg = err.message.toLowerCase();
    return msg.includes("range") || msg.includes("too large") || msg.includes("limit");
  }
}

/**
 * Concrete {@link SorobanKeeperAdapter} backed by {@link PerihelionSettlementClient}.
 */
export class StellarSorobanKeeperAdapter implements SorobanKeeperAdapter {
  private readonly client: PerihelionSettlementClient;

  constructor(client: PerihelionSettlementClient) {
    this.client = client;
  }

  get callerPublicKey(): string | undefined {
    return this.client.callerPublicKey;
  }

  async scanEvents(fromLedger: number): Promise<SorobanIntentEventScanResult> {
    return this.client.scanIntentEvents(fromLedger);
  }

  async status(intentHash: Hex): Promise<OnChainIntentStatus | undefined> {
    return this.client.status(intentHash);
  }

  async getIntent(intentHash: Hex): Promise<SorobanIntentRecord | undefined> {
    return this.client.getIntent(intentHash);
  }

  async listUndispatchedIntents(intentHashes: readonly Hex[]): Promise<Hex[]> {
    return this.client.listUndispatchedIntents(intentHashes);
  }

  async keeperReward(): Promise<bigint> {
    return this.client.keeperReward();
  }

  async dispatchKeeperReward(): Promise<bigint> {
    return this.client.dispatchKeeperReward();
  }

  async quoteCancelFee(dstEid: number): Promise<bigint> {
    return this.client.quoteCancelFee(dstEid);
  }

  async quoteFillConfirmedFee(dstEid: number): Promise<bigint> {
    return this.client.quoteFillConfirmedFee(dstEid);
  }

  async estimateInclusionFeeStroops(): Promise<bigint> {
    return this.client.estimateInclusionFeeStroops();
  }

  async getContractReserveStroops(): Promise<bigint | undefined> {
    return this.client.getContractReserveStroops();
  }

  async cancelExpiredIntent(intentHash: Hex, lzFeeStroops: bigint): Promise<SorobanKeeperTxResult> {
    return this.client.cancelExpiredIntent(intentHash, lzFeeStroops);
  }

  async dispatchConfirmation(
    intentHash: Hex,
    lzFeeStroops: bigint,
  ): Promise<SorobanKeeperTxResult> {
    return this.client.dispatchConfirmation(intentHash, lzFeeStroops);
  }
}

// ---------------------------------------------------------------------------
// Keeper Daemon
// ---------------------------------------------------------------------------

/** Options for constructing a {@link Keeper}. */
export interface KeeperOptions {
  readonly config: RelayerConfig;
  readonly evmAdapter?: EvmKeeperAdapter | null;
  readonly sorobanAdapter?: SorobanKeeperAdapter | null;
  readonly evmCheckpoint?: Pick<CheckpointStore, "load" | "save">;
  readonly sorobanCheckpoint?: Pick<CheckpointStore, "load" | "save">;
  readonly startLedger?: number;
  readonly inclusionFee?: InclusionFeePolicy;
  readonly logger?: Logger;
  /** Optional clock override returning current unix timestamp in seconds. */
  readonly nowSeconds?: () => bigint;
}

interface TrackedEvmLock {
  readonly intentHash: Hex;
  readonly deadline: bigint;
  readonly blockNumber: number;
}

interface TrackedSorobanIntent {
  readonly intentHash: Hex;
  readonly srcEid: number;
  readonly deadline: bigint;
}

/**
 * Reference Keeper daemon for `cancelExpired` (EVM), `cancel_expired_intent`
 * (Soroban), and `dispatch_confirmation` (Soroban).
 */
export class Keeper {
  private running = false;
  private abortSleep: (() => void) | null = null;
  private evmCursor: number;
  private sorobanCursor: number;
  private readonly startBlock: number;
  private readonly startLedger: number;
  private readonly config: RelayerConfig;
  private readonly evmAdapter: EvmKeeperAdapter | null;
  private readonly sorobanAdapter: SorobanKeeperAdapter | null;
  private readonly evmCheckpoint: Pick<CheckpointStore, "load" | "save">;
  private readonly sorobanCheckpoint: Pick<CheckpointStore, "load" | "save">;
  private readonly log: Logger;
  private readonly backoff: BackoffState;
  private readonly nowSeconds: () => bigint;
  private readonly mempoolClient: PerihelionClient | null;

  private readonly trackedEvmLocks = new Map<Hex, TrackedEvmLock>();
  private readonly trackedSorobanIntents = new Map<Hex, TrackedSorobanIntent>();
  private readonly candidateFilledIntents = new Set<Hex>();

  readonly metrics: KeeperMetrics = {
    ticksTotal: 0,
    evmScansTotal: 0,
    sorobanScansTotal: 0,
    evmCancelledTotal: 0,
    sorobanCancelledTotal: 0,
    confirmationsDispatchedTotal: 0,
    dryRunActionsTotal: 0,
    skippedUnprofitableTotal: 0,
    skippedAwaitingGraceTotal: 0,
    skippedExpiredWindowTotal: 0,
    failedActionsTotal: 0,
    evmGasSpentWei: 0n,
    sorobanFeesSpentStroops: 0n,
    sorobanRewardsEarnedStroops: 0n,
  };

  readonly readiness: KeeperReadinessState = {
    lastTickOk: false,
    lastTickAt: 0,
    evmCursor: 0,
    evmHead: 0,
    sorobanCursor: 1,
    sorobanHead: 0,
  };

  constructor(opts: KeeperOptions) {
    this.config = opts.config;
    this.log = opts.logger ?? noopLogger;
    this.startBlock = opts.config.startBlock ?? 0;
    this.startLedger = opts.startLedger ?? 1;
    this.evmCursor = this.startBlock;
    this.sorobanCursor = this.startLedger;
    this.readiness.evmCursor = this.evmCursor;
    this.readiness.sorobanCursor = this.sorobanCursor;
    this.evmCheckpoint = opts.evmCheckpoint ?? new NoopCheckpointStore();
    this.sorobanCheckpoint = opts.sorobanCheckpoint ?? new NoopCheckpointStore();
    this.backoff = new BackoffState(opts.config);
    this.nowSeconds = opts.nowSeconds ?? (() => BigInt(Math.floor(Date.now() / 1000)));

    if (opts.evmAdapter !== undefined) {
      this.evmAdapter = opts.evmAdapter;
    } else if (opts.config.evmPrivateKey || opts.config.keeperDryRun) {
      this.evmAdapter = new ViemEvmKeeperAdapter({
        rpcUrl: opts.config.evmRpcUrl,
        escrowAddress: opts.config.escrowAddress as Address,
        ...(opts.config.evmPrivateKey ? { privateKey: opts.config.evmPrivateKey as Hex } : {}),
        logger: this.log,
      });
    } else {
      this.evmAdapter = null;
    }

    if (opts.sorobanAdapter !== undefined) {
      this.sorobanAdapter = opts.sorobanAdapter;
    } else {
      const settlementClient = new PerihelionSettlementClient({
        rpcUrl: opts.config.stellarRpcUrl,
        networkPassphrase: opts.config.stellarNetwork,
        settlementContractId: opts.config.settlementContractId,
        signerSecret: opts.config.signerSecret,
        lzFeeBufferStroops: opts.config.keeperLzFeeBufferStroops ?? 0n,
        timeoutSeconds: opts.config.txTimeoutSeconds,
        inclusionFee: opts.inclusionFee,
        logger: this.log,
      });
      this.sorobanAdapter = new StellarSorobanKeeperAdapter(settlementClient);
    }

    this.mempoolClient =
      opts.config.mempoolUrl && opts.config.mempoolStatusToken
        ? new PerihelionClient({ mempoolUrl: opts.config.mempoolUrl })
        : null;
  }

  /** Manually seed an EVM lock candidate for monitoring. */
  trackEvmLock(lock: { intentHash: Hex; deadline: bigint; blockNumber?: number }): void {
    const hash = lock.intentHash.toLowerCase() as Hex;
    this.trackedEvmLocks.set(hash, {
      intentHash: hash,
      deadline: lock.deadline,
      blockNumber: lock.blockNumber ?? 0,
    });
  }

  /** Manually seed a Soroban registered intent candidate for expiry monitoring. */
  trackSorobanIntent(intent: { intentHash: Hex; srcEid: number; deadline: bigint }): void {
    const hash = intent.intentHash.toLowerCase() as Hex;
    this.trackedSorobanIntents.set(hash, {
      intentHash: hash,
      srcEid: intent.srcEid,
      deadline: intent.deadline,
    });
  }

  /** Manually seed a Soroban filled intent candidate for confirmation recovery. */
  trackFilledIntent(intentHash: Hex): void {
    this.candidateFilledIntents.add(intentHash.toLowerCase() as Hex);
  }

  /** Resume EVM and Soroban cursors from their checkpoint stores. */
  async resume(): Promise<void> {
    this.evmCursor = (await this.evmCheckpoint.load()) ?? this.startBlock;
    this.sorobanCursor = (await this.sorobanCheckpoint.load()) ?? this.startLedger;
    this.readiness.evmCursor = this.evmCursor;
    this.readiness.sorobanCursor = this.sorobanCursor;
  }

  /** Start the keeper polling loop. Resolves when {@link stop} is called. */
  async start(): Promise<void> {
    await this.resume();
    this.running = true;
    this.log.info("keeper started", {
      escrow: this.config.escrowAddress,
      settlement: this.config.settlementContractId,
      dryRun: Boolean(this.config.keeperDryRun),
      enforceProfitability: this.config.keeperEnforceProfitability ?? true,
      evmCursor: this.evmCursor,
      sorobanCursor: this.sorobanCursor,
    });

    while (this.running) {
      try {
        await this.tick();
        this.backoff.recordSuccess();
        this.readiness.lastTickOk = true;
        this.readiness.lastTickAt = Date.now();
      } catch (err) {
        if (err instanceof FatalError) {
          this.log.error("fatal error, keeper stopping", { err: String(err) });
          throw err;
        }
        this.backoff.recordFailure();
        this.readiness.lastTickOk = false;
        this.log.error("keeper tick failed", {
          err: String(err),
          consecutiveFailures: this.backoff.consecutiveFailures,
        });
      }

      if (this.running) {
        await this.interruptibleSleep(this.backoff.nextDelay());
      }
    }
  }

  /** Stop the keeper loop after the current tick completes. */
  stop(): void {
    this.running = false;
    this.abortSleep?.();
    this.abortSleep = null;
  }

  /** Render Prometheus metrics for this keeper instance. */
  renderPrometheusMetrics(): string {
    return renderKeeperPrometheusMetrics(this.metrics, this.readiness);
  }

  /** Execute a single keeper scan-and-act cycle across EVM and Soroban. */
  async tick(): Promise<KeeperTickResult> {
    this.metrics.ticksTotal += 1;

    const actions: KeeperActionRecord[] = [];
    const evmCancelled: Hex[] = [];
    const sorobanCancelled: Hex[] = [];
    const confirmationsDispatched: Hex[] = [];
    const dryRunActions: KeeperActionRecord[] = [];
    const skipped: KeeperActionRecord[] = [];
    const failed: KeeperActionRecord[] = [];

    const recordAction = (record: KeeperActionRecord) => {
      actions.push(record);
      if (record.status === "dry_run") dryRunActions.push(record);
      if (record.status === "skipped") skipped.push(record);
      if (record.status === "failed") failed.push(record);
      if (record.status === "executed") {
        if (record.action === "cancelExpired") evmCancelled.push(record.intentHash);
        if (record.action === "cancel_expired_intent") sorobanCancelled.push(record.intentHash);
        if (record.action === "dispatch_confirmation") {
          confirmationsDispatched.push(record.intentHash);
        }
      }
    };

    // -----------------------------------------------------------------------
    // 1. EVM `Locked` Scan & `cancelExpired`
    // -----------------------------------------------------------------------
    if (this.evmAdapter) {
      await this.processEvmLocks(recordAction);
    }

    // -----------------------------------------------------------------------
    // 2. Soroban Event Scan, `cancel_expired_intent`, & `dispatch_confirmation`
    // -----------------------------------------------------------------------
    if (this.sorobanAdapter) {
      await this.processSorobanIntents(recordAction);
    }

    this.readiness.lastTickOk = true;
    this.readiness.lastTickAt = Date.now();

    return {
      actions,
      evmCancelled,
      sorobanCancelled,
      confirmationsDispatched,
      dryRunActions,
      skipped,
      failed,
    };
  }

  // -------------------------------------------------------------------------
  // EVM Leg
  // -------------------------------------------------------------------------

  private async processEvmLocks(recordAction: (record: KeeperActionRecord) => void): Promise<void> {
    const adapter = this.evmAdapter!;
    this.metrics.evmScansTotal += 1;

    const scan = await adapter.scanEvents(this.evmCursor);
    this.readiness.evmHead = scan.head;
    const confirmedHead = Math.max(0, scan.head - this.config.confirmations);

    const finalizedSet = new Set<Hex>();
    for (const item of scan.finalized) {
      if (item.blockNumber <= confirmedHead) {
        const hash = item.intentHash.toLowerCase() as Hex;
        finalizedSet.add(hash);
        this.trackedEvmLocks.delete(hash);
      }
    }

    for (const item of scan.locked) {
      if (item.blockNumber <= confirmedHead) {
        const hash = item.intentHash.toLowerCase() as Hex;
        if (!finalizedSet.has(hash)) {
          this.trackedEvmLocks.set(hash, {
            intentHash: hash,
            deadline: item.deadline,
            blockNumber: item.blockNumber,
          });
        }
      }
    }

    if (confirmedHead >= this.evmCursor) {
      this.evmCursor = confirmedHead + 1;
      this.readiness.evmCursor = this.evmCursor;
      await this.evmCheckpoint.save(this.evmCursor);
    }

    const dryRun = Boolean(this.config.keeperDryRun);

    for (const [intentHash, tracked] of [...this.trackedEvmLocks.entries()]) {
      if (tracked.deadline + scan.confirmationGrace > scan.blockTimestamp) {
        continue;
      }

      const status = await adapter.checkRefundable(intentHash);
      if (!status.refundable) {
        if (status.reason === "AlreadyFinalized" || status.reason === "NotLocked") {
          this.trackedEvmLocks.delete(intentHash);
        }
        continue;
      }

      const { gasPriceWei, estimatedGas } = await adapter.estimateCancelGasAndPrice(intentHash);
      const guard = evaluateEvmCancelCostGuard({
        gasPriceWei,
        estimatedGas,
        maxGasPriceWei: this.config.keeperMaxGasPriceWei,
        maxCancelCostWei: this.config.keeperMaxEvmCancelCostWei,
      });

      if (!guard.allowed) {
        this.metrics.skippedUnprofitableTotal += 1;
        this.log.info("skipping EVM cancelExpired due to gas cost guard", {
          intentHash,
          reason: guard.reason,
          gasPriceWei: gasPriceWei.toString(),
          totalCostWei: guard.totalCostWei.toString(),
        });
        recordAction({
          chain: "evm",
          action: "cancelExpired",
          intentHash,
          status: "skipped",
          reason: guard.reason ?? "unprofitable",
          gasCostWei: guard.totalCostWei,
        });
        continue;
      }

      if (dryRun) {
        this.metrics.dryRunActionsTotal += 1;
        this.log.info("dry-run: would call EVM cancelExpired", {
          intentHash,
          estimatedGasCostWei: guard.totalCostWei.toString(),
        });
        recordAction({
          chain: "evm",
          action: "cancelExpired",
          intentHash,
          status: "dry_run",
          reason: "dry_run",
          gasCostWei: guard.totalCostWei,
        });
        continue;
      }

      try {
        const res = await adapter.cancelExpired(intentHash);
        const gasCostWei = res.gasUsedWei ?? guard.totalCostWei;
        this.metrics.evmCancelledTotal += 1;
        this.metrics.evmGasSpentWei += gasCostWei;
        this.trackedEvmLocks.delete(intentHash);

        this.log.info("EVM cancelExpired succeeded", {
          intentHash,
          txHash: res.txHash,
          gasCostWei: gasCostWei.toString(),
        });

        recordAction({
          chain: "evm",
          action: "cancelExpired",
          intentHash,
          status: "executed",
          txHash: res.txHash,
          gasCostWei,
        });

        await this.reportMempoolStatus(intentHash, "refunded");
      } catch (err) {
        this.metrics.failedActionsTotal += 1;
        this.log.warn("EVM cancelExpired failed", {
          intentHash,
          err: String(err),
        });
        recordAction({
          chain: "evm",
          action: "cancelExpired",
          intentHash,
          status: "failed",
          reason: String(err),
        });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Soroban Leg
  // -------------------------------------------------------------------------

  private async processSorobanIntents(
    recordAction: (record: KeeperActionRecord) => void,
  ): Promise<void> {
    const adapter = this.sorobanAdapter!;
    this.metrics.sorobanScansTotal += 1;

    const scan = await adapter.scanEvents(this.sorobanCursor);
    this.readiness.sorobanHead = scan.latestLedger;

    if (scan.nextLedger > this.sorobanCursor) {
      this.sorobanCursor = scan.nextLedger;
      this.readiness.sorobanCursor = this.sorobanCursor;
      await this.sorobanCheckpoint.save(this.sorobanCursor);
    }

    for (const reg of scan.registered) {
      const hash = reg.intentHash.toLowerCase() as Hex;
      this.trackedSorobanIntents.set(hash, {
        intentHash: hash,
        srcEid: reg.srcEid,
        deadline: reg.deadline,
      });
    }

    for (const fill of scan.filled) {
      const hash = fill.intentHash.toLowerCase() as Hex;
      this.trackedSorobanIntents.delete(hash);
      this.candidateFilledIntents.add(hash);
    }

    for (const sent of scan.confirmationSent) {
      const hash = sent.toLowerCase() as Hex;
      this.trackedSorobanIntents.delete(hash);
      this.candidateFilledIntents.delete(hash);
    }

    for (const cancelled of scan.cancelled) {
      const hash = cancelled.toLowerCase() as Hex;
      this.trackedSorobanIntents.delete(hash);
      this.candidateFilledIntents.delete(hash);
    }

    const currentTimestamp = scan.latestLedgerTimestamp ?? this.nowSeconds();
    const dryRun = Boolean(this.config.keeperDryRun);
    const enforceProfitability = this.config.keeperEnforceProfitability ?? true;
    const minProfitStroops = this.config.keeperMinProfitStroops ?? 0n;
    const lzFeeBufferStroops = this.config.keeperLzFeeBufferStroops ?? 0n;

    // -----------------------------------------------------------------------
    // 2a. Expired Soroban `Locked` intents -> `cancel_expired_intent`
    // -----------------------------------------------------------------------
    for (const [intentHash, tracked] of [...this.trackedSorobanIntents.entries()]) {
      if (currentTimestamp < tracked.deadline) {
        continue;
      }

      const onChainStatus = await adapter.status(intentHash);
      if (onChainStatus === OnChainIntentStatus.Filled) {
        this.trackedSorobanIntents.delete(intentHash);
        this.candidateFilledIntents.add(intentHash);
        continue;
      }
      if (onChainStatus !== OnChainIntentStatus.Locked) {
        this.trackedSorobanIntents.delete(intentHash);
        continue;
      }

      const [quotedFee, rewardStroops, inclusionFeeStroops, contractReserveStroops] =
        await Promise.all([
          adapter.quoteCancelFee(tracked.srcEid),
          adapter.keeperReward(),
          adapter.estimateInclusionFeeStroops(),
          adapter.getContractReserveStroops
            ? adapter.getContractReserveStroops()
            : Promise.resolve(undefined),
        ]);

      const lzFeeStroops = quotedFee + lzFeeBufferStroops;
      const decision = evaluateSorobanKeeperProfitability({
        rewardStroops,
        lzFeeStroops,
        inclusionFeeStroops,
        minNetProfitStroops: minProfitStroops,
        contractReserveStroops,
        rewardEligible: true,
      });

      if (enforceProfitability && !decision.profitable) {
        this.metrics.skippedUnprofitableTotal += 1;
        this.log.info("skipping Soroban cancel_expired_intent due to profitability guard", {
          intentHash,
          reason: decision.reason,
          rewardStroops: rewardStroops.toString(),
          totalCostStroops: decision.totalCostStroops.toString(),
          netProfitStroops: decision.netProfitStroops.toString(),
        });
        recordAction({
          chain: "soroban",
          action: "cancel_expired_intent",
          intentHash,
          status: "skipped",
          reason: decision.reason ?? "unprofitable",
          feePaidStroops: decision.totalCostStroops,
          rewardEarnedStroops: decision.effectiveRewardStroops,
        });
        continue;
      }

      if (dryRun) {
        this.metrics.dryRunActionsTotal += 1;
        this.log.info("dry-run: would call Soroban cancel_expired_intent", {
          intentHash,
          lzFeeStroops: lzFeeStroops.toString(),
          rewardStroops: decision.effectiveRewardStroops.toString(),
        });
        recordAction({
          chain: "soroban",
          action: "cancel_expired_intent",
          intentHash,
          status: "dry_run",
          reason: "dry_run",
          feePaidStroops: decision.totalCostStroops,
          rewardEarnedStroops: decision.effectiveRewardStroops,
        });
        continue;
      }

      try {
        const tx = await adapter.cancelExpiredIntent(intentHash, lzFeeStroops);
        const feePaidStroops = lzFeeStroops + tx.feeChargedStroops;
        this.metrics.sorobanCancelledTotal += 1;
        this.metrics.sorobanFeesSpentStroops += feePaidStroops;
        this.metrics.sorobanRewardsEarnedStroops += decision.effectiveRewardStroops;
        this.trackedSorobanIntents.delete(intentHash);

        this.log.info("Soroban cancel_expired_intent succeeded", {
          intentHash,
          txHash: tx.txHash,
          feePaidStroops: feePaidStroops.toString(),
          rewardEarnedStroops: decision.effectiveRewardStroops.toString(),
        });

        recordAction({
          chain: "soroban",
          action: "cancel_expired_intent",
          intentHash,
          status: "executed",
          txHash: tx.txHash,
          feePaidStroops,
          rewardEarnedStroops: decision.effectiveRewardStroops,
        });
      } catch (err) {
        this.metrics.failedActionsTotal += 1;
        this.log.warn("Soroban cancel_expired_intent failed", {
          intentHash,
          err: String(err),
        });
        recordAction({
          chain: "soroban",
          action: "cancel_expired_intent",
          intentHash,
          status: "failed",
          reason: String(err),
        });
      }
    }

    // -----------------------------------------------------------------------
    // 2b. Undispatched Soroban `Filled` intents -> `dispatch_confirmation`
    // -----------------------------------------------------------------------
    const candidatePool = new Set<Hex>([
      ...this.candidateFilledIntents,
      ...this.trackedSorobanIntents.keys(),
    ]);
    if (candidatePool.size === 0) return;

    const undispatched = await adapter.listUndispatchedIntents([...candidatePool]);
    const undispatchedSet = new Set(undispatched.map((h) => h.toLowerCase() as Hex));

    // Any candidate that was in `candidateFilledIntents` and is no longer returned by
    // `list_undispatched_intents` has already been dispatched.
    for (const existing of [...this.candidateFilledIntents]) {
      if (!undispatchedSet.has(existing)) {
        this.candidateFilledIntents.delete(existing);
      }
    }

    for (const rawHash of undispatched) {
      const intentHash = rawHash.toLowerCase() as Hex;
      this.trackedSorobanIntents.delete(intentHash);
      this.candidateFilledIntents.add(intentHash);

      const record = await adapter.getIntent(intentHash);
      if (!record) {
        this.candidateFilledIntents.delete(intentHash);
        continue;
      }

      const cutoff = dispatchCutoff(record.deadline);
      if (currentTimestamp > cutoff) {
        this.metrics.skippedExpiredWindowTotal += 1;
        this.candidateFilledIntents.delete(intentHash);
        this.log.info("skipping Soroban dispatch_confirmation: past dispatch_cutoff", {
          intentHash,
          currentTimestamp: currentTimestamp.toString(),
          dispatchCutoff: cutoff.toString(),
        });
        recordAction({
          chain: "soroban",
          action: "dispatch_confirmation",
          intentHash,
          status: "skipped",
          reason: "dispatch_window_expired",
        });
        continue;
      }

      const caller = adapter.callerPublicKey;
      const isThirdParty = !caller || !record.solver || caller !== record.solver;
      const ledgersElapsed = Math.max(0, scan.latestLedger - record.fillLedger);
      const rewardEligible = isThirdParty && ledgersElapsed >= DISPATCH_REWARD_GRACE_LEDGERS;

      const [quotedFee, rewardStroops, inclusionFeeStroops, contractReserveStroops] =
        await Promise.all([
          adapter.quoteFillConfirmedFee(record.srcEid),
          adapter.dispatchKeeperReward(),
          adapter.estimateInclusionFeeStroops(),
          adapter.getContractReserveStroops
            ? adapter.getContractReserveStroops()
            : Promise.resolve(undefined),
        ]);

      const lzFeeStroops = quotedFee + lzFeeBufferStroops;
      const decision = evaluateSorobanKeeperProfitability({
        rewardStroops,
        lzFeeStroops,
        inclusionFeeStroops,
        minNetProfitStroops: minProfitStroops,
        contractReserveStroops,
        rewardEligible,
      });

      if (enforceProfitability && !decision.profitable) {
        if (decision.reason === "awaiting_dispatch_reward_grace") {
          this.metrics.skippedAwaitingGraceTotal += 1;
        } else {
          this.metrics.skippedUnprofitableTotal += 1;
        }
        this.log.info("skipping Soroban dispatch_confirmation due to profitability guard", {
          intentHash,
          reason: decision.reason,
          ledgersElapsed,
          rewardEligible,
          rewardStroops: rewardStroops.toString(),
          totalCostStroops: decision.totalCostStroops.toString(),
        });
        recordAction({
          chain: "soroban",
          action: "dispatch_confirmation",
          intentHash,
          status: "skipped",
          reason: decision.reason ?? "unprofitable",
          feePaidStroops: decision.totalCostStroops,
          rewardEarnedStroops: decision.effectiveRewardStroops,
        });
        continue;
      }

      if (dryRun) {
        this.metrics.dryRunActionsTotal += 1;
        this.log.info("dry-run: would call Soroban dispatch_confirmation", {
          intentHash,
          lzFeeStroops: lzFeeStroops.toString(),
          rewardStroops: decision.effectiveRewardStroops.toString(),
        });
        recordAction({
          chain: "soroban",
          action: "dispatch_confirmation",
          intentHash,
          status: "dry_run",
          reason: "dry_run",
          feePaidStroops: decision.totalCostStroops,
          rewardEarnedStroops: decision.effectiveRewardStroops,
        });
        continue;
      }

      try {
        const tx = await adapter.dispatchConfirmation(intentHash, lzFeeStroops);
        const feePaidStroops = lzFeeStroops + tx.feeChargedStroops;
        this.metrics.confirmationsDispatchedTotal += 1;
        this.metrics.sorobanFeesSpentStroops += feePaidStroops;
        this.metrics.sorobanRewardsEarnedStroops += decision.effectiveRewardStroops;
        this.candidateFilledIntents.delete(intentHash);

        this.log.info("Soroban dispatch_confirmation succeeded", {
          intentHash,
          txHash: tx.txHash,
          feePaidStroops: feePaidStroops.toString(),
          rewardEarnedStroops: decision.effectiveRewardStroops.toString(),
        });

        recordAction({
          chain: "soroban",
          action: "dispatch_confirmation",
          intentHash,
          status: "executed",
          txHash: tx.txHash,
          feePaidStroops,
          rewardEarnedStroops: decision.effectiveRewardStroops,
        });
      } catch (err) {
        this.metrics.failedActionsTotal += 1;
        this.log.warn("Soroban dispatch_confirmation failed", {
          intentHash,
          err: String(err),
        });
        recordAction({
          chain: "soroban",
          action: "dispatch_confirmation",
          intentHash,
          status: "failed",
          reason: String(err),
        });
      }
    }
  }

  private async reportMempoolStatus(intentHash: Hex, status: MempoolIntentStatus): Promise<void> {
    const { mempoolUrl, mempoolStatusToken } = this.config;
    if (!this.mempoolClient || !mempoolUrl || !mempoolStatusToken) return;
    try {
      await this.mempoolClient.reportStatus(intentHash, status, mempoolStatusToken);
    } catch (err) {
      this.log.warn("keeper failed to report status to mempool (non-fatal)", {
        intentHash,
        status,
        err: String(err),
      });
    }
  }

  private interruptibleSleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      this.abortSleep = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }
}
