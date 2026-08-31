// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { test } from "node:test";
import { buildIntent } from "@perihelion/sdk";
import { zeroAddress } from "viem";
import { loadConfig } from "../src/config.js";
import { computeProceeds, evaluate, isSolverEligible, RATE_SCALE } from "../src/quote.js";
import type { EvaluateDeps, PricingDeps } from "../src/quote.js";
import { InFlightTracker } from "../src/inventory.js";

const config = loadConfig({
  PERIHELION_SOLVER_ADDRESS: "0x3333333333333333333333333333333333333333",
  PERIHELION_ESCROW_ADDRESS: "0x2222222222222222222222222222222222222222",
  PERIHELION_SUPPORTED_ASSETS: "native,USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
  PERIHELION_MIN_MARGIN_BPS: "10",
});

/**
 * Deps for the 6dp EVM → 7dp Stellar stablecoin corridor used in all basic tests.
 * Source asset: 6 decimals (EVM stablecoin). Dest asset: 7 decimals (Stellar).
 */
const usdcDeps: PricingDeps = {
  decimalsLookup: (assetId) => (assetId.startsWith("0x") ? 6 : 7),
  priceOracle: async () => RATE_SCALE,
  feeEstimator: async () => 0n,
};

function intent(overrides: Partial<Parameters<typeof buildIntent>[0]> = {}) {
  return buildIntent({
    user: "0x0000000000000000000000000000000000000001",
    destination: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
    sourceChainId: 8453,
    sourceAsset: "0x0000000000000000000000000000000000000002",
    sourceAmount: "1000000",     // 1 USDC (6dp)
    destAsset: "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
    minDestAmount: "9900000",   // 0.99 USDC (7dp) — leaves ~100_000 margin
    // Within the SDK's 7-day max deadline horizon (see sdk validateIntent).
    deadline: Math.floor(Date.now() / 1000) + 3_600,
    ...overrides,
  });
}

// ─── basic corridor tests ────────────────────────────────────────────────────

test("fills a profitable, supported intent", async () => {
  const decision = await evaluate(intent(), config, usdcDeps);
  assert.equal(decision.fill, true);
  assert.ok(decision.profitBps != null && decision.profitBps > 0);
});

test("rejects intent for a different chain (terminal)", async () => {
  const decision = await evaluate(intent({ sourceChainId: 1 }), config, usdcDeps);
  assert.equal(decision.fill, false);
  assert.equal(decision.terminal, true);
  assert.match(decision.reason, /wrong chain/);
});

test("rejects unsupported dest asset (terminal)", async () => {
  const decision = await evaluate(intent({ destAsset: "EURC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN" }), config, usdcDeps);
  assert.equal(decision.fill, false);
  assert.equal(decision.terminal, true);
});

test("rejects when minDestAmount cannot be met (transient)", async () => {
  const decision = await evaluate(intent({ minDestAmount: "999999999" }), config, usdcDeps);
  assert.equal(decision.fill, false);
  assert.equal(decision.terminal, false);
});

test("rejects expired intents (terminal)", async () => {
  // buildIntent rejects past deadlines, so build a valid intent then expire it.
  const expired = { ...intent(), deadline: 1 };
  const decision = await evaluate(expired, config, usdcDeps);
  assert.equal(decision.fill, false);
  assert.equal(decision.reason, "intent expired");
  assert.equal(decision.terminal, true);
});

test("rejects intent with insufficient deadline headroom (terminal)", async () => {
  // The Soroban settlement contract rejects deliver_intent when
  //   now + MAX_DISPATCH_WINDOW (1_800 s) > intent.deadline
  // so the solver must refuse fills whose remaining time is below
  // MIN_FILL_HEADROOM_SECS (1_920 s = 1_800 s dispatch window + 120 s margin)
  // before committing to the EVM lock and LayerZero fee.
  //
  // An intent 10 minutes (600 s) from its deadline is well inside that window.
  const tenMinutesFromNow = Math.floor(Date.now() / 1000) + 600;
  const nearDeadline = { ...intent(), deadline: tenMinutesFromNow };
  const decision = await evaluate(nearDeadline, config, usdcDeps);
  assert.equal(decision.fill, false);
  assert.ok(
    decision.reason.includes("insufficient deadline headroom"),
    `expected headroom reason, got: "${decision.reason}"`,
  );
  assert.equal(decision.terminal, true);
});

