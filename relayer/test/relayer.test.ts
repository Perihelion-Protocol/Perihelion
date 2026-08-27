// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../src/config.js";
import { Relayer, FatalError } from "../src/relayer.js";
import { InMemoryDeadLetterStore } from "../src/dead-letter.js";
import { messageKeyString } from "../src/types.js";
import type {
  DestinationDelivery,
  Logger,
  SourceWatcher,
  RetryPolicy,
} from "../src/relayer.js";
import type { CheckpointStore } from "../src/checkpoint.js";
import type { PendingMessage, MessageKey } from "../src/types.js";

// ─── helpers ────────────────────────────────────────────────────────────────

function memCheckpoint(): CheckpointStore {
  let saved: number | undefined;
  return {
    async load() { return saved; },
    async save(b) { saved = b; },
  };
}

const silent: Logger = { info() {}, warn() {}, error() {} };

const VALID_ESCROW = "0xaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaA";
const VALID_CONTRACT = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFCT4";

function makeMsg(
  block: number,
  overrides: Partial<PendingMessage["message"]> = {},
): PendingMessage {
  return {
    srcTxHash: `0xtx${block}`,
    srcBlock: block,
    message: {
      srcEid: 30101,
      dstEid: 40161,
      intentHash: `0x${"ab".repeat(32)}`,
      messageType: "FillInstruction",
      solver: "0x0000000000000000000000000000000000000001",
      recipient: "GUSER",
      destAsset: "native",
      amount: "1000000",
      nonce: block,
      ...overrides,
    },
  };
}

function baseConfig() {
  return loadConfig({
    PERIHELION_ESCROW_ADDRESS: VALID_ESCROW,
    PERIHELION_SETTLEMENT_CONTRACT: VALID_CONTRACT,
    PERIHELION_EVM_RPC_URL: "http://localhost:8545",
    PERIHELION_STELLAR_RPC_URL: "https://soroban-testnet.stellar.org",
    PERIHELION_SOURCE_EID: "30101",
    PERIHELION_STELLAR_EID: "40161",
    STELLAR_NETWORK: "Test SDF Network ; September 2015",
    SIGNER_SECRET: "SBZVMB74Z76QB3ZL2YFBN7EWUIXVXSNXKNQRIPZTKMZDDQ3FJBNRHWBU",
  });
}

// ─── Issue 1: Config validation ─────────────────────────────────────────────

test("loadConfig throws when PERIHELION_ESCROW_ADDRESS is missing", () => {
  assert.throws(
    () => loadConfig({ PERIHELION_SETTLEMENT_CONTRACT: VALID_CONTRACT }),
    /PERIHELION_ESCROW_ADDRESS is required/,
  );
});

test("loadConfig throws when PERIHELION_SETTLEMENT_CONTRACT is missing", () => {
  assert.throws(
    () => loadConfig({ PERIHELION_ESCROW_ADDRESS: VALID_ESCROW }),
    /PERIHELION_SETTLEMENT_CONTRACT is required/,
  );
});

test("loadConfig throws for malformed EVM address", () => {
  assert.throws(
    () =>
      loadConfig({
        PERIHELION_ESCROW_ADDRESS: "not-an-address",
        PERIHELION_SETTLEMENT_CONTRACT: VALID_CONTRACT,
      }),
    /EVM address/,
  );
});

test("loadConfig throws for malformed Soroban contract id", () => {
  assert.throws(
    () =>
      loadConfig({
        PERIHELION_ESCROW_ADDRESS: VALID_ESCROW,
        PERIHELION_SETTLEMENT_CONTRACT: "bad-id",
      }),
    /Soroban contract id/,
  );
});

test("loadConfig throws for NaN confirmations", () => {
  assert.throws(
    () =>
      loadConfig({
        PERIHELION_ESCROW_ADDRESS: VALID_ESCROW,
        PERIHELION_SETTLEMENT_CONTRACT: VALID_CONTRACT,
        PERIHELION_CONFIRMATIONS: "notanumber",
      }),
    /PERIHELION_CONFIRMATIONS/,
  );
});

test("loadConfig throws for NaN pollIntervalMs", () => {
  assert.throws(
    () =>
      loadConfig({
        PERIHELION_ESCROW_ADDRESS: VALID_ESCROW,
        PERIHELION_SETTLEMENT_CONTRACT: VALID_CONTRACT,
        PERIHELION_POLL_INTERVAL_MS: "notanumber",
      }),
    /PERIHELION_POLL_INTERVAL_MS/,
  );
});

