// SPDX-License-Identifier: MIT

/**
 * The Perihelion relayer carries LayerZero messages along the Stellar ↔ EVM
 * path. It watches the source chain for locked-fund commitments, waits for
 * sufficient confirmations, and delivers the verified message to the
 * destination settlement contract.
 *
 * The relayer is **permissionless and trust-minimized**: it only transports
 * messages whose authenticity the destination contract verifies independently
 * (via the LayerZero DVN stack — the current verification mechanism).
 * Stellar Protocol 24 ZK proofs are not yet integrated; see the roadmap in
 * TECHNICAL-ARCHITECTURE.md §8.3 for the planned ZK verification path.
 * A malicious relayer can censor or delay, but cannot forge a delivery.
 *
 * ## Reorg-handling policy
 *
 * The relayer tracks (blockNumber, blockHash) for every processed block.  On
 * each tick it verifies that the parent hash of the new head connects to the
 * last known hash — a discontinuity signals a reorg.
 *
 * - **Within the confirmation window**: the cursor is rolled back to the reorg
 *   depth and affected messages are re-processed.  Idempotency (via the
 *   composite dedup key) prevents double delivery.
 * - **Deeper than confirmations**: an `error`-level `DEEP_REORG` alert is
 *   emitted.  The operator must inspect whether any messages delivered during
 *   the now-orphaned blocks require manual remediation.
 *
 * Where the chain exposes a `finalized` / `safe` tag (EIP-1898), prefer it
 * over a fixed confirmation depth — set `PERIHELION_CONFIRMATIONS=0` and
 * rely on the finalized head supplied by `SourceWatcher.poll`.
 *
 * ### Per-chain assumptions
 * | Chain      | Finality model          | Recommended confirmations |
 * |------------|-------------------------|---------------------------|
 * | Ethereum   | Deterministic (Casper)  | 0 (use finalized tag)     |
 * | Base       | Probabilistic           | 6                         |
 * | Arbitrum   | L1-derived              | 0 (use finalized tag)     |
 */

import type { RelayerConfig } from "./config.js";
import type { CheckpointStore } from "./checkpoint.js";
import { NoopCheckpointStore } from "./checkpoint.js";
import type { PendingMessage, RelayResult, MessageKey } from "./types.js";
import { messageKeyString } from "./types.js";
import { BackoffState, FatalError, type Logger } from "@perihelion/node-common";

export { FatalError };
export type { Logger };
import type { DeadLetterStore } from "./dead-letter.js";
import { InMemoryDeadLetterStore } from "./dead-letter.js";
import { PerihelionClient, type MempoolIntentStatus } from "@perihelion/sdk";

/** Observes bridge messages emitted on the source chain. */
export interface SourceWatcher {
  /**
   * Return messages emitted since `fromBlock` (inclusive). `head` must be the
   * source chain's latest block height — it may be smaller than the
   * configured confirmation depth (e.g. a fresh local/test chain), which
   * {@link Relayer.tick} handles by relaying nothing that tick.
   *
   * `headHash` is the block hash of `head`; `parentHash` is the parent of
   * `head`.  Both are used for reorg detection.  Implementations that cannot
   * supply them may omit these fields; reorg detection is then disabled.
   *
   * `blockHeaders` (optional) provides block records for intermediate blocks
   * in the scanned range (fromBlock through head). If supplied, the relayer
   * records all of them for deeper reorg detection.
   */
  poll(fromBlock: number): Promise<{
    messages: PendingMessage[];
    head: number;
    headHash?: string;
    parentHash?: string;
    blockHeaders?: Array<{ number: number; hash: string; parentHash: string }>;
  }>;
}

/**
 * Delivers a verified message to the destination settlement contract.
 *
 * ## Composite dedup key
 *
 * Idempotency is keyed on the full message identity — `(srcEid, dstEid,
 * intentHash, messageType, nonce)` — rather than `intentHash` alone.  A
 * single intent accumulates multiple distinct protocol messages over its
 * lifetime (FillInstruction → FillConfirmed or CancelIntent); keying on
 * intentHash alone would cause the second message to be skipped as "already
 * delivered".
 */
export interface DestinationDelivery {
  /** Submit the message; returns the destination tx hash. */
  deliver(pending: PendingMessage): Promise<string>;
  /**
   * True if this exact message was already delivered.
   * Keyed on the composite `(srcEid, dstEid, intentHash, messageType, nonce)`.
   */
  isDelivered(key: MessageKey): Promise<boolean>;
}

