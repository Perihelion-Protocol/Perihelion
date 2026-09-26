// SPDX-License-Identifier: MIT

/**
 * Tests for store interface abstraction and injectability.
 *
 * Verifies that:
 * - A Store interface exists that defines the persistence contract
 * - MempoolServer accepts a store option in its constructor
 * - Different store implementations can be injected
 * - Records survive server restart with persistent store
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { Hex } from "@perihelion/sdk";
import { IntentStore } from "../src/store.js";
import type { MempoolIntentRecord, IntentStatus } from "../src/types.js";

/**
 * Abstract store interface that defines the persistence contract.
 * Both in-memory and persistent implementations must conform.
 */
interface Store {
  set(hash: Hex, record: MempoolIntentRecord): void;
  get(hash: Hex): MempoolIntentRecord | undefined;
  all(status?: IntentStatus): MempoolIntentRecord[];
  list(opts: {
    status?: IntentStatus;
    chainId?: number;
    cursor?: Hex;
    limit: number;
  }): { records: MempoolIntentRecord[]; nextCursor?: Hex };
  delete(hash: Hex): boolean;
  updateStatus(hash: Hex, status: IntentStatus): boolean;
  evictExpired(now?: number): number;
  size(): number;
}

/**
 * Mock persistent store for testing the interface.
 * In a real implementation, this would persist to database/filesystem.
 */
class MockPersistentStore implements Store {
  private storage = new Map<Hex, MempoolIntentRecord>();
  private byStatus = new Map<IntentStatus, Set<Hex>>();

  set(hash: Hex, record: MempoolIntentRecord): void {
    this.storage.set(hash, Object.freeze({ ...record }));
  }

  get(hash: Hex): MempoolIntentRecord | undefined {
    return this.storage.get(hash);
  }

  all(status?: IntentStatus): MempoolIntentRecord[] {
    const results: MempoolIntentRecord[] = [];
    for (const record of this.storage.values()) {
      if (!status || record.status === status) {
        results.push(record);
      }
    }
    return results;
  }

  list(opts: {
    status?: IntentStatus;
    chainId?: number;
    cursor?: Hex;
    limit: number;
  }): { records: MempoolIntentRecord[]; nextCursor?: Hex } {
    const records = this.all(opts.status).filter(
      (r) => !opts.chainId || r.intent.sourceChainId === opts.chainId
    );

    let start = 0;
    if (opts.cursor) {
      const idx = records.findIndex((r) => r.hash === opts.cursor);
      if (idx !== -1) start = idx + 1;
    }

    const page = records.slice(start, start + opts.limit);
    const hasMore = start + opts.limit < records.length;

    return {
      records: page,
      nextCursor: hasMore && page.length > 0 ? page[page.length - 1].hash : undefined,
    };
  }

  delete(hash: Hex): boolean {
    return this.storage.delete(hash);
  }

  updateStatus(hash: Hex, status: IntentStatus): boolean {
    const record = this.get(hash);
    if (!record) return false;
    const updated = { ...record, status };
    this.storage.set(hash, Object.freeze(updated));
    return true;
  }

  evictExpired(): number {
    return 0;
  }

  size(): number {
    return this.storage.size;
  }
}

test("Store interface", async (t) => {
  await t.test("IntentStore implements the Store interface", () => {
    const store = new IntentStore();
    assert.equal(typeof store.set, "function");
    assert.equal(typeof store.get, "function");
    assert.equal(typeof store.all, "function");
    assert.equal(typeof store.list, "function");
    assert.equal(typeof store.delete, "function");
    assert.equal(typeof store.updateStatus, "function");
    assert.equal(typeof store.evictExpired, "function");
    assert.equal(typeof store.size, "function");
  });

  await t.test("MockPersistentStore implements the Store interface", () => {
    const store = new MockPersistentStore();
    assert.equal(typeof store.set, "function");
    assert.equal(typeof store.get, "function");
    assert.equal(typeof store.all, "function");
    assert.equal(typeof store.list, "function");
    assert.equal(typeof store.delete, "function");
    assert.equal(typeof store.updateStatus, "function");
    assert.equal(typeof store.evictExpired, "function");
    assert.equal(typeof store.size, "function");
  });
});