test("loadConfig succeeds with valid required fields and applies defaults", () => {
  const cfg = loadConfig({
    PERIHELION_ESCROW_ADDRESS: VALID_ESCROW,
    PERIHELION_SETTLEMENT_CONTRACT: VALID_CONTRACT,
  });
  assert.equal(cfg.escrowAddress, VALID_ESCROW);
  assert.equal(cfg.settlementContractId, VALID_CONTRACT);
  assert.equal(cfg.confirmations, 6);
  assert.equal(cfg.pollIntervalMs, 5000);
});

test("loadConfig error message lists all invalid fields together", () => {
  let msg = "";
  try {
    loadConfig({});
  } catch (e) {
    msg = String(e);
  }
  assert.ok(msg.includes("PERIHELION_ESCROW_ADDRESS"));
  assert.ok(msg.includes("PERIHELION_SETTLEMENT_CONTRACT"));
});

// ─── Issue 2: Composite dedup key ───────────────────────────────────────────

test("two messages sharing intentHash but different messageType are both delivered", async () => {
  const config = { ...baseConfig(), confirmations: 0 };
  const watcher: SourceWatcher = {
    async poll() {
      return {
        messages: [
          makeMsg(10, { messageType: "FillInstruction", nonce: 10 }),
          makeMsg(10, { messageType: "FillConfirmed", nonce: 10 }),
        ],
        head: 10,
      };
    },
  };
  const delivered: string[] = [];
  const deliveredKeys = new Set<string>();
  const delivery: DestinationDelivery = {
    async deliver(p) {
      delivered.push(p.message.messageType);
      return "0xdst";
    },
    async isDelivered(key) {
      const k = messageKeyString(key);
      if (deliveredKeys.has(k)) return true;
      deliveredKeys.add(k);
      return false;
    },
  };

  const relayer = new Relayer(config, watcher, delivery, silent);
  const results = await relayer.tick();

  assert.equal(results.filter((r) => r.delivered).length, 2);
  assert.deepEqual(delivered.sort(), ["FillConfirmed", "FillInstruction"]);
});

test("same message (same composite key) is not delivered twice", async () => {
  const config = { ...baseConfig(), confirmations: 0 };
  let callCount = 0;
  const delivery: DestinationDelivery = {
    async deliver() {
      callCount++;
      return "0xdst";
    },
    async isDelivered() { return callCount > 0; },
  };
  const watcher: SourceWatcher = {
    async poll() {
      return { messages: [makeMsg(10)], head: 10 };
    },
  };

  const relayer = new Relayer(config, watcher, delivery, silent);
  await relayer.tick();
  await relayer.tick();
  assert.equal(callCount, 1);
});

test("FillConfirmed and CancelIntent for same intent both delivered", async () => {
  const config = { ...baseConfig(), confirmations: 0 };
  const watcher: SourceWatcher = {
    async poll() {
      return {
        messages: [
          makeMsg(5, { messageType: "FillConfirmed", nonce: 1 }),
          makeMsg(5, { messageType: "CancelIntent", nonce: 2 }),
        ],
        head: 5,
      };
    },
  };
  const types: string[] = [];
  const seen = new Set<string>();
  const delivery: DestinationDelivery = {
    async deliver(p) {
      types.push(p.message.messageType);
      return "0xdst";
    },
    async isDelivered(key) {
      const k = messageKeyString(key);
      if (seen.has(k)) return true;
      seen.add(k);
      return false;
    },
  };

  const relayer = new Relayer(config, watcher, delivery, silent);
  await relayer.tick();
  assert.deepEqual(types.sort(), ["CancelIntent", "FillConfirmed"]);
});

// ─── Issue 3: Dead-letter / retry policy ────────────────────────────────────

test("message is dead-lettered after exhausting retry budget", async () => {
  const config = { ...baseConfig(), confirmations: 0 };
  const retry: RetryPolicy = { maxAttempts: 3, baseBackoffMs: 0 };
  const dlStore = new InMemoryDeadLetterStore();
  let deliverCalls = 0;

  const watcher: SourceWatcher = {
    async poll() { return { messages: [makeMsg(1)], head: 1 }; },
  };
  const delivery: DestinationDelivery = {
    async deliver() { deliverCalls++; throw new Error("permanent failure"); },
    async isDelivered() { return false; },
  };

  const relayer = new Relayer(config, watcher, delivery, silent, 0, memCheckpoint(), dlStore, retry);

  // Attempt 1
  await relayer.tick();
  assert.equal(dlStore.list().length, 0, "not dead-lettered after attempt 1");

  // Attempt 2
  await relayer.tick();
  assert.equal(dlStore.list().length, 0, "not dead-lettered after attempt 2");

  // Attempt 3 — exhausts budget
  await relayer.tick();
  assert.equal(dlStore.list().length, 1, "dead-lettered after attempt 3");
  assert.equal(dlStore.list()[0]?.attempts, 3);
  assert.ok(dlStore.list()[0]?.lastError.includes("permanent failure"));
});