/**
 * Retry + dead-letter configuration.
 *
 * ## Retry-budget semantics
 *
 * Attempt bookkeeping is keyed on the message's composite key and is
 * **reset whenever the message is no longer observed** by the watcher (e.g.
 * it disappears from the source chain for a while and later reappears).  A
 * message that is re-polled after a prolonged absence therefore starts with a
 * fresh retry budget rather than inheriting the attempt count from its
 * previous incarnation.  This is deliberate: a message that vanished and came
 * back is treated as a new observation, and the dead-letter budget is meant to
 * bound *consecutive* failures of a continuously-observed message, not to
 * accumulate across unrelated appearances.
 */
export interface RetryPolicy {
  /** Maximum delivery attempts before dead-lettering. Default: 5. */
  maxAttempts: number;
  /** Base backoff in ms; attempt n waits baseBackoffMs * 2^(n-1). Default: 500. */
  baseBackoffMs: number;
}

const DEFAULT_RETRY: RetryPolicy = { maxAttempts: 5, baseBackoffMs: 500 };

/** Counters exposed for metrics / monitoring. */
export interface RelayMetrics {
  delivered: number;
  /**
   * Messages found already delivered on the destination (idempotency
   * short-circuit) — e.g. LayerZero's own executor delivered them, or this
   * relayer re-scanned them after a restart. Kept separate from `delivered`
   * so that counter stays a true count of this relayer's own deliveries.
   */
  alreadyDelivered: number;
  failed: number;
  deadLettered: number;
  /** Maximum retry depth seen across all messages this session. */
  maxRetryDepth: number;
  /** Current count of unresolved messages (neither delivered nor dead-lettered). */
  unresolvedMessages: number;
}

/** Tracked block header for reorg detection. */
interface BlockRecord {
  number: number;
  hash: string;
  parentHash: string;
}

/**
 * Throw inside tick() (or any code it calls) to signal a non-recoverable
 * condition. start() re-throws FatalError immediately instead of catching and
 * continuing, so the process can exit non-zero and be restarted by its
 * orchestrator.
 */

/**
 * Readiness snapshot exposed by the health server.
 * Populated after each tick by the relayer.
 */
export interface ReadinessState {
  /** True if the last tick completed without throwing. */
  lastTickOk: boolean;
  /** Timestamp (ms since epoch) of the last successful tick, or 0 if none yet. */
  lastTickAt: number;
  /** Current cursor (last confirmed block the relayer processed). */
  cursor: number;
  /** Latest chain head seen in the most recent poll. */
  head: number;
  /** Confirmed head (latest block with sufficient confirmations). */
  confirmedHead: number;
  /** Lag = confirmedHead + 1 − cursor. High lag means the relayer is falling behind. */
  lag: number;
}

interface MessageRetryState {
  attempts: number;
  nextRetryAt: number;
}

/**
 * Options for a single directional relay loop.
 *
 * A {@link Relayer} instance runs exactly one watch→confirm→deliver loop for
 * one source→destination direction.  Each direction has its own cursor,
 * checkpoint store, dead-letter store and retry bookkeeping, so the two legs
 * of the Stellar ↔ EVM path (EVM→Soroban and Soroban→EVM) advance
 * independently and cannot stall one another.
 */
export interface DirectionalRelayerOptions {
  /** Human-readable label for logs/metrics, e.g. "evm->soroban". */
  name: string;
  config: RelayerConfig;
  watcher: SourceWatcher;
  delivery: DestinationDelivery;
  log?: Logger;
  startBlock?: number;
  checkpoint?: CheckpointStore;
  deadLetter?: DeadLetterStore;
  retry?: RetryPolicy;
}

export class Relayer {
  private running = false;
  private cursor: number;
  private readonly backoff: BackoffState;

  /** Label for this directional loop (used in logs). */
  readonly name: string;

  // --- Internal state -------------------------------------------------------

  /** Retry attempt bookkeeping per message composite key. */
  private readonly attempts = new Map<string, MessageRetryState>();

  /** Counters exposed via the health/metrics endpoints. */
  readonly metrics: RelayMetrics = {
    delivered: 0,
    alreadyDelivered: 0,
    failed: 0,
    deadLettered: 0,
    maxRetryDepth: 0,
    unresolvedMessages: 0,
  };

  /** Sliding window of recent block headers for reorg detection. */
  private readonly blockWindow: BlockRecord[] = [];

