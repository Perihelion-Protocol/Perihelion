// SPDX-License-Identifier: MIT

/**
 * Unit tests for `IntentStore`'s operational bounds and single-pass listing:
 *
 * - Status-aware eviction (#565): when the store is full, a terminal record is
 *   dropped before a `pending` one, and a store with no terminal records still
 *   makes room by evicting the oldest.
 * - `list()` (#564): filtering and pagination happen in one pass so a list
 *   request does not copy the whole store.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { Hex } from "@perihelion/sdk";
import { IntentStore } from "../src/store.js";
import type { IntentStatus, MempoolIntentRecord } from "../src/types.js";

function record(
  id: string,
  status: IntentStatus,
  sourceChainId = 1,
): MempoolIntentRecord {
  const hash = `0x${id.padStart(64, "0")}` as Hex;
  return {
    hash,
    intent: { sourceChainId } as MempoolIntentRecord["intent"],
    signature: "0x00" as Hex,
    status,
    createdAt: 0,
  };
}

/** Insert a record keyed by its own hash, mirroring how the server calls `set`. */
function put(store: IntentStore, r: MempoolIntentRecord): void {
  store.set(r.hash, r);
}

test("maxSize is honoured — the store never exceeds the configured bound", () => {
  const store = new IntentStore({ maxSize: 3 });
  for (let i = 0; i < 10; i++) put(store, record(`a${i}`, "pending"));
  assert.equal(store.size(), 3);
});

test("eviction prefers the oldest terminal record over a pending one", () => {
  const store = new IntentStore({ maxSize: 3 });

  put(store, record("1", "settled")); // oldest, terminal
  put(store, record("2", "pending"));
  put(store, record("3", "pending"));

  // Full. Inserting a fourth must evict the terminal record, not a pending one.
  put(store, record("4", "pending"));

  assert.equal(store.size(), 3);
  assert.equal(store.get(record("1", "settled").hash), undefined, "terminal record evicted");
  assert.ok(store.get(record("2", "pending").hash), "older pending record retained");
  assert.ok(store.get(record("4", "pending").hash), "new pending record inserted");
});

test("eviction falls back to the oldest record when none are terminal", () => {
  const store = new IntentStore({ maxSize: 2 });

  put(store, record("1", "pending"));
  put(store, record("2", "pending"));
  put(store, record("3", "pending"));

  assert.equal(store.size(), 2);
  assert.equal(store.get(record("1", "pending").hash), undefined, "oldest pending evicted");
  assert.ok(store.get(record("2", "pending").hash));
  assert.ok(store.get(record("3", "pending").hash));
});

test("list() filters by chainId and paginates in a single pass", () => {
  const store = new IntentStore({ maxSize: 100 });
  put(store, record("1", "pending", 10));
  put(store, record("2", "pending", 20));
  put(store, record("3", "pending", 10));
  put(store, record("4", "pending", 10));

  const first = store.list({ chainId: 10, limit: 2 });
  assert.equal(first.records.length, 2);
  assert.ok(first.records.every((r) => r.intent.sourceChainId === 10));
  assert.equal(first.nextCursor, first.records[1].hash);

  const second = store.list({ chainId: 10, limit: 2, cursor: first.nextCursor });
  assert.equal(second.records.length, 1);
  assert.equal(second.records[0].intent.sourceChainId, 10);
  assert.equal(second.nextCursor, undefined, "last page has no cursor");
});

test("list() honours the status index", () => {
  const store = new IntentStore({ maxSize: 100 });
  put(store, record("1", "pending"));
  put(store, record("2", "settled"));
  put(store, record("3", "pending"));

  const pending = store.list({ status: "pending", limit: 10 });
  assert.equal(pending.records.length, 2);
  assert.ok(pending.records.every((r) => r.status === "pending"));
});
