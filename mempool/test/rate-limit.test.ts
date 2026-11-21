// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { test } from "node:test";
import { SlidingWindowRateLimitStore } from "../src/rate-limit.js";

test("stale one-shot clients are removed after one rate-limit window (#1111)", () => {
  const limiter = new SlidingWindowRateLimitStore(1_000);

  for (let i = 0; i < 500; i++) {
    assert.equal(limiter.allow(`read:2001:db8::${i}`, 10, 5_000), true);
  }
  assert.equal(limiter.size, 500);

  assert.equal(limiter.prune(6_001), 500);
  assert.equal(limiter.size, 0);
});

test("the key cap bounds a burst before the periodic sweep", () => {
  const limiter = new SlidingWindowRateLimitStore(60_000, 3);

  for (const key of ["a", "b", "c", "d"]) {
    assert.equal(limiter.allow(key, 10, 1_000), true);
  }

  assert.equal(limiter.size, 3);
  // `a` was the least recently seen key and was evicted, so it starts fresh.
  assert.equal(limiter.allow("a", 1, 1_001), true);
});

test("active clients remain throttled for the complete window", () => {
  const limiter = new SlidingWindowRateLimitStore(1_000);

  assert.equal(limiter.allow("write:client", 2, 1_000), true);
  assert.equal(limiter.allow("write:client", 2, 1_100), true);
  assert.equal(limiter.allow("write:client", 2, 1_999), false);
  assert.equal(limiter.allow("write:client", 2, 2_001), true);
});