  /** Readiness state, updated after each tick. */
  readonly readiness: ReadinessState = {
    lastTickOk: false,
    lastTickAt: 0,
    cursor: 0,
    head: 0,
    confirmedHead: 0,
    lag: 0,
  };

  /** Resolves an in-progress interruptibleSleep early when stop() is called. */
  private abortSleep: (() => void) | null = null;

  /**
   * Thin SDK client used for best-effort mempool status reporting.
   * Only instantiated when both `mempoolUrl` and `mempoolStatusToken` are
   * present in the config.
   */
  private readonly mempoolClient: PerihelionClient | null;

  /**
   * Construct a directional relayer.
   *
   * The positional form (config, watcher, delivery, …) is retained for
   * backward compatibility with existing callers and tests; it describes a
   * single direction.  New code should prefer {@link Relayer.forDirection}
   * or {@link Relayer.compose} so that both legs of the bridge can be run
   * with independent checkpoints and dead-letter stores.
   */
  constructor(
    private readonly config: RelayerConfig,
    private readonly watcher: SourceWatcher,
    private readonly delivery: DestinationDelivery,
    private readonly log: Logger = console,
    private readonly startBlock = 0,
    private readonly checkpoint: CheckpointStore = new NoopCheckpointStore(),
    private readonly deadLetter: DeadLetterStore = new InMemoryDeadLetterStore(),
    private readonly retry: RetryPolicy = DEFAULT_RETRY,
    name = "default",
  ) {
    this.name = name;
    this.cursor = startBlock;
    this.backoff = new BackoffState(config);
    this.readiness.cursor = startBlock;
    this.mempoolClient =
      config.mempoolUrl && config.mempoolStatusToken
        ? new PerihelionClient({ mempoolUrl: config.mempoolUrl })
        : null;
  }

  /** Build a directional relayer from an options object. */
  static forDirection(opts: DirectionalRelayerOptions): Relayer {
    return new Relayer(
      opts.config,
      opts.watcher,
      opts.delivery,
      opts.log ?? console,
      opts.startBlock ?? 0,
      opts.checkpoint ?? new NoopCheckpointStore(),
      opts.deadLetter ?? new InMemoryDeadLetterStore(),
      opts.retry ?? DEFAULT_RETRY,
      opts.name,
    );
  }

  /**
   * Compose several directional relayers into a single controller.
   *
   * Each direction keeps its own cursor, checkpoint and dead-letter store;
   * {@link RelayerGroup.start} runs all loops concurrently and
   * {@link RelayerGroup.stop} drains them together.  A {@link FatalError}
   * from any direction stops the whole group.
   */
  static compose(relayers: Relayer[]): RelayerGroup {
    return new RelayerGroup(relayers);
  }

  /**
   * Resume the cursor from the checkpoint store, falling back to the
   * configured start block on first run (no checkpoint persisted yet).
   * Called automatically by {@link start}; exposed for tests/manual control.
   */
  async resume(): Promise<void> {
    this.cursor = (await this.checkpoint.load()) ?? this.startBlock;
    this.readiness.cursor = this.cursor;
  }

  /**
   * Start the watch-and-relay loop. Resolves when {@link stop} is called
   * (graceful drain — the in-flight tick completes before start() returns).
   * Rejects if a {@link FatalError} propagates out of tick().
   */
  async start(): Promise<void> {
    await this.resume();
    this.running = true;
    this.log.info("relayer started", {
      direction: this.name,
      escrow: this.config.escrowAddress,
      settlement: this.config.settlementContractId,
      cursor: this.cursor,
    });
    while (this.running) {
      try {
        await this.tick();
        this.backoff.recordSuccess();
        this.readiness.lastTickOk = true;
        this.readiness.lastTickAt = Date.now();
      } catch (err) {
        if (err instanceof FatalError) {
          this.log.error("fatal error, relayer stopping", { err: String(err) });
          throw err;
        }
        this.backoff.recordFailure();
        this.readiness.lastTickOk = false;
        this.log.error("tick failed", {
          err: String(err),
          consecutiveFailures: this.backoff.consecutiveFailures,
        });
      }
      // Only sleep if stop() was not called during the tick.
      if (this.running) {
        await this.interruptibleSleep(this.backoff.nextDelay());
      }
    }
  }

