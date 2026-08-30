// SPDX-License-Identifier: MIT

/**
 * Tests for {@link IntentStore}'s isolation guarantee: records handed back by
 * `get()` / `all()` must not be a route to mutating stored intent fields, since
 * the record's hash and signature commit to exactly those fields (#567).
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { IntentStore } from "../src/store.js";
import type { MempoolIntentRecord } from "../src/types.js";

const HASH = ("0x" + "ab".repeat(32)) as `0x${string}`;

function makeRecord(
  overrides: Partial<MempoolIntentRecord["intent"]> = {},
): MempoolIntentRecord {
  const now = Math.floor(Date.now() / 1000);
  return {
    hash: HASH,
    signature: ("0x" + "11".repeat(65)) as `0x${string}`,
    status: "pending",
    createdAt: now,
    intent: {
      user: "0x0000000000000000000000000000000000000001",
      destination: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
      sourceChainId: 8453,
      sourceAsset: "0x0000000000000000000000000000000000000002",
      sourceAmount: "1000000",
      destAsset: "native",
      minDestAmount: "990000",
      deadline: now + 3600,
      nonce: "1",
      preferredSolver: "0x0000000000000000000000000000000000000000",
      ...overrides,
    },
  } as MempoolIntentRecord;
}

test("a caller cannot mutate stored intent fields through a get() result (#567)", () => {
  const store = new IntentStore();
  store.set(HASH, makeRecord());

  const returned = store.get(HASH)!;
  assert.throws(() => {
    (returned.intent as { minDestAmount: string }).minDestAmount = "1";
  });

  assert.equal(
    store.get(HASH)!.intent.minDestAmount,
    "990000",
    "stored intent field is unchanged after an attempted mutation",
  );
});

test("mutating a returned record does not affect a subsequent get() (#567)", () => {
  const store = new IntentStore();
  store.set(HASH, makeRecord());

  const returned = store.get(HASH)!;
  try {
    (returned.intent as { sourceAmount: string }).sourceAmount = "999999999";
  } catch {
    // Frozen — a strict-mode assignment throws; that is the point.
  }

  assert.equal(store.get(HASH)!.intent.sourceAmount, "1000000");
});

test("all() results are frozen at the record and intent level (#567)", () => {
  const store = new IntentStore();
  store.set(HASH, makeRecord());

  const [record] = store.all();
  assert.ok(record && Object.isFrozen(record), "record is frozen");
  assert.ok(Object.isFrozen(record.intent), "nested intent is frozen");
});

test("updateStatus stays the only path that changes a record (#567)", () => {
  const store = new IntentStore();
  store.set(HASH, makeRecord());

  const returned = store.get(HASH)!;
  assert.throws(() => {
    (returned as { status: string }).status = "settled";
  }, "status cannot be changed through a returned record");
  assert.equal(store.get(HASH)!.status, "pending");

  assert.equal(store.updateStatus(HASH, "settled"), true);
  const updated = store.get(HASH)!;
  assert.equal(updated.status, "settled");
  assert.ok(Object.isFrozen(updated), "the replacement record is frozen too");
  assert.notEqual(updated, returned, "updateStatus swapped in a new record object");
});

test("updateStatus still refuses to leave a terminal status (#567)", () => {
  const store = new IntentStore();
  store.set(HASH, makeRecord());

  assert.equal(store.updateStatus(HASH, "settled"), true);
  assert.equal(store.updateStatus(HASH, "pending"), false, "terminal status is final");
  assert.equal(store.get(HASH)!.status, "settled");
});
