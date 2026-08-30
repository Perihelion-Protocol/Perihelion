// SPDX-License-Identifier: MIT

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
import { evaluate, type PricingDeps } from "./quote.js";
import { BackoffState } from "./backoff.js";
import type { Metrics } from "./metrics.js";
import type { InventoryProvider } from "./inventory.js";
import { InFlightTracker } from "./inventory.js";
import { SeenLRU } from "./seen-lru.js";

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

/**
 * Signature-verification seam. Defaults to the SDK's {@link verifyIntent};
 * injectable so tests can drive verification outcomes and count invocations
 * (the ESM namespace itself is frozen and cannot be monkeypatched).
 */
export type IntentVerifier = typeof verifyIntent;

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
 * How long a *negative* verification result stays cached. Kept short (relative
 * to the LRU-only lifetime of positive results) because an invalid-signature
 * verdict is a property of the (domain, hash, signature) triple, not of the
 * intent hash alone: the same hash can be resubmitted later with a corrected
 * signature, and that resubmission must be re-verified promptly rather than
 * silently short-circuited by a stale cache entry.
 *
 * Positive results are never expired by TTL — a valid EIP-712 signature over
 * a given domain+hash stays valid forever, so those entries are bounded only
 * by LRU eviction.
 */
const NEGATIVE_VERIFICATION_TTL_MS = 60_000;

/**
 * Builds the {@link VerificationCache} key. Verification outcomes are only
 * meaningful for a specific (domain, intent hash, signature) triple: two
 * submissions that share an intent hash but carry different signatures (e.g.
 * a bad signature followed by a corrected one) must never share a cache
 * entry, and a signature that would be valid under one chain/escrow domain
 * must not be treated as valid under another.
 */
function verificationCacheKey(
  domain: { chainId?: number | bigint; verifyingContract?: string },
  hash: Hex,
  signature: Hex,
): string {
  return `${domain.chainId}:${domain.verifyingContract}:${hash}:${signature}`;
}

/**
 * LRU cache for signature verification results, keyed by
 * {@link verificationCacheKey} (domain + hash + signature). Evicts oldest
 * entries when the cache exceeds its size limit to prevent unbounded memory
 * growth. Negative (invalid) results additionally expire after
 * {@link NEGATIVE_VERIFICATION_TTL_MS} so they cannot suppress
 * reconsideration of a corrected resubmission indefinitely; positive results
 * have no TTL since a valid signature never becomes invalid.
 */
class VerificationCache {
  private readonly cache = new Map<string, { valid: boolean; expiresAt?: number }>();
  private readonly maxSize: number;

  constructor(maxSize = 10_000) {
    this.maxSize = maxSize;
  }

  get(key: string): boolean | undefined {
    const entry = this.cache.get(key);
    if (entry === undefined) return undefined;
    if (entry.expiresAt !== undefined && Date.now() > entry.expiresAt) {
      // Negative result has gone stale — treat as a miss so it is re-verified.
      this.cache.delete(key);
      return undefined;
    }
    // Move to end (LRU)
    this.cache.delete(key);
    this.cache.set(key, entry);
    return entry.valid;
  }

  set(key: string, valid: boolean): void {
    // Evict oldest if at capacity (and this is a new key, not a refresh).
    if (!this.cache.has(key) && this.cache.size >= this.maxSize) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(key, {
      valid,
      expiresAt: valid ? undefined : Date.now() + NEGATIVE_VERIFICATION_TTL_MS,
    });
  }

  size(): number {
    return this.cache.size;
  }
}

// ---------------------------------------------------------------------------
// Retry state
// ---------------------------------------------------------------------------

const MAX_FILL_RETRIES = 3;

/**
 * Floor for the seen-set TTL. A terminal skip (invalid signature, wrong
 * chain, exhausted retries, ...) must survive long enough to actually
 * suppress reconsideration — an intent's on-chain deadline is frequently
 * already in the past (that's *why* it's terminal), so deriving the TTL
 * from the deadline alone would evict the entry on the very next tick.
 */
const MIN_SEEN_TTL_MS = 10 * 60_000;

/**
 * Convert an intent's Unix-seconds deadline into a Unix-ms TTL for the
 * seen-set, clamped so a past or non-finite deadline still yields a TTL
 * far enough in the future to suppress reconsideration.
 */
