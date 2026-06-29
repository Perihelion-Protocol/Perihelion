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

test("a delivery failure does not advance the cursor past the failed message, and it is retried", async () => {
  const config = { ...loadConfig(), confirmations: 0 };
  const watcher: SourceWatcher = {
    async poll(fromBlock) {
      void fromBlock;
      return { messages: [message(10), message(11)], head: 11 };
    },
  };
  let attempts = 0;
  const delivered: string[] = [];
  const delivery: DestinationDelivery = {
    async deliver(p) {
      if (p.message.intentHash === message(10).message.intentHash) {
        attempts++;
        if (attempts === 1) throw new Error("network blip");
      }
      delivered.push(p.message.intentHash);
      return "0xdst";
    },
    async isDelivered() {
      return false;
    },
  };

  const relayer = new Relayer(config, watcher, delivery, silent);

  const first = await relayer.tick();
  assert.equal(first.find((r) => r.intentHash === message(10).message.intentHash)?.delivered, false);
  // Block 11 still delivered even though block 10 failed.
  assert.ok(delivered.includes(message(11).message.intentHash));

  const second = await relayer.tick();
  assert.equal(second.find((r) => r.intentHash === message(10).message.intentHash)?.delivered, true);
  assert.equal(delivered.filter((h) => h === message(10).message.intentHash).length, 1);
});