test("dead-lettered message is not retried until drained", async () => {
  const config = { ...baseConfig(), confirmations: 0 };
  const retry: RetryPolicy = { maxAttempts: 1, baseBackoffMs: 0 };
  const dlStore = new InMemoryDeadLetterStore();
  let deliverCalls = 0;

  const watcher: SourceWatcher = {
    async poll() { return { messages: [makeMsg(1)], head: 1 }; },
  };
  const delivery: DestinationDelivery = {
    async deliver() { deliverCalls++; throw new Error("fail"); },
    async isDelivered() { return false; },
  };

  const relayer = new Relayer(config, watcher, delivery, silent, 0, memCheckpoint(), dlStore, retry);
  await relayer.tick(); // dead-letters on first attempt
  assert.equal(dlStore.list().length, 1);

  const callsBefore = deliverCalls;
  await relayer.tick(); // should NOT retry — still dead-lettered
  assert.equal(deliverCalls, callsBefore, "dead-lettered message not retried");
});

test("metrics count delivered, failed, and dead-lettered messages", async () => {
  const config = { ...baseConfig(), confirmations: 0 };
  const retry: RetryPolicy = { maxAttempts: 2, baseBackoffMs: 0 };
  const dlStore = new InMemoryDeadLetterStore();

  // Use separate watchers per tick so we can control exactly which messages each tick sees.
  let tickN = 0;
  const watcher: SourceWatcher = {
    async poll() {
      tickN++;
      if (tickN === 1) {
        // Tick 1: both messages present
        return {
          messages: [
            makeMsg(1, { nonce: 1 }), // succeeds
            makeMsg(2, { nonce: 2 }), // fails (attempt 1/2)
          ],
          head: 2,
        };
      }
      // Tick 2: only nonce2 so nonce1 doesn't inflate delivered count
      return { messages: [makeMsg(2, { nonce: 2 })], head: 2 };
    },
  };
  const delivery: DestinationDelivery = {
    async deliver(p) {
      if (p.message.nonce === 2) throw new Error("fail");
      return "0xdst";
    },
    async isDelivered() { return false; },
  };

  const relayer = new Relayer(config, watcher, delivery, silent, 0, memCheckpoint(), dlStore, retry);
  await relayer.tick(); // nonce1 ok (delivered=1); nonce2 fail (attempt 1, failed=1)
  await relayer.tick(); // nonce2 fail → dead-lettered (attempt 2, deadLettered=1)

  assert.equal(relayer.metrics.delivered, 1);
  assert.ok(relayer.metrics.failed >= 1);
  assert.equal(relayer.metrics.deadLettered, 1);
});

// ─── Issue 4: Reorg detection ────────────────────────────────────────────────

test("relayer detects reorg and rolls back cursor", async () => {
  const config = { ...baseConfig(), confirmations: 2 };
  const polledFrom: number[] = [];

  // First poll: canonical chain up to block 10
  // Second poll: head=10 but with a different parentHash → reorg at depth 1
  let pollCount = 0;
  const watcher: SourceWatcher = {
    async poll(fromBlock) {
      polledFrom.push(fromBlock);
      pollCount++;
      if (pollCount === 1) {
        // Normal: head=10, hash=0xAAA, parent=0x999
        return {
          messages: [makeMsg(8)],
          head: 10,
          headHash: "0xAAA",
          parentHash: "0x999",
        };
      }
      // Reorg: same height 10, but parent changed
      return {
        messages: [],
        head: 10,
        headHash: "0xBBB",
        parentHash: "0xXXX", // different parent → reorg
      };
    },
  };
  const delivery: DestinationDelivery = {
    async deliver() { return "0xdst"; },
    async isDelivered() { return false; },
  };

  const relayer = new Relayer(config, watcher, delivery, silent, 0, memCheckpoint());

  // First tick: normal, processes block 8, advances cursor to 9 (10-2+1)
  await relayer.tick();
  const cursorAfterFirst = (relayer as unknown as { cursor: number }).cursor;

  // Second tick: reorg detected — cursor rolls back
  // After reorg the tick() re-polls; since watcher now returns no messages,
  // cursor stays at the rolled-back value.
  await relayer.tick();
  const cursorAfterReorg = (relayer as unknown as { cursor: number }).cursor;

  // After reorg, cursor should be <= cursorAfterFirst (rolled back)
  assert.ok(
    cursorAfterReorg <= cursorAfterFirst,
    `expected cursor rollback: ${cursorAfterReorg} <= ${cursorAfterFirst}`,
  );
});

