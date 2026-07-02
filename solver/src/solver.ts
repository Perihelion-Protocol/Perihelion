/**
 * The Perihelion solver loop: poll the mempool for pending intents, evaluate
 * each for profitability, and execute fills for the winners.
 */

import {
  PerihelionClient,
  verifyIntent,
  hashIntent,
  perihelionDomain,
  type IntentRecord,
  type SignedIntent,
  type Hex,
} from "@perihelion/sdk";
import type { SolverConfig } from "./config.js";
import { evaluate } from "./quote.js";
import { BackoffState } from "./backoff.js";
import type { Metrics } from "./metrics.js";
import { SeenLRU } from "./seen-lru.js";
import type { InventoryProvider } from "./inventory.js";

/** Pluggable execution backend — abstracts the two settlement legs. */
export interface Executor {
  /**
   * Lock the user's source funds in the EVM escrow against the intent hash and
   * release the destination assets on Stellar once the LayerZero message is
   * confirmed. Returns the Stellar settlement tx hash.
   */
  fill(signed: SignedIntent): Promise<{ settlementTx: string }>;
}

/** Minimal logger interface so callers can inject structured logging. */
export interface Logger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

// ---------------------------------------------------------------------------
// LRU + TTL cache for the seen set
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// LRU cache for signature verification results
// ---------------------------------------------------------------------------

/**
 * Throw inside tick() (or any code it calls) to signal a non-recoverable
 * condition — e.g. a permanently invalid configuration or an irrecoverable
 * RPC failure. start() re-throws FatalError immediately instead of catching
 * and continuing, so the process can exit non-zero and be restarted by its
 * orchestrator.
 */
export class FatalError extends Error {
  constructor(message: string, override readonly cause?: unknown) {
    super(message);
    this.name = "FatalError";
  }
}

/**
 * LRU cache for signature verification results. Evicts oldest entries when the
 * cache exceeds its size limit to prevent unbounded memory growth.
 */
class VerificationCache {
  private readonly cache = new Map<Hex, boolean>();
  private readonly maxSize: number;

  constructor(maxSize = 10_000) {
    this.maxSize = maxSize;
  }

  get(hash: Hex): boolean | undefined {
    const result = this.cache.get(hash);
    if (result !== undefined) {
      // Move to end (LRU)
      this.cache.delete(hash);
      this.cache.set(hash, result);
    }
    return result;
  }

  set(hash: Hex, valid: boolean): void {
    // Evict oldest if at capacity
    if (this.cache.size >= this.maxSize) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(hash, valid);
  }

  size(): number {
    return this.cache.size;
  }
}

// ---------------------------------------------------------------------------
// Retry state
// ---------------------------------------------------------------------------

const MAX_FILL_RETRIES = 3;

function retryBackoff(attempt: number): number {
  // Exponential backoff: 1s, 2s, 4s …
  return 1_000 * Math.pow(2, attempt);
}

interface RetryState {
  attempts: number;
  nextRetryAt: number;
}

// ---------------------------------------------------------------------------
// Solver
// ---------------------------------------------------------------------------

export class Solver {
  private readonly client: PerihelionClient;

  /**
   * `seen` tracks hashes whose outcome is terminal (filled, invalid signature,
   * or exhausted retries).  Bounded by LRU eviction (capacity cap) and TTL
   * eviction (past-deadline entries are removed every tick).
   *
   * ## Memory characteristics
   *
   * A 66-char hex string + metadata ≈ 150 bytes per entry.
   * Default maxSize = 50,000 → ~7.5 MB worst-case.
   *
   * ## Restart behaviour
   *
   * `seen` is in-memory only; it resets on restart.  This is safe because the
   * executor is idempotent — it checks on-chain state before re-submitting.
   * See {@link SeenLRU} for the full restart-safety rationale.
   */
  private readonly seen: SeenLRU;
  private readonly verificationCache: VerificationCache;
  private readonly retryState = new Map<string, RetryState>();
  private running = false;
  private readonly backoff: BackoffState;
  /** Resolves an in-progress interruptibleSleep early when stop() is called. */
  private abortSleep: (() => void) | null = null;

  constructor(
    private readonly config: SolverConfig,
    private readonly executor: Executor,
    private readonly log: Logger = console,
    private readonly metrics?: Metrics,
    private readonly inventory?: InventoryProvider,
  ) {
    this.client = new PerihelionClient({ mempoolUrl: config.mempoolUrl });
    this.backoff = new BackoffState(config);
    this.seen = new SeenLRU(config.seenCacheSize ?? 50_000);
    this.verificationCache = new VerificationCache(config.verificationCacheSize ?? 10_000);
  }

