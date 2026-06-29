/**
 * Jitter and exponential-backoff utilities shared by the solver and relayer
 * poll loops.
 *
 * Usage:
 *   const backoff = new BackoffState(config);
 *   // on success:  backoff.recordSuccess();
 *   // on failure:  backoff.recordFailure();
 *   await sleep(backoff.nextDelay());
 */

export interface BackoffConfig {
  /** Base poll interval in milliseconds. */
  readonly pollIntervalMs: number;
  /** Maximum jitter to add, in milliseconds (uniform random in [0, maxJitterMs]). */
  readonly maxJitterMs?: number;
  /** Multiplier applied to the interval on each consecutive failure (default 2). */
  readonly backoffMultiplier?: number;
  /** Maximum backoff delay in milliseconds (default 60_000). */
  readonly maxBackoffMs?: number;
}

/** Pluggable RNG so tests can inject deterministic values (returns [0,1)). */
export type Rng = () => number;

export class BackoffState {
  private failures = 0;
  private readonly maxJitterMs: number;
  private readonly backoffMultiplier: number;
  private readonly maxBackoffMs: number;

  constructor(
    private readonly config: BackoffConfig,
    private readonly rng: Rng = Math.random,
  ) {
    this.maxJitterMs = config.maxJitterMs ?? Math.floor(config.pollIntervalMs * 0.25);
    this.backoffMultiplier = config.backoffMultiplier ?? 2;
    this.maxBackoffMs = config.maxBackoffMs ?? 60_000;
  }

  recordSuccess(): void {
    this.failures = 0;
  }

  recordFailure(): void {
    this.failures += 1;
  }

  /** Compute the next sleep duration (base interval × backoff factor + jitter). */
  nextDelay(): number {
    const base = this.config.pollIntervalMs;
    const backed = Math.min(base * this.backoffMultiplier ** this.failures, this.maxBackoffMs);
    const jitter = Math.floor(this.rng() * (this.maxJitterMs + 1));
    return backed + jitter;
  }

  get consecutiveFailures(): number {
    return this.failures;
  }
}
