// SPDX-License-Identifier: MIT

/**
 * Bounded sliding-window hit store used by the mempool's per-client limiter.
 *
 * Entries are kept in least-recently-used order. The size cap is a backstop
 * against a burst of one-shot source addresses before the periodic stale-entry
 * sweep runs.
 */
export class SlidingWindowRateLimitStore {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly windowMs: number,
    private readonly maxKeys = 10_000,
  ) {
    if (!Number.isFinite(windowMs) || windowMs <= 0) {
      throw new Error("rate-limit window must be a positive number");
    }
    if (!Number.isInteger(maxKeys) || maxKeys <= 0) {
      throw new Error("rate-limit key cap must be a positive integer");
    }
  }

  /** Record a hit, returning false when the key has exhausted its budget. */
  allow(key: string, limit: number, now = Date.now()): boolean {
    const recent = (this.hits.get(key) ?? []).filter(
      (timestamp) => now - timestamp < this.windowMs,
    );

    // Refresh insertion order so the cap evicts the least recently seen key.
    this.hits.delete(key);

    if (recent.length >= limit) {
      this.hits.set(key, recent);
      return false;
    }

    if (this.hits.size >= this.maxKeys) {
      const oldest = this.hits.keys().next().value as string | undefined;
      if (oldest !== undefined) this.hits.delete(oldest);
    }

    recent.push(now);
    this.hits.set(key, recent);
    return true;
  }

  /** Drop expired timestamps and remove keys with no hits left in the window. */
  prune(now = Date.now()): number {
    let removed = 0;
    for (const [key, timestamps] of this.hits) {
      const recent = timestamps.filter((timestamp) => now - timestamp < this.windowMs);
      if (recent.length === 0) {
        this.hits.delete(key);
        removed++;
      } else if (recent.length !== timestamps.length) {
        this.hits.set(key, recent);
      }
    }
    return removed;
  }

  get size(): number {
    return this.hits.size;
  }
}