  /**
   * Start the poll loop. Resolves when {@link stop} is called (graceful drain).
   * Rejects if a {@link FatalError} propagates out of tick().
   */
  async start(): Promise<void> {
    this.running = true;
    this.log.info("solver started", {
      solver: this.config.solverAddress,
      mempool: this.config.mempoolUrl,
    });
    while (this.running) {
      try {
        await this.tick();
        this.backoff.recordSuccess();
      } catch (err) {
        if (err instanceof FatalError) {
          this.log.error("fatal error, solver stopping", { err: String(err) });
          throw err;
        }
        this.backoff.recordFailure();
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

  /** One poll-evaluate-fill cycle. Exposed for testing. */
  async tick(): Promise<void> {
    // Proactively evict past-deadline entries to reclaim memory.
    const evicted = this.seen.evictExpired();
    if (evicted > 0) {
      this.log.info("evicted expired seen-set entries", {
        evicted,
        seenSize: this.seen.size(),
      });
    }

    const pending = await this.client.listPending();
    const now = Date.now();
    for (const record of pending) {
      const { hash } = record;
      if (this.seen.has(hash)) continue;

      const retry = this.retryState.get(hash);
      if (retry && now < retry.nextRetryAt) continue;

      await this.consider(record);
    }
  }

  private async consider(record: IntentRecord): Promise<void> {
    const { intent, signature, hash } = record;

    // Compute deadline in ms for the seen-set TTL.
    // intent.deadline is seconds since epoch.
    const deadlineMs = Number(intent.deadline) * 1_000;

    // Verify the mempool's hash matches our recomputation.
    const domain = perihelionDomain(this.config.sourceChainId, this.config.escrowAddress);
    const recomputedHash = hashIntent(intent, domain);
    if (recomputedHash.toLowerCase() !== hash.toLowerCase()) {
      this.log.warn("rejecting intent: mempool hash mismatch", {
        hash,
        recomputedHash,
      });
      return;
    }

    // Check cache first to avoid redundant verification.
    let valid = this.verificationCache.get(hash);
    if (valid === undefined) {
      valid = await verifyIntent(intent, signature, domain);
      this.verificationCache.set(hash, valid);
    }

    if (!valid) {
      this.log.warn("rejecting intent with invalid signature", { hash });
      // Terminal: invalid signature will never become valid.
      this.seen.add(hash, deadlineMs);
      this.retryState.delete(hash);
      return;
    }

    const decision = await evaluate(intent, this.config, this.inventory);
    if (!decision.fill) {
      this.log.info("skipping intent", { hash, reason: decision.reason });
      this.metrics?.recordSkip(decision.reason);
      return;
    }

    this.log.info("filling intent", { hash, profitBps: decision.profitBps });
    this.metrics?.recordFillAttempt(intent.destAsset);
    try {
      const { settlementTx } = await this.executor.fill(record);
      this.log.info("filled", { hash, settlementTx });
      this.metrics?.recordFillWon(
        intent.destAsset,
        BigInt(intent.minDestAmount),
        decision.profitBps ?? 0,
      );
      // Terminal: filled successfully.
      this.seen.add(hash, deadlineMs);
      this.retryState.delete(hash);
    } catch (err) {
      if (err instanceof FatalError) throw err;
      this.log.error("fill failed", { hash, err: String(err) });
      this.metrics?.recordFillLost(intent.destAsset, String(err));
      this.scheduleRetry(hash, deadlineMs);
    }
  }

  private scheduleRetry(hash: string, deadlineMs: number): void {
    const state = this.retryState.get(hash) ?? { attempts: 0, nextRetryAt: 0 };
    const attempts = state.attempts + 1;
    if (attempts > MAX_FILL_RETRIES) {
      this.log.warn("max retries exhausted, retiring intent", { hash, attempts });
      this.seen.add(hash, deadlineMs);
      this.retryState.delete(hash);
    } else {
      this.retryState.set(hash, {
        attempts,
        nextRetryAt: Date.now() + retryBackoff(attempts - 1),
      });
    }
  }

  /** Expose pricing deps for testing — set by subclasses or tests. */
  protected readonly pricingDeps: Parameters<typeof evaluate>[2] = undefined;

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