  /**
   * Signal the loop to stop after the current tick completes.
   * Any in-progress inter-tick sleep is interrupted immediately so start()
   * resolves without waiting for the full poll interval.
   */
  stop(): void {
    this.running = false;
    this.abortSleep?.();
    this.abortSleep = null;
  }

  /** One watch-confirm-deliver cycle. Exposed for testing. */
  async tick(): Promise<RelayResult[]> {
    const { messages, head, headHash, parentHash, blockHeaders } = await this.watcher.poll(
      this.cursor,
    );

    // Reorg detection — only when the watcher provides block hashes.
    if (headHash !== undefined && parentHash !== undefined) {
      const reorgDepth = this.detectReorg(head, headHash, parentHash);
      if (reorgDepth > 0) {
        const isLocalRollback = head === this.cursor && messages.length > 0;
        if (reorgDepth > this.config.confirmations && !isLocalRollback) {
          this.log.error("DEEP_REORG", {
            head,
            reorgDepth,
            confirmations: this.config.confirmations,
            action:
              "Manual inspection required — blocks delivered during orphaned chain may need remediation",
          });
        } else {
          this.log.warn("reorg detected, rolling back cursor", {
            head,
            reorgDepth,
            prevCursor: this.cursor,
          });
          // Roll back to the last known-good block and skip processing the
          // reorged window until the next tick; otherwise the new head's
          // messages would be treated as valid even though the chain forked.
          this.cursor = Math.max(this.startBlock, head - reorgDepth);
          this.readiness.cursor = this.cursor;

          this.recordHeaders(blockHeaders, head, headHash, parentHash);
          return [];
        }
      }
      // Record every header the watcher returned — on the non-reorg path too —
      // so that the next tick's detectReorg has the parent hash it needs.
      this.recordHeaders(blockHeaders, head, headHash, parentHash);
    }

    const confirmedHead = Math.max(0, head - this.config.confirmations);
    const results: RelayResult[] = [];

    // Update readiness lag.
    this.readiness.head = head;
    this.readiness.confirmedHead = confirmedHead;
    this.readiness.lag = Math.max(0, confirmedHead + 1 - this.cursor);

    // Drop retry bookkeeping for messages that are no longer observed, so a
    // message that disappears and later reappears starts with a fresh retry
    // budget (see RetryPolicy docs).
    const observedKeys = new Set<string>();
    for (const pending of messages) {
      const { srcEid, dstEid, intentHash, messageType, nonce } = pending.message;
      observedKeys.add(messageKeyString({ srcEid, dstEid, intentHash, messageType, nonce }));
    }
    for (const keyStr of this.attempts.keys()) {
      if (!observedKeys.has(keyStr)) {
        this.attempts.delete(keyStr);
      }
    }

    for (const pending of messages) {
      if (pending.srcBlock > confirmedHead) continue; // not yet final

      const result = await this.relayOne(pending);
      results.push(result);
    }

    // Only advance the cursor past fully-resolved blocks. A message is
    // unresolved only while it still needs another delivery attempt — an
    // already-delivered or dead-lettered message is resolved and must not
    // pin the cursor.
    const unresolved = results.filter((r) => !r.resolved);
    this.metrics.unresolvedMessages = unresolved.length;

    // Correlate results back to their messages by the full composite key.
    // Keying on intentHash alone conflates the several distinct messages a
    // single intent produces, which can advance the cursor past a still-failing
    // delivery (permanent skip) or hold it back needlessly.
    const resultByKey = new Map<string, RelayResult>();
    for (const r of results) resultByKey.set(messageKeyString(r.key), r);

    let lowestUnresolved = Infinity;
    for (const pending of messages) {
      if (pending.srcBlock > confirmedHead) continue;
      const { srcEid, dstEid, intentHash, messageType, nonce } = pending.message;
      const result = resultByKey.get(
        messageKeyString({ srcEid, dstEid, intentHash, messageType, nonce }),
      );
      if (result && !result.resolved) {
        lowestUnresolved = Math.min(lowestUnresolved, pending.srcBlock);
      }
    }

    const nextCursor = Math.min(confirmedHead + 1, lowestUnresolved);
    this.cursor = Math.max(this.cursor, nextCursor);
    this.readiness.cursor = this.cursor;
    await this.checkpoint.save(this.cursor);

    // Persist dead-letter queue
    await this.deadLetter.persist();

    return results;
  }

  // ---------------------------------------------------------------------------
  // Retry + dead-letter
  // ---------------------------------------------------------------------------

