import assert from "node:assert/strict";
import { test } from "node:test";
import { BackoffState } from "../src/backoff.js";

const BASE = 1_000; // 1 s base interval for easy arithmetic

test("nextDelay with no failures equals base + jitter", () => {
  const rng = () => 0.5; // deterministic: jitter = floor(0.5 * (maxJitter+1))
  const b = new BackoffState({ pollIntervalMs: BASE, maxJitterMs: 200 }, rng);
  const delay = b.nextDelay();
  // base * 2^0 = 1000, jitter = floor(0.5 * 201) = 100
  assert.equal(delay, 1_100);
});

test("jitter is within [0, maxJitterMs]", () => {
  // Try both extremes of the RNG.
  const bMin = new BackoffState({ pollIntervalMs: BASE, maxJitterMs: 100 }, () => 0);
  const bMax = new BackoffState({ pollIntervalMs: BASE, maxJitterMs: 100 }, () => 0.9999);
  assert.ok(bMin.nextDelay() >= BASE);
  assert.ok(bMax.nextDelay() <= BASE + 100);
});

test("backoff doubles on each consecutive failure", () => {
  const b = new BackoffState(
    { pollIntervalMs: BASE, maxJitterMs: 0, backoffMultiplier: 2 },
    () => 0,
  );
  assert.equal(b.nextDelay(), BASE); // 0 failures → 1000
  b.recordFailure();
  assert.equal(b.nextDelay(), 2_000); // 1 failure → 2000
  b.recordFailure();
  assert.equal(b.nextDelay(), 4_000); // 2 failures → 4000
});

test("backoff is capped at maxBackoffMs", () => {
  const b = new BackoffState(
    { pollIntervalMs: BASE, maxJitterMs: 0, maxBackoffMs: 3_000 },
    () => 0,
  );
  b.recordFailure();
  b.recordFailure();
  b.recordFailure();
  b.recordFailure();
  // Would be 16000 uncapped; capped at 3000.
  assert.equal(b.nextDelay(), 3_000);
});

test("recordSuccess resets the failure counter", () => {
  const b = new BackoffState({ pollIntervalMs: BASE, maxJitterMs: 0 }, () => 0);
  b.recordFailure();
  b.recordFailure();
  assert.equal(b.consecutiveFailures, 2);
  b.recordSuccess();
  assert.equal(b.consecutiveFailures, 0);
  assert.equal(b.nextDelay(), BASE); // back to base
});

test("default maxJitterMs is 25% of base interval", () => {
  const b = new BackoffState({ pollIntervalMs: BASE }, () => 1); // rng=1 gives max jitter
  // maxJitterMs = floor(1000 * 0.25) = 250; jitter = floor(1 * 251) = 251
  assert.ok(b.nextDelay() <= BASE + 250);
});
