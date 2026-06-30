/**
 * Bounded LRU+TTL cache for the solver `seen` set.
 *
 * ## Eviction policy
 *
 * Entries are evicted in two ways:
 *
 * 1. **TTL eviction** — any entry whose intent deadline has passed is eligible
 *    for eviction.  An intent past its deadline can never be filled, so it
 *    adds no value to the dedup set.  `evictExpired()` is called at the start
 *    of every tick to reclaim memory proactively.
 *
 * 2. **LRU eviction** — when the cache reaches `maxSize`, the least-recently-
 *    seen entry is evicted to make room.  This caps worst-case memory at
 *    `maxSize × ~100 bytes` regardless of mempool throughput.
 *
 * ## Restart behaviour
 *
 * `SeenLRU` is purely in-memory.  On restart, `seen` is empty and the solver
 * will reconsider every pending intent in the mempool.  This is safe because:
 *
 * - The executor is **idempotent**: it calls `checkFillStatus` before
 *   attempting a fill, so a forgotten-then-reconsidered intent will discover
 *   it is already filled and skip re-submission.
 * - The on-chain escrow enforces at-most-one-fill per intent hash (the
 *   `AlreadyFinalized` guard in `_onFillConfirmed`), so even if the executor
 *   did re-submit, the second transaction would revert harmlessly.
 *
 * Operators should therefore treat `seen` as a short-lived dedup window
 * (bounding within a run) rather than a permanent ledger.
 */

/** Entry stored in the seen-set LRU cache. */
interface SeenEntry {
  /** Unix-ms timestamp at which this entry was inserted. */
  insertedAt: number;
  /**
   * Unix-ms deadline of the intent, derived from the on-chain deadline field.
   * An entry whose deadline has passed can never be filled and is safe to evict.
   */
  deadlineMs: number;
}

export class SeenLRU {
  /** Map preserves insertion order; we use that for LRU eviction. */
  private readonly cache = new Map<string, SeenEntry>();
  private readonly maxSize: number;

  constructor(maxSize = 50_000) {
    this.maxSize = maxSize;
  }

  /** True if `hash` is in the seen set (and the entry has not expired). */
  has(hash: string): boolean {
    const entry = this.cache.get(hash);
    if (entry === undefined) return false;
    if (Date.now() > entry.deadlineMs) {
      // Expired — evict lazily.
      this.cache.delete(hash);
      return false;
    }
    // Refresh LRU order.
    this.cache.delete(hash);
    this.cache.set(hash, entry);
    return true;
  }

  /**
   * Mark `hash` as seen.
   *
   * @param hash        The intent hash (0x-prefixed hex).
   * @param deadlineMs  Intent deadline in Unix milliseconds. Entries are
   *                    eligible for eviction once `Date.now() > deadlineMs`.
   */
  add(hash: string, deadlineMs: number): void {
    // Evict if already present (re-insertion refreshes LRU order).
    this.cache.delete(hash);

    // If at capacity, evict the LRU entry (first insertion-order entry).
    if (this.cache.size >= this.maxSize) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }

    this.cache.set(hash, { insertedAt: Date.now(), deadlineMs });
  }

  /**
   * Remove all entries whose intent deadline has passed.
   * Call this at the start of each tick to reclaim memory proactively.
   *
   * @returns The number of entries evicted.
   */
  evictExpired(): number {
    const now = Date.now();
    let evicted = 0;
    for (const [hash, entry] of this.cache) {
      if (now > entry.deadlineMs) {
        this.cache.delete(hash);
        evicted += 1;
      }
    }
    return evicted;
  }

  /** Number of entries currently in the cache. */
  size(): number {
    return this.cache.size;
  }
}
