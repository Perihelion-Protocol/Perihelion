// SPDX-License-Identifier: MIT

/**
 * Tests for ReleasedWatcher: terminal-event mapping, confirmation depth and
 * cursor persistence. The escrow source and the mempool client are in-memory
 * fakes.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { Hex, PerihelionClient } from "@perihelion/sdk";
import {
  ReleasedWatcher,
  type CheckpointStore,
  type EscrowTerminalSource,
  type TerminalEvent,
} from "../src/released-watcher.js";

const HASH_A = ("0x" + "aa".repeat(32)) as Hex;
const HASH_B = ("0x" + "bb".repeat(32)) as Hex;
const TOKEN = "test-token";

function event(
  kind: TerminalEvent["kind"],
  intentHash: Hex,
  blockNumber: number,
  logIndex = 0,
): TerminalEvent {
  return { kind, intentHash, blockNumber, transactionHash: "0x01", logIndex };
}

/** Source over a fixed head and a fixed list of events. */
function fakeSource(state: { head: number; events: TerminalEvent[] }): EscrowTerminalSource {
  return {
    getBlockNumber: async () => state.head,
    getTerminalEvents: async (from, to) =>
      state.events.filter((e) => e.blockNumber >= from && e.blockNumber <= to),
  };
}

function fakeClient() {
  const calls: Array<{ hash: Hex; status: string; token: string }> = [];
  const client = {
    reportStatus: async (hash: Hex, status: string, token: string) => {
      calls.push({ hash, status, token });
    },
  } as unknown as PerihelionClient;
  return { client, calls };
}

function memoryCheckpoint(initial?: number): CheckpointStore & { saved: number[] } {
  let cursor = initial;
  const saved: number[] = [];
  return {
    saved,
    load: async () => cursor,
    save: async (block) => {
      cursor = block;
      saved.push(block);
    },
  };
}

test("maps Released to settled and both refund events to refunded", async () => {
  const state = {
    head: 10,
    events: [
      event("Released", HASH_A, 5, 0),
      event("Refunded", HASH_B, 6, 0),
      event("RefundedLocalTimeout", HASH_A, 7, 0),
    ],
  };
  // Start at block 0 so every event is in scope.
  const { client, calls } = fakeClient();
  const watcher = new ReleasedWatcher({
    source: fakeSource(state),
    client,
    statusToken: TOKEN,
    startBlock: 0,
  });

  const reported = await watcher.pollOnce();

  assert.equal(reported, 3);
  assert.deepEqual(
    calls.map((c) => [c.hash, c.status, c.token]),
    [
      [HASH_A, "settled", TOKEN],
      [HASH_B, "refunded", TOKEN],
      // Same intent refunded after a Released is a distinct status, so it is reported.
      [HASH_A, "refunded", TOKEN],
    ],
  );
});

test("does not report an intent twice for the same status", async () => {
  const state = { head: 10, events: [event("Released", HASH_A, 5)] };
  const { client, calls } = fakeClient();
  const watcher = new ReleasedWatcher({
    source: fakeSource(state),
    client,
    statusToken: TOKEN,
    startBlock: 0,
  });

  await watcher.pollOnce();
  await watcher.pollOnce();

  assert.equal(calls.length, 1);
});

test("confirmations: events shallower than the depth are deferred, not skipped", async () => {
  const state = { head: 100, events: [event("Released", HASH_A, 99)] };
  const { client, calls } = fakeClient();
  const watcher = new ReleasedWatcher({
    source: fakeSource(state),
    client,
    statusToken: TOKEN,
    startBlock: 90,
    confirmations: 3,
  });

  // Event at 99 has depth 2 at head 100: not yet reportable.
  assert.equal(await watcher.pollOnce(), 0);
  assert.equal(calls.length, 0);

  // At head 101 the event has depth 3: reported.
  state.head = 101;
  assert.equal(await watcher.pollOnce(), 1);
  assert.equal(calls[0]?.status, "settled");
});

test("confirmations must be a positive integer", () => {
  const { client } = fakeClient();
  assert.throws(
    () =>
      new ReleasedWatcher({
        source: fakeSource({ head: 0, events: [] }),
        client,
        statusToken: TOKEN,
        confirmations: 0,
      }),
    /confirmations must be an integer >= 1/,
  );
});

test("persists the cursor and resumes from it after a restart", async () => {
  const state = { head: 10, events: [event("Refunded", HASH_A, 4)] };
  const checkpoint = memoryCheckpoint();
  const first = fakeClient();
  const watcher = new ReleasedWatcher({
    source: fakeSource(state),
    client: first.client,
    statusToken: TOKEN,
    startBlock: 0,
    checkpoint,
  });
  await watcher.pollOnce();
  assert.equal(first.calls.length, 1);
  assert.equal(checkpoint.saved.at(-1), 11);

  // A new watcher with the saved cursor must not replay block 4.
  const second = fakeClient();
  const restarted = new ReleasedWatcher({
    source: fakeSource(state),
    client: second.client,
    statusToken: TOKEN,
    checkpoint,
  });
  state.head = 12;
  await restarted.pollOnce();
  assert.equal(second.calls.length, 0);
});
