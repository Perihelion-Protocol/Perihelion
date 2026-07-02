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
import { BackoffState } from "./backoff.js";
import type { DeadLetterStore } from "./dead-letter.js";
import { InMemoryDeadLetterStore } from "./dead-letter.js";

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
   */
  poll(fromBlock: number): Promise<{
    messages: PendingMessage[];
    head: number;
    headHash?: string;
    parentHash?: string;
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

export interface Logger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

/** Retry + dead-letter configuration. */
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
  failed: number;
  deadLettered: number;
  /** Maximum retry depth seen across all messages this session. */
  maxRetryDepth: number;
}

/** Tracked block header for reorg detection. */
interface BlockRecord {
  number: number;
  hash: string;
  parentHash: string;
}

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
  /** Lag = head − cursor. High lag means the relayer is falling behind. */
  lag: number;
}

/**
 * Throw inside tick() (or any code it calls) to signal a non-recoverable
 * condition. start() re-throws FatalError immediately instead of catching and
 * continuing, so the process can exit non-zero and be restarted by its
 * orchestrator.
 */
export class FatalError extends Error {
  constructor(message: string, override readonly cause?: unknown) {
    super(message);
    this.name = "FatalError";
  }
}

export class Relayer {
  private running = false;
  private cursor: number;
  private readonly backoff: BackoffState;
  /** Resolves an in-progress interruptibleSleep early when stop() is called. */
  private abortSleep: (() => void) | null = null;

  // --- Internal state -------------------------------------------------------

  /** Retry attempt counters per message composite key. */
  private readonly attempts = new Map<string, number>();

  /** Counters exposed via the health/metrics endpoints. */
  readonly metrics: RelayMetrics = {
    delivered: 0,
    failed: 0,
    deadLettered: 0,
    maxRetryDepth: 0,
  };

  /** Sliding window of recent block headers for reorg detection. */
  private readonly blockWindow: BlockRecord[] = [];

  /** Readiness state, updated after each tick. */
  readonly readiness: ReadinessState = {
    lastTickOk: false,
    lastTickAt: 0,
    cursor: 0,
    head: 0,
    lag: 0,
  };

  constructor(
    private readonly config: RelayerConfig,
    private readonly watcher: SourceWatcher,
    private readonly delivery: DestinationDelivery,
    private readonly log: Logger = console,
    private readonly startBlock = 0,
    private readonly checkpoint: CheckpointStore = new NoopCheckpointStore(),
    private readonly deadLetter: DeadLetterStore = new InMemoryDeadLetterStore(),
    private readonly retry: RetryPolicy = DEFAULT_RETRY,
  ) {
    this.cursor = startBlock;
    this.backoff = new BackoffState(config);
    this.readiness.cursor = startBlock;
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
    const { messages, head, headHash, parentHash } = await this.watcher.poll(this.cursor);

    // Reorg detection — only when the watcher provides block hashes.
    if (headHash !== undefined && parentHash !== undefined) {
      const reorgDepth = this.detectReorg(head, headHash, parentHash);
      if (reorgDepth > 0) {
        if (reorgDepth > this.config.confirmations) {
          this.log.error("DEEP_REORG", {
            head,
            reorgDepth,
            confirmations: this.config.confirmations,
            action: "Manual inspection required — blocks delivered during orphaned chain may need remediation",
          });
        } else {
          this.log.warn("reorg detected, rolling back cursor", {
            head,
            reorgDepth,
            prevCursor: this.cursor,
          });
          // Roll back cursor to re-process the reorged blocks.
          this.cursor = Math.max(this.startBlock, head - reorgDepth);
          this.readiness.cursor = this.cursor;
        }
      }
      this.recordBlock({ number: head, hash: headHash, parentHash });
    }

    const confirmedHead = head - this.config.confirmations;
    const results: RelayResult[] = [];

    // Update readiness lag.
    this.readiness.head = head;
    this.readiness.lag = Math.max(0, head - this.cursor);

    for (const pending of messages) {
      if (pending.srcBlock > confirmedHead) continue; // not yet final

      const result = await this.relayOne(pending);
      results.push(result);
    }

    // Advance the cursor past all confirmed blocks we've now processed.
    this.cursor = Math.max(this.cursor, confirmedHead + 1);
    this.readiness.cursor = this.cursor;
    await this.checkpoint.save(this.cursor);
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
    if (this.deadLetter.has(key)) {
      return { intentHash, delivered: false, error: "dead-lettered" };
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
        return { intentHash, delivered: false };
      }
      const dstTxHash = await this.delivery.deliver(pending);
      this.log.info("delivered", { intentHash, messageType, dstTxHash });
      this.attempts.delete(keyStr);
      this.metrics.delivered += 1;
      return { intentHash, delivered: true, dstTxHash };
    } catch (err) {
      if (err instanceof FatalError) throw err;

      const attempt = (this.attempts.get(keyStr) ?? 0) + 1;
      this.attempts.set(keyStr, attempt);
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
          action:
            "Operator intervention required — see dead-letter runbook in dead-letter.ts",
        });
        return {
          intentHash,
          delivered: false,
          error: `dead-lettered after ${attempt} attempts: ${String(err)}`,
        };
      }

      // Backoff before next tick picks it up.
      const backoff = this.retry.baseBackoffMs * Math.pow(2, attempt - 1);
      this.metrics.failed += 1;
      this.log.warn("delivery failed, will retry", {
        intentHash,
        messageType,
        attempt,
        maxAttempts: this.retry.maxAttempts,
        backoffMs: backoff,
        err: String(err),
      });
      await sleep(backoff);
      return { intentHash, delivered: false, error: String(err) };
    }
  }

  // ---------------------------------------------------------------------------
  // Reorg detection helpers
  // ---------------------------------------------------------------------------

  /**
   * Returns the depth of a detected reorg (0 = no reorg).
   * A reorg is detected when `parentHash` does not match the hash we recorded
   * for `head - 1`.
   */
  private detectReorg(
    head: number,
    _headHash: string,
    parentHash: string,
  ): number {
    // Find the record for head-1 in our window.
    const prev = this.blockWindow.find((b) => b.number === head - 1);
    if (prev === undefined) return 0; // no prior record — cannot detect

    if (prev.hash === parentHash) return 0; // chain is continuous

    // Discontinuity: walk back to find how deep the fork is.
    let depth = 1;
    let current = prev;
    while (depth <= this.config.confirmations) {
      const ancestor = this.blockWindow.find(
        (b) => b.number === current.number - 1,
      );
      if (ancestor === undefined) break;
      if (ancestor.hash === current.parentHash) {
        // Found the common ancestor at `current.number - 1`; reorg depth is
        // (head - 1) - (current.number - 1) + 1.
        return head - current.number + 1;
      }
      current = ancestor;
      depth += 1;
    }
    return depth;
  }

  private recordBlock(block: BlockRecord): void {
    // Keep window bounded to confirmations + a small buffer.
    const limit = Math.max(this.config.confirmations + 10, 20);
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