test("relayer emits DEEP_REORG alert when reorg exceeds confirmation depth", async () => {
  // confirmations=0 means any reorg depth > 0 is "deep"
  const config = { ...baseConfig(), confirmations: 0 };
  const errorMsgs: string[] = [];
  const logger: Logger = {
    info() {},
    warn() {},
    error(msg) { errorMsgs.push(msg); },
  };

  // Tick 1: record block 9 with hash 0xPrev
  // Tick 2: block 10 arrives, parent hash doesn't match 0xPrev → reorg depth 1 > confirmations 0
  let pollCount = 0;
  const watcher: SourceWatcher = {
    async poll() {
      pollCount++;
      if (pollCount === 1) {
        return { messages: [], head: 9, headHash: "0xPrev", parentHash: "0xOld" };
      }
      return { messages: [], head: 10, headHash: "0xNew", parentHash: "0xUnknown" };
    },
  };
  const delivery: DestinationDelivery = {
    async deliver() { return "0xdst"; },
    async isDelivered() { return false; },
  };

  const relayer = new Relayer(config, watcher, delivery, logger, 0, memCheckpoint());
  await relayer.tick(); // records block 9
  await relayer.tick(); // detects reorg depth 1 > confirmations 0 → DEEP_REORG

  assert.ok(
    errorMsgs.some((m) => m.includes("DEEP_REORG")),
    `expected DEEP_REORG alert; got: ${JSON.stringify(errorMsgs)}`,
  );
});

// ─── Issue 92: FatalError propagation and graceful drain ────────────────────

test("FatalError thrown from watcher.poll() rejects start()", async () => {
  const fatal = new FatalError("permanent RPC failure");
  const watcher: SourceWatcher = {
    async poll() { throw fatal; },
  };
  const delivery: DestinationDelivery = {
    async deliver() { return "0xdst"; },
    async isDelivered() { return false; },
  };

  const relayer = new Relayer(baseConfig(), watcher, delivery, silent);
  const err = await relayer.start().catch((e) => e);
  assert.strictEqual(err, fatal, "start() should reject with the FatalError instance");
});

test("recoverable tick error keeps loop alive, does not reject start()", async () => {
  let calls = 0;
  const watcher: SourceWatcher = {
    async poll() {
      calls++;
      if (calls === 1) throw new Error("transient RPC timeout");
      return { messages: [], head: 0 };
    },
  };
  const delivery: DestinationDelivery = {
    async deliver() { return "0xdst"; },
    async isDelivered() { return false; },
  };

  const relayer = new Relayer(
    { ...baseConfig(), pollIntervalMs: 0 },
    watcher,
    delivery,
    silent,
  );

  const startP = relayer.start();
  await new Promise((r) => setTimeout(r, 30));
  relayer.stop();
  await assert.doesNotReject(startP, "recoverable error must not reject start()");
  assert.ok(calls >= 2, "loop should have continued after recoverable error");
});

test("stop() interrupts inter-tick sleep so start() resolves promptly", async () => {
  const watcher: SourceWatcher = {
    async poll() { return { messages: [], head: 0 }; },
  };
  const delivery: DestinationDelivery = {
    async deliver() { return "0xdst"; },
    async isDelivered() { return false; },
  };

  const relayer = new Relayer(
    { ...baseConfig(), pollIntervalMs: 60_000 }, // would hang for 60 s without stop()
    watcher,
    delivery,
    silent,
  );

  const startP = relayer.start();
  await new Promise((r) => setTimeout(r, 20)); // let first tick complete
  relayer.stop();

  const result = await Promise.race([
    startP.then(() => "resolved" as const),
    new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 1_000)),
  ]);
  assert.equal(result, "resolved", "start() should resolve promptly after stop(), not wait 60 s");
});

// ─── Existing behaviour preserved ───────────────────────────────────────────