test("accepts intent whose remaining time exactly exceeds the headroom", async () => {
  // An intent with exactly MIN_FILL_HEADROOM_SECS + 1 s remaining must be
  // accepted by the headroom check (boundary: strictly greater than the window).
  const { MIN_FILL_HEADROOM_SECS } = await import("@perihelion/sdk");
  const justEnough = Math.floor(Date.now() / 1000) + MIN_FILL_HEADROOM_SECS + 1;
  const nearBoundary = { ...intent(), deadline: justEnough };
  const decision = await evaluate(nearBoundary, config, usdcDeps);
  // The check is `intent.deadline <= now + MIN_FILL_HEADROOM_SECS`, so at
  // now + MIN_FILL_HEADROOM_SECS + 1 the headroom check must NOT reject.
  assert.ok(
    decision.reason !== "intent expired" &&
      !decision.reason.includes("insufficient deadline headroom"),
    `headroom check should pass with 1 s to spare, got: "${decision.reason}"`,
  );
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

// ─── margin gate (#312) ──────────────────────────────────────────────────────
// config.minMarginBps = 10 (see PERIHELION_MIN_MARGIN_BPS above). proceeds is
// fixed at 10_000_000 for sourceAmount "1000000" under usdcDeps' 1:1 rate.

test("rejects a profitable fill that is below the configured margin", async () => {
  // profit = 10_000_000 - 9_995_000 = 5_000 -> profitBps = 5 (< 10bps minimum)
  const decision = await evaluate(intent({ minDestAmount: "9995000" }), config, usdcDeps);
  assert.equal(decision.fill, false);
  assert.equal(decision.terminal, false);
  assert.match(decision.reason, /margin/);
});

test("fills exactly at the configured margin boundary", async () => {
  // profit = 10_000_000 - 9_990_000 = 10_000 -> profitBps = 10 (== 10bps minimum)
  const decision = await evaluate(intent({ minDestAmount: "9990000" }), config, usdcDeps);
  assert.equal(decision.fill, true);
  assert.equal(decision.profitBps, 10);
});

// ─── decimals must never be guessed (#310) ───────────────────────────────────

test("evaluate: unknown EVM asset decimals produce a non-terminal skip, not a guess", async () => {
  // No decimalsLookup override -> defaultDecimalsLookup must refuse to guess
  // for an 0x-prefixed asset instead of assuming 6dp.
  const decision = await evaluate(intent(), config, {
    priceOracle: async () => RATE_SCALE,
    feeEstimator: async () => 0n,
  });
  assert.equal(decision.fill, false);
  assert.equal(decision.terminal, false);
  assert.match(decision.reason, /decimals not configured/);
});

test("evaluate: implausible profit is rejected by the sanity bound", async () => {
  // Simulates a WETH (18dp) intent mispriced as 6dp (the #310 bug): proceeds
  // come back ~10^12x too large relative to minDestAmount, yielding an
  // implausible profitBps that the sanity bound must catch as a last resort.
  const decision = await evaluate(
    intent({ sourceAmount: "1000000000000000000", minDestAmount: "9000000" }),
    config,
    { decimalsLookup: (assetId) => (assetId.startsWith("0x") ? 6 : 7), priceOracle: async () => RATE_SCALE, feeEstimator: async () => 0n },
  );
  assert.equal(decision.fill, false);
  assert.equal(decision.terminal, false);
  assert.match(decision.reason, /implausible profit/);
});

// ─── decimal corridor tests (#87) ────────────────────────────────────────────

test("18dp → 7dp corridor: ETH-like source to Stellar asset", async () => {
  // sourceAmount = 1e18 (1 ETH, 18dp), expect delivery at 1:1 rate = 1e7 dest units (7dp)
  const ethDeps: PricingDeps = {
    decimalsLookup: (assetId) => (assetId.startsWith("0x") ? 18 : 7),
    priceOracle: async () => RATE_SCALE,
    feeEstimator: async () => 0n,
  };
  const i = intent({ sourceAmount: "1000000000000000000", minDestAmount: "9000000" });
  const decision = await evaluate(i, config, ethDeps);
  assert.equal(decision.fill, true);
});

test("7dp → 7dp corridor: Stellar-to-Stellar same decimals", async () => {
  const stellarDeps: PricingDeps = {
    decimalsLookup: () => 7,
    priceOracle: async () => RATE_SCALE,
    feeEstimator: async () => 0n,
  };
  const i = intent({ sourceAmount: "10000000", minDestAmount: "9900000" });
  const decision = await evaluate(i, config, stellarDeps);
  assert.equal(decision.fill, true);
});

// ─── exact bigint precision (#311) ───────────────────────────────────────────

test("computeProceeds: 1 WETH (18dp) -> 7dp produces an exact value", async () => {
  const proceeds = await computeProceeds(
    intent({ sourceAmount: "1000000000000000000" }),
    { decimalsLookup: (assetId) => (assetId.startsWith("0x") ? 18 : 7), priceOracle: async () => RATE_SCALE },
  );
  assert.equal(proceeds, 10_000_000n);
});

test("computeProceeds: amount near i128 max does not throw or lose precision", async () => {
  const i128Max = "170141183460469231731687303715884105727";
  const proceeds = await computeProceeds(
    intent({ sourceAmount: i128Max }),
    { decimalsLookup: () => 7, priceOracle: async () => RATE_SCALE },
  );
  assert.equal(proceeds, BigInt(i128Max));
});

test("computeProceeds: monotonic in sourceAmount", async () => {
  const deps = { decimalsLookup: () => 7, priceOracle: async () => RATE_SCALE };
  const amounts = ["1", "100", "10000", "1000000", "100000000000000000"];
  let prev = -1n;
  for (const amount of amounts) {
    const proceeds = await computeProceeds(intent({ sourceAmount: amount }), deps);
    assert.ok(proceeds > prev, `expected ${proceeds} > ${prev} for amount ${amount}`);
    prev = proceeds;
  }
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

function fixedInventory(balance: bigint): EvaluateDeps {
  return { ...usdcDeps, availableBalance: async () => balance };
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
  tracker.reserve("USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN", 10_000_000n);
  const decision = await evaluate(intent(), config, fixedInventory(10_000_000n), tracker);
  assert.equal(decision.fill, false);
  assert.equal(decision.reason, "insufficient inventory");
});

// ---- #560 native-balance tests ----

test("evaluate: declines when source-chain native balance is below the per-fill cost", async () => {
  const decision = await evaluate(intent(), config, {
    ...fixedInventory(100_000_000n),
    nativeBalanceSource: async () => 1_000n, // wei on hand
    sourceNativeCost: async () => 5_000_000_000_000_000n, // LayerZero quote + gas
  });
  assert.equal(decision.fill, false);
  assert.equal(decision.terminal, false);
  assert.equal(decision.nativeShortfall, true);
  assert.match(decision.reason, /native balance on source chain/);
});

test("evaluate: declines when Stellar XLM balance is below the per-fill cost", async () => {
  const decision = await evaluate(intent(), config, {
    ...fixedInventory(100_000_000n),
    nativeBalanceDest: async () => 0n, // stroops on hand
    destNativeCost: async () => 20_000_000n, // ~2 XLM for delivery + confirmation
  });
  assert.equal(decision.fill, false);
  assert.equal(decision.terminal, false);
  assert.equal(decision.nativeShortfall, true);
  assert.match(decision.reason, /native XLM on Stellar/);
});

test("evaluate: an underfunded solver declines rather than attempting a partial fill", async () => {
  // Inventory of the dest asset is ample; only the native gas balance is short.
  const decision = await evaluate(intent(), config, {
    ...fixedInventory(1_000_000_000n),
    nativeBalanceSource: async () => 0n,
    nativeBalanceDest: async () => 0n,
    sourceNativeCost: async () => 1n,
    destNativeCost: async () => 1n,
  });
  assert.equal(decision.fill, false, "must not commit to a fill it cannot pay fees for");
  assert.equal(decision.nativeShortfall, true);
});

test("evaluate: falls back to the configured native fee floors when no estimator is wired", async () => {
  const flooredConfig = loadConfig({
    PERIHELION_SOLVER_ADDRESS: "0x3333333333333333333333333333333333333333",
    PERIHELION_ESCROW_ADDRESS: "0x2222222222222222222222222222222222222222",
    PERIHELION_SUPPORTED_ASSETS: "native,USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
    PERIHELION_MIN_MARGIN_BPS: "10",
    PERIHELION_STELLAR_NATIVE_FEE_FLOOR: "20000000",
  });
  const decision = await evaluate(intent(), flooredConfig, {
    ...fixedInventory(100_000_000n),
    nativeBalanceDest: async () => 5_000_000n, // below the 20_000_000 floor
  });
  assert.equal(decision.fill, false);
  assert.equal(decision.nativeShortfall, true);
});

test("evaluate: fills when both native balances clear the per-fill cost", async () => {
  const decision = await evaluate(intent(), config, {
    ...fixedInventory(100_000_000n),
    nativeBalanceSource: async () => 10n ** 18n,
    nativeBalanceDest: async () => 10n ** 9n,
    sourceNativeCost: async () => 5_000_000_000_000_000n,
    destNativeCost: async () => 20_000_000n,
  });
  assert.equal(decision.fill, true);
});

test("evaluate: native check is skipped when the provider cannot report native balances", async () => {
  // No nativeBalance* getters -> behaviour is unchanged from before #560.
  const decision = await evaluate(intent(), config, fixedInventory(100_000_000n));
  assert.equal(decision.fill, true);
});
