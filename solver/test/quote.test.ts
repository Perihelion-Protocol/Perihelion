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

/**
 * Deps for the 6dp EVM → 7dp Stellar stablecoin corridor used in all basic tests.
 * Source asset: 6 decimals (EVM stablecoin). Dest asset: 7 decimals (Stellar).
 */
const usdcDeps: PricingDeps = {
  decimalsLookup: (assetId) => (assetId.startsWith("0x") ? 6 : 7),
  priceOracle: async () => 1.0,
  feeEstimator: async () => 0n,
};

function intent(overrides: Partial<Parameters<typeof buildIntent>[0]> = {}) {
  return buildIntent({
    user: "0x0000000000000000000000000000000000000001",
    destination: "GUSER",
    sourceChainId: 8453,
    sourceAsset: "0x0000000000000000000000000000000000000002",
    sourceAmount: "1000000",     // 1 USDC (6dp)
    destAsset: "USDC:GA5Z",
    minDestAmount: "9900000",   // 0.99 USDC (7dp) — leaves ~100_000 margin
    deadline: 4102444800,
    ...overrides,
  });
}

// ─── basic corridor tests ────────────────────────────────────────────────────

test("fills a profitable, supported intent", async () => {
  const decision = await evaluate(intent(), config, usdcDeps);
  assert.equal(decision.fill, true);
  assert.ok(decision.profitBps != null && decision.profitBps > 0);
});

test("rejects unsupported dest asset (terminal)", async () => {
  const decision = await evaluate(intent({ destAsset: "EURC:GBBB" }), config, usdcDeps);
  assert.equal(decision.fill, false);
  assert.equal(decision.terminal, true);
});

test("rejects when minDestAmount cannot be met (transient)", async () => {
  const decision = await evaluate(intent({ minDestAmount: "999999999" }), config, usdcDeps);
  assert.equal(decision.fill, false);
  assert.equal(decision.terminal, false);
});

test("rejects expired intents (terminal)", async () => {
  const decision = await evaluate(intent({ deadline: 1 }), config, usdcDeps);
  assert.equal(decision.fill, false);
  assert.equal(decision.reason, "intent expired");
  assert.equal(decision.terminal, true);
});

test("rejects reserved-for-another-solver intent (terminal)", async () => {
  const decision = await evaluate(
    intent({ preferredSolver: "0x1111111111111111111111111111111111111111" }),
    config,
    usdcDeps,
  );
  assert.equal(decision.fill, false);
  assert.equal(decision.terminal, true);
});

// ─── fee-inclusive loss-making intent is skipped ─────────────────────────────

test("rejects fee-inclusive loss-making intent", async () => {
  // sourceAmount = 1 USDC (6dp) → 10_000_000 dest smallest units (7dp)
  // minDestAmount = 9_950_000, fees = 200_000 → profit < 0
  const highFeeDeps: PricingDeps = {
    ...usdcDeps,
    feeEstimator: async () => 200_000n,
  };
  const decision = await evaluate(
    intent({ minDestAmount: "9950000" }),
    config,
    highFeeDeps,
  );
  assert.equal(decision.fill, false);
  assert.equal(decision.terminal, false);
});

// ─── decimal corridor tests (#87) ────────────────────────────────────────────

test("18dp → 7dp corridor: ETH-like source to Stellar asset", async () => {
  // sourceAmount = 1e18 (1 ETH, 18dp), expect delivery at 1:1 rate = 1e7 dest units (7dp)
  const ethDeps: PricingDeps = {
    decimalsLookup: (assetId) => (assetId.startsWith("0x") ? 18 : 7),
    priceOracle: async () => 1.0,
    feeEstimator: async () => 0n,
  };
  const i = intent({ sourceAmount: "1000000000000000000", minDestAmount: "9000000" });
  const decision = await evaluate(i, config, ethDeps);
  assert.equal(decision.fill, true);
});

test("7dp → 7dp corridor: Stellar-to-Stellar same decimals", async () => {
  const stellarDeps: PricingDeps = {
    decimalsLookup: () => 7,
    priceOracle: async () => 1.0,
    feeEstimator: async () => 0n,
  };
  const i = intent({ sourceAmount: "10000000", minDestAmount: "9900000" });
  const decision = await evaluate(i, config, stellarDeps);
  assert.equal(decision.fill, true);
});

// ─── transient pricing error → non-terminal skip ─────────────────────────────

test("pricing error produces non-terminal skip (transient)", async () => {
  const errorDeps: PricingDeps = {
    priceOracle: async () => { throw new Error("oracle down"); },
    decimalsLookup: usdcDeps.decimalsLookup,
  };
  const decision = await evaluate(intent(), config, errorDeps);
  assert.equal(decision.fill, false);
  assert.equal(decision.terminal, false);
  assert.match(decision.reason, /pricing error/);
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