function seenTtlMs(deadline: number): number {
  const raw = Number(deadline) * 1_000;
  const floor = Date.now() + MIN_SEEN_TTL_MS;
  return Number.isFinite(raw) ? Math.max(raw, floor) : floor;
}

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
   * `seen` tracks hashes whose outcome is terminal (filled, or exhausted
   * retries).  Bounded by LRU eviction (capacity cap) and TTL eviction
   * (past-deadline entries are removed every tick).
   *
   * An invalid signature is *not* terminal for the hash and does not go into
   * `seen`: the same intent hash can be resubmitted later with a corrected
   * signature, and that resubmission must still be reconsidered. See
   * {@link VerificationCache} for how repeated invalid submissions are still
   * bounded (short TTL on negative results) without blocking a corrected one.
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
  /** Tracks capital committed to fills that are in flight, so a stale on-chain
   * balance read cannot let a second intent over-commit the same inventory. */
  private readonly inFlight = new InFlightTracker();
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
    private readonly verifier: IntentVerifier = verifyIntent,
    /** Injectable pricing overrides (priceOracle/feeEstimator/decimalsLookup), merged with `inventory` when evaluating. */
    private readonly pricingDeps?: PricingDeps,
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

    // Count hash-mismatches across this page so we can escalate when every
    // record on the page mismatches — which is a strong signal that the
    // solver's own domain configuration (sourceChainId / escrowAddress) is
    // wrong rather than individual records being malformed.
    let pageMismatches = 0;
    let pageConsidered = 0;

    for (const record of pending) {
      const { hash } = record;
      if (this.seen.has(hash)) continue;

      const retry = this.retryState.get(hash);
      if (retry && now < retry.nextRetryAt) continue;

      pageConsidered += 1;
      const wasMismatch = await this.consider(record);
      if (wasMismatch) pageMismatches += 1;
    }

    // If every non-skipped record on this page produced a hash mismatch, the
    // solver's domain is almost certainly misconfigured. Emit one actionable
    // error per tick (not per record) so operators can diagnose it quickly.
    if (pageConsidered > 0 && pageMismatches === pageConsidered) {
      this.log.error(
        "all records on this page failed hash verification: possible domain misconfiguration",
        {
          sourceChainId: this.config.sourceChainId,
          escrowAddress: this.config.escrowAddress,
          pageMismatches,
        },
      );
    }
  }

  /**
   * Evaluate a single pending record. Returns `true` if the record was
   * rejected due to a hash mismatch (used by `tick()` to detect a full-page
   * mismatch that may indicate a domain misconfiguration), `false` otherwise.
   */
  private async consider(record: IntentRecord): Promise<boolean> {
    const { intent, signature, hash } = record;

    // Seen-set TTL, clamped so terminal skips of already-expired intents
    // still stick (see MIN_SEEN_TTL_MS above).
    const deadlineMs = seenTtlMs(intent.deadline);

    // Verify the mempool's hash matches our recomputation.
    const domain = perihelionDomain(this.config.sourceChainId, this.config.escrowAddress);
    const recomputedHash = hashIntent(intent, domain);
    if (recomputedHash.toLowerCase() !== hash.toLowerCase()) {
      this.log.warn("rejecting intent: mempool hash mismatch", {
        hash,
        recomputedHash,
      });
      // Hash mismatch is terminal for this record as published: the hash is a
      // deterministic function of the intent fields and the domain, and neither
      // changes while the record is in the mempool. Retire it to `seen` so
      // subsequent ticks skip the EIP-712 recomputation and suppress the
      // repeated warning.
      this.seen.add(hash, deadlineMs);
      this.retryState.delete(hash);
      return true;
    }

    // Check cache first to avoid redundant verification. Keyed on domain +
    // hash + signature so a different signature over the same hash (e.g. a
    // corrected resubmission) never reuses another signature's verdict.
    const cacheKey = verificationCacheKey(domain, hash, signature);
    let valid = this.verificationCache.get(cacheKey);
    if (valid === undefined) {
      valid = await this.verifier(intent, signature, domain);
      this.verificationCache.set(cacheKey, valid);
    }
    if (!valid) {
      this.log.warn("rejecting intent with invalid signature", { hash });
      // Not terminal for the hash: only this (domain, hash, signature) triple
      // is invalid. Do not add to `seen` — a resubmission of the same intent
      // hash with a corrected signature must still be reconsidered and
      // fillable. Repeated re-verification of the same bad signature is
      // still bounded by the verification cache's negative-result TTL.
      this.retryState.delete(hash);
      return false;
    }

    const decision = await evaluate(
      intent,
      this.config,
      {
        ...this.pricingDeps,
        availableBalance: this.inventory?.availableBalance.bind(this.inventory),
      },
      this.inFlight,
    );
    if (!decision.fill) {
      this.log.info("skipping intent", { hash, reason: decision.reason });
      this.metrics?.recordSkip(decision.reason);
      // Terminal: this intent will never become fillable (wrong chain,
      // expired, unsupported asset, reserved for another solver, ...).
      // Without this, evaluate() re-derives the same terminal verdict
      // every tick, logging and metric-recording it indefinitely.
      if (decision.terminal) {
        this.seen.add(hash, deadlineMs);
        this.retryState.delete(hash);
      }
      return false;
    }

    this.log.info("filling intent", { hash, profitBps: decision.profitBps });
    this.metrics?.recordFillAttempt(intent.destAsset);
    const reserved = BigInt(intent.minDestAmount);
    this.inFlight.reserve(intent.destAsset, reserved);
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
    } finally {
      this.inFlight.release(intent.destAsset, reserved);
    }
    return false;
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