  private async relayOne(pending: PendingMessage): Promise<RelayResult> {
    const { srcEid, dstEid, intentHash, messageType, nonce } = pending.message;
    const key: MessageKey = { srcEid, dstEid, intentHash, messageType, nonce };
    const keyStr = messageKeyString(key);

    // Already dead-lettered — don't retry until operator drains the queue.
    // Resolved: the cursor must not stall here waiting for a retry that
    // won't happen until an operator intervenes.
    if (this.deadLetter.has(key)) {
      return { intentHash, key, delivered: false, resolved: true, error: "dead-lettered" };
    }

    // Skip retry if backoff delay has not yet elapsed.
    const retryState = this.attempts.get(keyStr);
    if (retryState && Date.now() < retryState.nextRetryAt) {
      return {
        intentHash,
        key,
        delivered: false,
        resolved: false,
        error: `retry deferred until ${retryState.nextRetryAt}`,
      };
    }

    try {
      if (await this.delivery.isDelivered(key)) {
        this.log.info("already delivered, skipping", {
          intentHash,
          messageType,
          srcEid,
          dstEid,
          nonce,
        });
        this.attempts.delete(keyStr);
        this.metrics.alreadyDelivered += 1;
        return { intentHash, key, delivered: false, resolved: true, alreadyDelivered: true };
      }
      const dstTxHash = await this.delivery.deliver(pending);
      this.log.info("delivered", { intentHash, messageType, dstTxHash });
      this.attempts.delete(keyStr);
      this.metrics.delivered += 1;
      // A delivered CancelIntent only marks the Stellar record cancelled; the
      // refund itself happens on EVM and is reported later by the return-leg
      // watcher via onRefundObserved(). No status is reported here: the mempool
      // has no "cancelling" status.
      return { intentHash, key, delivered: true, resolved: true, dstTxHash };
    } catch (err) {
      if (err instanceof FatalError) throw err;

      const attempt = (retryState?.attempts ?? 0) + 1;
      const backoff = this.retry.baseBackoffMs * Math.pow(2, attempt - 1);
      this.attempts.set(keyStr, {
        attempts: attempt,
        nextRetryAt: Date.now() + backoff,
      });
      this.metrics.maxRetryDepth = Math.max(this.metrics.maxRetryDepth, attempt);

      if (attempt >= this.retry.maxAttempts) {
        // Budget exhausted — move to dead-letter queue.
        this.deadLetter.add(key, pending, attempt, String(err));
        this.attempts.delete(keyStr);
        this.metrics.deadLettered += 1;
        this.log.error("DEAD_LETTER", {
          intentHash,
          messageType,
          srcEid,
          dstEid,
          nonce,
          attempts: attempt,
          lastError: String(err),
          action: "Operator intervention required — see dead-letter runbook in dead-letter.ts",
        });
        return {
          intentHash,
          key,
          delivered: false,
          resolved: true,
          error: `dead-lettered after ${attempt} attempts: ${String(err)}`,
        };
      }

      this.metrics.failed += 1;
      this.log.warn("delivery failed, will retry", {
        intentHash,
        messageType,
        attempt,
        maxAttempts: this.retry.maxAttempts,
        backoffMs: backoff,
        err: String(err),
      });
      return { intentHash, key, delivered: false, resolved: false, error: String(err) };
    }
  }

  // ---------------------------------------------------------------------------
  // Mempool status reporting
  // ---------------------------------------------------------------------------

  /**
   * Best-effort: report the terminal `"refunded"` status to the mempool.
   *
   * Must only be called once a refund event (`Refunded` or
   * `RefundedLocalTimeout`) for `intentHash` has been observed on the source
   * (EVM) chain by the return-leg watcher.  Reporting `"refunded"` before the
   * funds have actually moved would mark the intent terminal in the mempool
   * and in the SDK's `waitForSettlement`, while the user's funds are still
   * locked in escrow — and would make `isRefundable` return `false`,
   * blocking the user from calling `cancelExpired` through the SDK flow.
   *
   * Errors are logged and swallowed — a failed status report must never
   * affect on-chain state or retry logic.
   *
   * Only called when both {@link RelayerConfig.mempoolUrl} and
   * {@link RelayerConfig.mempoolStatusToken} are configured.
   */
  private async reportRefunded(intentHash: string): Promise<void> {
    const { mempoolUrl, mempoolStatusToken } = this.config;
    if (!this.mempoolClient || !mempoolStatusToken || !mempoolUrl) return;
    try {
      await this.mempoolClient.reportStatus(
        intentHash as import("@perihelion/sdk").Hex,
        "refunded" satisfies MempoolIntentStatus,
        mempoolStatusToken,
      );
      this.log.info("reported refunded to mempool", { intentHash });
    } catch (err) {
      this.log.warn("failed to report refunded to mempool (non-fatal)", {
        intentHash,
        err: String(err),
      });
    }
  }

