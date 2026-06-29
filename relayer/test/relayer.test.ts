import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../src/config.js";
import { Relayer } from "../src/relayer.js";
import type {
  DestinationDelivery,
  Logger,
  SourceWatcher,
} from "../src/relayer.js";
import type { CheckpointStore } from "../src/checkpoint.js";
import type { PendingMessage } from "../src/types.js";

/** In-memory checkpoint store standing in for a restart between two Relayer instances. */
function memoryCheckpointStore(): CheckpointStore {
  let saved: number | undefined;
  return {
    async load() {
      return saved;
    },
    async save(block) {
      saved = block;
    },
  };
}

const silent: Logger = { info() {}, warn() {}, error() {} };

function message(block: number): PendingMessage {
  return {
    srcTxHash: `0xtx${block}`,
    srcBlock: block,
    message: {
      srcEid: 30101,
      dstEid: 40161,
      intentHash: `0x${block.toString(16).padStart(64, "0")}`,
      solver: "0x0000000000000000000000000000000000000001",
      recipient: "GUSER",
      destAsset: "native",
      amount: "1000000",
      nonce: block,
    },
  };
}

test("delivers only messages past the confirmation depth", async () => {
  const config = { ...loadConfig(), confirmations: 6 };
  const watcher: SourceWatcher = {
    async poll() {
      // head=100; block 90 is final (90 <= 94), block 96 is not.
      return { messages: [message(90), message(96)], head: 100 };
    },
  };
  const delivered: string[] = [];
  const delivery: DestinationDelivery = {
    async deliver(p) {
      delivered.push(p.message.intentHash);
      return "0xdst";
    },
    async isDelivered() {
      return false;
    },
  };

  const relayer = new Relayer(config, watcher, delivery, silent);
  const results = await relayer.tick();

  assert.equal(results.length, 1);
  assert.equal(results[0]?.delivered, true);
  assert.equal(delivered.length, 1);
});

test("skips messages already delivered (replay guard)", async () => {
  const config = { ...loadConfig(), confirmations: 0 };
  const watcher: SourceWatcher = {
    async poll() {
      return { messages: [message(10)], head: 10 };
    },
  };
  const delivery: DestinationDelivery = {
    async deliver() {
      throw new Error("should not deliver");
    },
    async isDelivered() {
      return true;
    },
  };

  const relayer = new Relayer(config, watcher, delivery, silent);
  const results = await relayer.tick();
  assert.equal(results[0]?.delivered, false);
});

test("a restarted relayer resumes from the persisted checkpoint, not the start block", async () => {
  const config = { ...loadConfig(), confirmations: 0 };
  const checkpoint = memoryCheckpointStore();
  const polledFrom: number[] = [];
  const watcher: SourceWatcher = {
    async poll(fromBlock) {
      polledFrom.push(fromBlock);
      return { messages: [message(fromBlock)], head: fromBlock };
    },
  };
  const delivery: DestinationDelivery = {
    async deliver() {
      return "0xdst";
    },
    async isDelivered() {
      return false;
    },
  };

  // First process: boots from scratch (no checkpoint yet), advances to block 50, "crashes".
  const before = new Relayer(config, watcher, delivery, silent, 0, checkpoint);
  await before.resume();
  await before.tick(); // poll(0) -> head 0 -> cursor advances to 1, persisted.

  const advancing: SourceWatcher = {
    async poll(fromBlock) {
      polledFrom.push(fromBlock);
      return { messages: [message(fromBlock)], head: 50 };
    },
  };
  const stillRunning = new Relayer(config, advancing, delivery, silent, 0, checkpoint);
  await stillRunning.resume(); // resumes from the checkpoint (1), not startBlock (0).
  await stillRunning.tick(); // poll(1) -> head 50 -> cursor advances to 51, persisted.

  // Second process: a fresh Relayer instance (the "restart"), again with startBlock=0.
  const restarted = new Relayer(config, advancing, delivery, silent, 0, checkpoint);
  await restarted.resume();
  await restarted.tick();

  assert.deepEqual(polledFrom, [0, 1, 51]);
});
