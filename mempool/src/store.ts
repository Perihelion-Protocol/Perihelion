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
 * Deep-freeze a record before it is stored, so a caller holding a reference
 * returned by {@link IntentStore.get} or {@link IntentStore.all} cannot mutate
 * the stored intent. The record's `hash` is a commitment to exactly the intent
 * fields and the `signature` verifies against them, so an in-place mutation
 * would silently desync all three and surface only later, as a hash mismatch
 * or signature-verification failure in every client that fetches the record.
 *
 * `status` is frozen too; {@link IntentStore.updateStatus} is the single path
 * that changes a record, and it replaces the record rather than mutating it.
 */
function freezeRecord(record: MempoolIntentRecord): MempoolIntentRecord {
  // Intent fields are primitives today; freeze any nested object/array too so
  // the guarantee survives a future non-primitive field.
  for (const value of Object.values(record.intent)) {
    if (value !== null && typeof value === "object") Object.freeze(value);
  }
  Object.freeze(record.intent);
  return Object.freeze(record);
}

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
      const oldest = this.records.keys().next().value;
      if (oldest !== undefined) this.delete(oldest);
    }
    const frozen = freezeRecord(record);
    this.records.set(hash, frozen);
    this.indexAdd(hash, frozen.status);
  }

  get(hash: Hex): MempoolIntentRecord | undefined {
    // The stored record is deep-frozen, so returning it directly is safe: a
    // caller cannot mutate stored intent fields through it.
    return this.records.get(hash);
  }

  /**
   * Update a record's status. Refuses to move a record out of a terminal
   * status (`settled`/`refunded`/`expired`) — those are final.
   *
   * The stored record is frozen, so the status change is applied by replacing
   * the record with a new frozen copy rather than mutating in place. This stays
   * the only method that changes a record.
   */
  updateStatus(hash: Hex, status: IntentStatus): boolean {
    const record = this.records.get(hash);
    if (!record) return false;
    if (TERMINAL_STATUSES.has(record.status)) return false;
    this.indexRemove(hash, record.status);
    const updated = freezeRecord({ ...record, status });
    this.records.set(hash, updated);
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
      if (record) out.push(record);
    }
    return out;
  }

  size(): number {
    return this.records.size;
  }
}