  /**
   * Called by the return-leg watcher when it observes a `Refunded` or
   * `RefundedLocalTimeout` event on the source (EVM) chain for `intentHash`.
   * This is the only path that reports the terminal `"refunded"` status to
   * the mempool — see {@link reportRefunded}.
   */
  async onRefundObserved(intentHash: string): Promise<void> {
    await this.reportRefunded(intentHash);
  }

  // ---------------------------------------------------------------------------
  // Reorg detection helpers
  // ---------------------------------------------------------------------------

  /**
   * Returns the depth of a detected reorg (0 = no reorg).
   * A reorg is detected when `parentHash` does not match the hash we recorded
   * for `head - 1`.
   */
  private detectReorg(head: number, _headHash: string, parentHash: string): number {
    // Find the record for head-1 in our window.
    const prev = this.blockWindow.find((b) => b.number === head - 1);
    if (prev === undefined) return 0; // no prior record — cannot detect

    if (prev.hash === parentHash) return 0; // chain is continuous

    // The new head's parent hash diverges from the last known-good block.
    // Walk backward until we find the first common ancestor; that block number
    // marks the start of the fork relative to the current head.
    let current = prev;
    let depth = 1;
    while (current.number > this.startBlock) {
      const ancestor = this.blockWindow.find((b) => b.number === current.number - 1);
      if (ancestor === undefined) break;
      if (ancestor.hash === current.parentHash) {
        return head - current.number;
      }
      current = ancestor;
      depth += 1;
    }
    return depth;
  }

  /**
   * Record all headers returned by the watcher for this tick: the optional
   * intermediate `blockHeaders` plus the head itself.  Called on both the
   * reorg and non-reorg paths so reorg detection always has the parent hash
   * it needs on the following tick.
   */
  private recordHeaders(
    blockHeaders: Array<{ number: number; hash: string; parentHash: string }> | undefined,
    head: number,
    headHash: string,
    parentHash: string,
  ): void {
    if (blockHeaders) {
      for (const block of blockHeaders) {
        this.recordBlock(block);
      }
    }
    this.recordBlock({ number: head, hash: headHash, parentHash });
  }

  private recordBlock(block: BlockRecord): void {
    // Keep window bounded to confirmations + a small buffer.
    const limit = Math.max(this.config.confirmations + 10, 20);
    // Replace any existing record for the same height (a reorg may re-report
    // a block number with a new hash) so lookups always see the latest view.
    const existing = this.blockWindow.findIndex((b) => b.number === block.number);
    if (existing !== -1) {
      this.blockWindow.splice(existing, 1);
    }
    this.blockWindow.push(block);
    if (this.blockWindow.length > limit) {
      this.blockWindow.shift();
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

/**
 * Runs a set of directional {@link Relayer} loops concurrently.
 *
 * Each loop owns its own cursor, checkpoint store and dead-letter store, so
 * the EVM→Soroban and Soroban→EVM legs advance independently.  A fatal error
 * in any direction stops the whole group and rejects {@link start}.
 */
export class RelayerGroup {
  constructor(
    readonly relayers: Relayer[],
    private readonly log: Logger = console,
  ) {
    if (relayers.length === 0) {
      throw new Error("RelayerGroup requires at least one relayer");
    }
  }

  /**
   * Start every directional loop.  Resolves when {@link stop} is called and
   * all loops have drained; rejects if any loop throws a {@link FatalError}.
   */
  async start(): Promise<void> {
    const loops = this.relayers.map((r) =>
      r.start().catch((err: unknown) => {
        // A fatal error in one direction must stop the others too.
        this.stop();
        throw err;
      }),
    );
    const settled = await Promise.allSettled(loops);
    const rejected = settled.find((s): s is PromiseRejectedResult => s.status === "rejected");
    if (rejected) throw rejected.reason;
  }

  /** Signal every directional loop to stop after its current tick. */
  stop(): void {
    for (const r of this.relayers) r.stop();
  }
}