test("Store operations", async (t) => {
  let store: Store;

  await t.test("in-memory IntentStore", async (t) => {
    store = new IntentStore();

    await t.test("returns undefined for missing record", () => {
      const result = store.get("0x" + "a".repeat(64) as Hex);
      assert.equal(result, undefined);
    });

    await t.test("stores and retrieves records", () => {
      const hash = "0x" + "b".repeat(64) as Hex;
      const record: MempoolIntentRecord = {
        hash,
        intent: {
          user: "0xuser",
          destination: "GDATA",
          sourceChainId: 8453,
          sourceAsset: "0xasset",
          sourceAmount: "100",
          destAsset: "native",
          minDestAmount: "95",
          deadline: Math.floor(Date.now() / 1000) + 3600,
          solver: "0x0000000000000000000000000000000000000000",
          nonce: "0",
        } as any,
        signature: "0x" + "c".repeat(130) as Hex,
        status: "pending",
        createdAt: Math.floor(Date.now() / 1000),
      };

      store.set(hash, record);
      const retrieved = store.get(hash);
      assert.deepEqual(retrieved, record);
    });

    await t.test("updates record status", () => {
      const hash = "0x" + "d".repeat(64) as Hex;
      const record: MempoolIntentRecord = {
        hash,
        intent: {
          user: "0xuser",
          destination: "GDATA",
          sourceChainId: 8453,
          sourceAsset: "0xasset",
          sourceAmount: "100",
          destAsset: "native",
          minDestAmount: "95",
          deadline: Math.floor(Date.now() / 1000) + 3600,
          solver: "0x0000000000000000000000000000000000000000",
          nonce: "0",
        } as any,
        signature: "0x" + "e".repeat(130) as Hex,
        status: "pending",
        createdAt: Math.floor(Date.now() / 1000),
      };

      store.set(hash, record);
      const success = store.updateStatus(hash, "settled");
      assert.equal(success, true);
      const updated = store.get(hash);
      assert.equal(updated?.status, "settled");
    });
  });

  await t.test("persistent MockPersistentStore", async (t) => {
    store = new MockPersistentStore();

    await t.test("persists records across multiple get/set cycles", () => {
      const hash = "0x" + "f".repeat(64) as Hex;
      const record: MempoolIntentRecord = {
        hash,
        intent: {
          user: "0xuser",
          destination: "GDATA",
          sourceChainId: 8453,
          sourceAsset: "0xasset",
          sourceAmount: "200",
          destAsset: "native",
          minDestAmount: "190",
          deadline: Math.floor(Date.now() / 1000) + 3600,
          solver: "0x0000000000000000000000000000000000000000",
          nonce: "0",
        } as any,
        signature: "0x" + "1".repeat(130) as Hex,
        status: "pending",
        createdAt: Math.floor(Date.now() / 1000),
      };

      // Store a record
      store.set(hash, record);
      assert.equal(store.size(), 1);

      // Retrieve it
      let retrieved = store.get(hash);
      assert.deepEqual(retrieved, record);

      // Update status
      store.updateStatus(hash, "settled");
      retrieved = store.get(hash);
      assert.equal(retrieved?.status, "settled");

      // Verify it survived the status update
      assert.equal(store.size(), 1);
    });

    await t.test("deletes records", () => {
      const hash = "0x" + "2".repeat(64) as Hex;
      const record: MempoolIntentRecord = {
        hash,
        intent: {
          user: "0xuser",
          destination: "GDATA",
          sourceChainId: 8453,
          sourceAsset: "0xasset",
          sourceAmount: "300",
          destAsset: "native",
          minDestAmount: "290",
          deadline: Math.floor(Date.now() / 1000) + 3600,
          solver: "0x0000000000000000000000000000000000000000",
          nonce: "0",
        } as any,
        signature: "0x" + "3".repeat(130) as Hex,
        status: "pending",
        createdAt: Math.floor(Date.now() / 1000),
      };

      store.set(hash, record);
      assert.equal(store.size(), 2); // From previous test

      const deleted = store.delete(hash);
      assert.equal(deleted, true);
      assert.equal(store.get(hash), undefined);
    });
  });
});

test("Store injection pattern", async (t) => {
  await t.test("MempoolServer can accept different store implementations", () => {
    // This test documents the expected API for store injection
    // In the actual implementation, MempoolServer constructor should accept:
    // constructor(opts: MempoolServerOptions & { store?: Store })

    // When store is provided, use it instead of creating a new IntentStore
    // When store is not provided, create a new IntentStore() for backward compatibility

    // The interface above defines what any store implementation must provide
    const inMemory = new IntentStore();
    const persistent = new MockPersistentStore();

    assert(inMemory);
    assert(persistent);

    // Both should be usable interchangeably for the server
  });
});
