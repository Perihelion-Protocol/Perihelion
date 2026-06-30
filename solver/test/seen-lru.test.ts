/**
 * Tests for the bounded LRU+TTL seen set (Issue 3).
 *
 * Validates:
 * - has() returns false for unknown hashes
 * - has() returns true after add()
 * - Expired entries (past deadline) are not returned by has()
 * - evictExpired() removes all past-deadline entries
 * - LRU capacity eviction removes the oldest entry when at max size
 * - Accessing an entry refreshes its LRU position
 * - size() tracks current count
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { SeenLRU } from "../src/seen-lru.js";

const HASH_A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const HASH_B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const HASH_C = "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
const HASH_D = "0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";

function future(msFromNow = 10_000): number {
  return Date.now() + msFromNow;
}

function past(msAgo = 1): number {
  return Date.now() - msAgo;
}

test("SeenLRU: has() returns false for unknown hash", () => {
  const seen = new SeenLRU(100);
  assert.equal(seen.has(HASH_A), false);
});

test("SeenLRU: has() returns true after add() with future deadline", () => {
  const seen = new SeenLRU(100);
  seen.add(HASH_A, future());
  assert.equal(seen.has(HASH_A), true);
});

test("SeenLRU: has() returns false and evicts lazily for expired entry", () => {
  const seen = new SeenLRU(100);
  seen.add(HASH_A, past()); // already past deadline
  assert.equal(seen.has(HASH_A), false);
  assert.equal(seen.size(), 0, "lazy eviction should remove the entry");
});

test("SeenLRU: evictExpired() removes all past-deadline entries", () => {
  const seen = new SeenLRU(100);
  seen.add(HASH_A, past(100)); // expired
  seen.add(HASH_B, past(200)); // expired
  seen.add(HASH_C, future());  // still valid

  const evicted = seen.evictExpired();
  assert.equal(evicted, 2, "two expired entries evicted");
  assert.equal(seen.size(), 1, "one entry remains");
  assert.equal(seen.has(HASH_C), true, "valid entry still present");
  assert.equal(seen.has(HASH_A), false, "expired entry gone");
  assert.equal(seen.has(HASH_B), false, "expired entry gone");
});

test("SeenLRU: evictExpired() returns 0 when nothing is expired", () => {
  const seen = new SeenLRU(100);
  seen.add(HASH_A, future());
  seen.add(HASH_B, future());

  assert.equal(seen.evictExpired(), 0);
  assert.equal(seen.size(), 2);
});

test("SeenLRU: LRU eviction removes oldest entry when at capacity", () => {
  const seen = new SeenLRU(2); // capacity of 2

  seen.add(HASH_A, future()); // oldest
  seen.add(HASH_B, future()); // second
  seen.add(HASH_C, future()); // should evict HASH_A (oldest)

  assert.equal(seen.size(), 2, "cache stays at maxSize");
  assert.equal(seen.has(HASH_A), false, "oldest (A) was evicted");
  assert.equal(seen.has(HASH_B), true,  "B still present");
  assert.equal(seen.has(HASH_C), true,  "C still present");
});

test("SeenLRU: accessing an entry refreshes its LRU position", () => {
  const seen = new SeenLRU(2);

  seen.add(HASH_A, future()); // inserted first
  seen.add(HASH_B, future()); // inserted second

  // Access A — it becomes the most recently used.
  assert.equal(seen.has(HASH_A), true);

  // Now add C — B should be evicted (it's now the least recently used).
  seen.add(HASH_C, future());

  assert.equal(seen.has(HASH_A), true,  "A still present (refreshed)");
  assert.equal(seen.has(HASH_B), false, "B evicted (least recently used)");
  assert.equal(seen.has(HASH_C), true,  "C present");
});

test("SeenLRU: size() tracks the current entry count", () => {
  const seen = new SeenLRU(100);
  assert.equal(seen.size(), 0);

  seen.add(HASH_A, future());
  assert.equal(seen.size(), 1);

  seen.add(HASH_B, future());
  assert.equal(seen.size(), 2);

  seen.evictExpired(); // nothing expired
  assert.equal(seen.size(), 2);
});

test("SeenLRU: memory does not grow past maxSize under sustained adds", () => {
  const maxSize = 50;
  const seen = new SeenLRU(maxSize);

  // Add many more entries than maxSize.
  for (let i = 0; i < maxSize * 3; i++) {
    seen.add(`0x${i.toString(16).padStart(64, "0")}`, future());
    assert.ok(seen.size() <= maxSize, `size ${seen.size()} exceeds maxSize ${maxSize} at i=${i}`);
  }
});

test("SeenLRU: entries with past deadline evicted by evictExpired in tight loop", () => {
  const seen = new SeenLRU(1000);

  // Add 100 already-expired entries + 50 valid ones.
  for (let i = 0; i < 100; i++) {
    seen.add(`0xexp${i.toString().padStart(61, "0")}`, past(1));
  }
  for (let i = 0; i < 50; i++) {
    seen.add(`0xval${i.toString().padStart(61, "0")}`, future());
  }

  assert.equal(seen.size(), 150);

  const evicted = seen.evictExpired();
  assert.equal(evicted, 100, "100 expired entries removed");
  assert.equal(seen.size(), 50, "50 valid entries remain");
});

test("SeenLRU: re-add existing hash refreshes deadline and LRU position", () => {
  const seen = new SeenLRU(100);
  seen.add(HASH_A, past()); // expired
  // Re-add with a future deadline.
  seen.add(HASH_A, future());
  assert.equal(seen.has(HASH_A), true, "re-added entry is now valid");
});
