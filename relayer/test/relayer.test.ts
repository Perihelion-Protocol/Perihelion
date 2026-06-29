import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../src/config.js";
import { Relayer } from "../src/relayer.js";
import type {
  DestinationDelivery,
  Logger,
  SourceWatcher,
} from "../src/relayer.js";
import type { PendingMessage } from "../src/types.js";

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

test("a chain shorter than the confirmation depth relays nothing and keeps a non-negative cursor", async () => {
  const config = { ...loadConfig(), confirmations: 6 };
  const polledFrom: number[] = [];
  const watcher: SourceWatcher = {
    async poll(fromBlock) {
      polledFrom.push(fromBlock);
      // head=3 < confirmations=6: nothing can be final yet.
      return { messages: [message(1), message(2)], head: 3 };
    },
  };
  const delivery: DestinationDelivery = {
    async deliver() {
      throw new Error("should not deliver");
    },
    async isDelivered() {
      return false;
    },
  };

  const relayer = new Relayer(config, watcher, delivery, silent);
  const results = await relayer.tick();
  await relayer.tick();

  assert.deepEqual(results, []);
  // Cursor never went negative across ticks (re-polled from the same non-negative point).
  assert.ok(polledFrom.every((b) => b >= 0));
  assert.deepEqual(polledFrom, [0, 0]);
});
