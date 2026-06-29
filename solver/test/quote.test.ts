import assert from "node:assert/strict";
import { test } from "node:test";
import { buildIntent } from "@perihelion/sdk";
import { zeroAddress } from "viem";
import { loadConfig } from "../src/config.js";
import { evaluate, isSolverEligible } from "../src/quote.js";
import { InFlightTracker } from "../src/inventory.js";
import type { InventoryProvider } from "../src/inventory.js";

const config = loadConfig({
  PERIHELION_SUPPORTED_ASSETS: "native,USDC:GA5Z",
  PERIHELION_MIN_MARGIN_BPS: "10",
});

function intent(overrides: Partial<Parameters<typeof buildIntent>[0]> = {}) {
  return buildIntent({
    user: "0x0000000000000000000000000000000000000001",
    destination: "GUSER",
    sourceChainId: 8453,
    sourceAsset: "0x0000000000000000000000000000000000000002",
    sourceAmount: "1000000",
    destAsset: "USDC:GA5Z",
    minDestAmount: "9900000",
    deadline: 4102444800,
    ...overrides,
  });
}

test("fills a profitable, supported intent", async () => {
  const decision = await evaluate(intent(), config);
  assert.equal(decision.fill, true);
});

test("rejects unsupported dest asset", async () => {
  const decision = await evaluate(intent({ destAsset: "EURC:GBBB" }), config);
  assert.equal(decision.fill, false);
});

test("rejects when minDestAmount cannot be met", async () => {
  const decision = await evaluate(intent({ minDestAmount: "999999999" }), config);
  assert.equal(decision.fill, false);
});

test("rejects expired intents", async () => {
  const decision = await evaluate(intent({ deadline: 1 }), config);
  assert.equal(decision.fill, false);
  assert.equal(decision.reason, "intent expired");
});

const SOLVER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const OTHER  = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

test("isSolverEligible: open intent (zeroAddress)", () => {
  assert.equal(isSolverEligible(zeroAddress, SOLVER), true);
});

test("isSolverEligible: reserved for this solver (mixed case)", () => {
  const mixedCase = SOLVER.toLowerCase();
  assert.equal(isSolverEligible(mixedCase, SOLVER), true);
});

test("isSolverEligible: reserved for another solver", () => {
  assert.equal(isSolverEligible(OTHER, SOLVER), false);
});

test("evaluate: skips intent reserved for another solver", async () => {
  const decision = await evaluate(
    intent({ preferredSolver: OTHER }),
    config,
  );
  assert.equal(decision.fill, false);
  assert.equal(decision.reason, "reserved for another solver");
});

// ---- #88 inventory tests ----

function fixedInventory(balance: bigint): InventoryProvider {
  return { availableBalance: async () => balance };
}

test("evaluate: fills when inventory is sufficient", async () => {
  const decision = await evaluate(intent(), config, fixedInventory(100_000_000n));
  assert.equal(decision.fill, true);
});

test("evaluate: skips when inventory is insufficient", async () => {
  const decision = await evaluate(intent(), config, fixedInventory(0n));
  assert.equal(decision.fill, false);
  assert.equal(decision.reason, "insufficient inventory");
});

test("evaluate: skips when in-flight fills over-commit balance", async () => {
  // Deliverable for the intent is 10_000_000 (1 USDC at 7dp).
  // Balance is 10_000_000 but we've already reserved 1n more than available.
  const tracker = new InFlightTracker();
  tracker.reserve("USDC:GA5Z", 10_000_000n);
  const decision = await evaluate(intent(), config, fixedInventory(10_000_000n), tracker);
  assert.equal(decision.fill, false);
  assert.equal(decision.reason, "insufficient inventory");
});