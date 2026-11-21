// SPDX-License-Identifier: MIT

export interface BackoffConfig {
  readonly pollIntervalMs: number;
  readonly maxJitterMs?: number;
  readonly backoffMultiplier?: number;
  readonly maxBackoffMs?: number;
}

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

  nextDelay(): number {
    const backed = Math.min(
      this.config.pollIntervalMs * this.backoffMultiplier ** this.failures,
      this.maxBackoffMs,
    );
    return backed + Math.floor(this.rng() * (this.maxJitterMs + 1));
  }

  get consecutiveFailures(): number {
    return this.failures;
  }
}
