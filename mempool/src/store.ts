// SPDX-License-Identifier: MIT

import type { Hex } from "@perihelion/sdk";
import { isExpired } from "@perihelion/sdk";
import type { IntentStatus, MempoolIntentRecord } from "./types.js";

export interface IntentStoreOptions {
  /** Maximum number of records retained; oldest are evicted once exceeded. */
  maxSize?: number;
  /** Grace period (ms) past an intent's deadline before it is evicted. */
  expiryGraceMs?: number;
}

const DEFAULT_MAX_SIZE = 50_000;
const DEFAULT_EXPIRY_GRACE_MS = 60_000;

/** Terminal statuses cannot transition to any other status. */
const TERMINAL_STATUSES: ReadonlySet<IntentStatus> = new Set(["settled", "refunded", "expired"]);

/**
 * In-memory intent store. Bounded by `maxSize` (oldest-insertion eviction)
 * and swept of records past their deadline + grace period via
 * `evictExpired()`. Purely in-memory: state is lost on restart.
 */
export class IntentStore {
  private records = new Map<Hex, MempoolIntentRecord>();
  private byStatus = new Map<IntentStatus, Set<Hex>>();
  private readonly maxSize: number;
  private readonly expiryGraceMs: number;

  constructor(opts: IntentStoreOptions = {}) {
    this.maxSize = opts.maxSize ?? DEFAULT_MAX_SIZE;
    this.expiryGraceMs = opts.expiryGraceMs ?? DEFAULT_EXPIRY_GRACE_MS;
  }

  private indexAdd(hash: Hex, status: IntentStatus): void {
    let set = this.byStatus.get(status);
    if (!set) {
      set = new Set();
      this.byStatus.set(status, set);
    }
    set.add(hash);
  }

  private indexRemove(hash: Hex, status: IntentStatus): void {
    this.byStatus.get(status)?.delete(hash);
  }

  set(hash: Hex, record: MempoolIntentRecord): void {
    // Re-inserting refreshes insertion order for oldest-first eviction.
    this.delete(hash);
    if (this.records.size >= this.maxSize) {
      this.evictOne();
    }
    this.records.set(hash, record);
    this.indexAdd(hash, record.status);
  }

  /**
   * Free a single slot when the store is at capacity. Prefers the oldest
   * record in a terminal status (`settled`/`refunded`/`expired`) — those are
   * retained only for late reads, so dropping one is harmless — and falls
   * back to the oldest record overall so a store saturated with `pending`
   * intents still makes room. `Map` iterates in insertion order, so the first
   * match in each pass is the oldest.
   */
  private evictOne(): void {
    for (const [hash, record] of this.records) {
      if (TERMINAL_STATUSES.has(record.status)) {
        this.delete(hash);
        return;
      }
    }
    const oldest = this.records.keys().next().value;
    if (oldest !== undefined) this.delete(oldest);
  }

  get(hash: Hex): MempoolIntentRecord | undefined {
    const record = this.records.get(hash);
    return record ? { ...record } : undefined;
  }

  /**
   * Update a record's status. Refuses to move a record out of a terminal
   * status (`settled`/`refunded`/`expired`) — those are final.
   */
  updateStatus(hash: Hex, status: IntentStatus): boolean {
    const record = this.records.get(hash);
    if (!record) return false;
    if (TERMINAL_STATUSES.has(record.status)) return false;
    this.indexRemove(hash, record.status);
    record.status = status;
    this.indexAdd(hash, status);
    return true;
  }

  delete(hash: Hex): boolean {
    const record = this.records.get(hash);
    if (!record) return false;
    this.indexRemove(hash, record.status);
    return this.records.delete(hash);
  }

  /**
   * Evict records whose deadline has passed by more than the configured
   * grace period. Returns the number of records evicted.
   */
  evictExpired(now = Math.floor(Date.now() / 1000)): number {
    let evicted = 0;
    for (const [hash, record] of this.records) {
      if (isExpired(record.intent, now, -Math.floor(this.expiryGraceMs / 1000))) {
        this.delete(hash);
        evicted += 1;
      }
    }
    return evicted;
  }

  all(status?: IntentStatus): MempoolIntentRecord[] {
    const hashes = status ? this.byStatus.get(status) ?? new Set<Hex>() : this.records.keys();
    const out: MempoolIntentRecord[] = [];
    for (const hash of hashes) {
      const record = this.records.get(hash);
      if (record) out.push({ ...record });
    }
    return out;
  }

  /**
   * Filter by `status`/`chainId` and paginate in a single pass over the
   * relevant index, copying only the records that land on the returned page.
   * Unlike {@link all} followed by an in-handler slice, a list request no
   * longer allocates in proportion to the whole store.
   *
   * `cursor` is the `hash` of the last record from the previous page;
   * iteration resumes at the record immediately after it. An unknown cursor
   * yields an empty page (the caller has walked past the end).
   */
  list(opts: {
    status?: IntentStatus;
    chainId?: number;
    cursor?: Hex;
    limit: number;
  }): { records: MempoolIntentRecord[]; nextCursor?: Hex } {
    const { status, chainId, cursor, limit } = opts;
    const hashes = status
      ? this.byStatus.get(status) ?? new Set<Hex>()
      : this.records.keys();

    const page: MempoolIntentRecord[] = [];
    let reached = cursor === undefined;
    let more = false;

    for (const hash of hashes) {
      const record = this.records.get(hash);
      if (!record) continue;
      if (chainId !== undefined && record.intent.sourceChainId !== chainId) continue;
      if (!reached) {
        if (hash === cursor) reached = true;
        continue;
      }
      if (page.length >= limit) {
        more = true;
        break;
      }
      page.push({ ...record });
    }

    return {
      records: page,
      nextCursor: more ? page[page.length - 1]?.hash : undefined,
    };
  }

  size(): number {
    return this.records.size;
  }
}