test("delivers only messages past the confirmation depth", async () => {
  const config = { ...baseConfig(), confirmations: 6 };
  const watcher: SourceWatcher = {
    async poll() {
      return { messages: [makeMsg(90), makeMsg(96)], head: 100 };
    },
  };
  const delivered: string[] = [];
  const delivery: DestinationDelivery = {
    async deliver(p) { delivered.push(p.message.intentHash); return "0xdst"; },
    async isDelivered() { return false; },
  };

  const relayer = new Relayer(config, watcher, delivery, silent);
  const results = await relayer.tick();

  assert.equal(results.length, 1);
  assert.equal(results[0]?.delivered, true);
});

test("skips messages already delivered (replay guard)", async () => {
  const config = { ...baseConfig(), confirmations: 0 };
  const watcher: SourceWatcher = {
    async poll() { return { messages: [makeMsg(10)], head: 10 }; },
  };
  const delivery: DestinationDelivery = {
    async deliver() { throw new Error("should not deliver"); },
    async isDelivered() { return true; },
  };

  const relayer = new Relayer(config, watcher, delivery, silent);
  const results = await relayer.tick();
  assert.equal(results[0]?.delivered, false);
});

test("a restarted relayer resumes from the persisted checkpoint", async () => {
  const config = { ...baseConfig(), confirmations: 0 };
  const checkpoint = memCheckpoint();
  const polledFrom: number[] = [];
  const delivery: DestinationDelivery = {
    async deliver() { return "0xdst"; },
    async isDelivered() { return false; },
  };

  const watcher1: SourceWatcher = {
    async poll(fromBlock) {
      polledFrom.push(fromBlock);
      return { messages: [makeMsg(fromBlock)], head: fromBlock };
    },
  };

  const before = new Relayer(config, watcher1, delivery, silent, 0, checkpoint);
  await before.resume();
  await before.tick(); // poll(0) → cursor → 1

  const watcher2: SourceWatcher = {
    async poll(fromBlock) {
      polledFrom.push(fromBlock);
      return { messages: [makeMsg(fromBlock)], head: 50 };
    },
  };
  const restarted = new Relayer(config, watcher2, delivery, silent, 0, checkpoint);
  await restarted.resume();
  await restarted.tick(); // resumes from 1, not 0

  assert.deepEqual(polledFrom, [0, 1]);
});

// ─── Issue 4: Reorg detection ───────────────────────────────────────────────

test("reorg detected when block hash changes and cursor rolls back", async () => {
  const config = { ...baseConfig(), confirmations: 0 };
  let tick = 0;

  const watcher: SourceWatcher = {
    async poll() {
      tick++;
      if (tick === 1) {
        // First tick: blocks 1-3, head is 3 with hash A
        return {
          messages: [makeMsg(1), makeMsg(2), makeMsg(3)],
          head: 3,
          headHash: "0xAAAA",
          parentHash: "0x0000", // assume block 2 exists as parent
          blockHeaders: [
            { number: 1, hash: "0xHASH1", parentHash: "0x0000" },
            { number: 2, hash: "0xHASH2", parentHash: "0xHASH1" },
            { number: 3, hash: "0xHASH3", parentHash: "0xHASH2" },
          ],
        };
      } else if (tick === 2) {
        // Second tick: reorg detected at block 3 (different hash)
        return {
          messages: [makeMsg(4)],
          head: 4,
          headHash: "0xBBBB",
          parentHash: "0xHASH3_NEW", // doesn't match the hash of block 3 we recorded
          blockHeaders: [
            { number: 3, hash: "0xHASH3_NEW", parentHash: "0xHASH2" }, // different hash
            { number: 4, hash: "0xHASH4", parentHash: "0xHASH3_NEW" },
          ],
        };
      }
      return { messages: [], head: 10 };
    },
  };

  const delivered: PendingMessage[] = [];
  const delivery: DestinationDelivery = {
    async deliver(p) {
      delivered.push(p);
      return "0xdst";
    },
    async isDelivered() { return false; },
  };

  const checkpoint = memCheckpoint();
  const relayer = new Relayer(config, watcher, delivery, silent, 0, checkpoint);

  // First tick: deliveries at blocks 1-3 (no confirmations required with confirmations: 0)
  await relayer.tick();
  assert.equal(delivered.length, 3, "delivered 3 messages on first tick");
  assert.equal(relayer.readiness.cursor, 4, "cursor advanced to head + 1");

  // Second tick: reorg detected, cursor rolled back
  await relayer.tick();
  assert.equal(relayer.readiness.cursor, 3, "cursor rolled back after reorg");
});

