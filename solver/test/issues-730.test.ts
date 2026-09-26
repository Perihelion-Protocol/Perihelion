// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { test, mock } from "node:test";
import { buildIntent } from "@perihelion/sdk";
import { loadConfig } from "../src/config.js";
import { evaluate, RATE_SCALE } from "../src/quote.js";
import type { PricingDeps } from "../src/quote.js";
import type { Executor, Logger } from "../src/solver.js";
import { Solver } from "../src/solver.js";
import type { SolverConfig } from "../src/config.js";
import type { Metrics } from "../src/metrics.js";

const config = loadConfig({
  PERIHELION_SOLVER_ADDRESS: "0x3333333333333333333333333333333333333333",
  PERIHELION_ESCROW_ADDRESS: "0x2222222222222222222222222222222222222222",
  PERIHELION_SUPPORTED_ASSETS: "native,USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
  PERIHELION_MIN_MARGIN_BPS: "10",
});

const baseConfig: SolverConfig = {
  mempoolUrl: "http://localhost:8080",
  solverAddress: "0x0000000000000000000000000000000000000003" as const,
  sourceChainId: 8453,
  escrowAddress: "0x0000000000000000000000000000000000000001" as const,
  minMarginBps: 10,
  sourceNativeFeeFloor: 0n,
  stellarNativeFeeFloor: 0n,
  pollIntervalMs: 1000,
  supportedDestAssets: ["native"],
  verificationCacheSize: 100,
};

function intent(overrides: Partial<Parameters<typeof buildIntent>[0]> = {}) {
  return buildIntent({
    user: "0x0000000000000000000000000000000000000001",
    destination: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
    sourceChainId: 8453,
    sourceAsset: "0x0000000000000000000000000000000000000002",
    sourceAmount: "1000000",
    destAsset: "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
    minDestAmount: "9900000",
    deadline: Math.floor(Date.now() / 1000) + 3_600,
    ...overrides,
  });
}

// ---- #730 unconfigured decimals should be terminal ----

test("evaluate: unconfigured asset decimals should produce terminal skip", async () => {
  // Issue #730: defaultDecimalsLookup throws for EVM token addresses without
  // explicit decimals configuration. This is correct (never guess decimals),
  // but the error should be classified as terminal, not retriable.
  // An unconfigured asset is a configuration fact that won't resolve on retry.
  const noDecimalsDeps: PricingDeps = {
    priceOracle: async () => RATE_SCALE,
    feeEstimator: async () => 0n,
    // No decimalsLookup -> defaultDecimalsLookup used, which throws for 0x addresses
  };
  const decision = await evaluate(
    intent(),
    config,
    noDecimalsDeps,
  );
  assert.equal(decision.fill, false);
  assert.equal(decision.terminal, true, "unconfigured asset must be terminal");
});

test("tick: unconfigured asset is recorded as a terminal skip once, not every tick", async () => {
  // An intent with an unconfigured EVM token should be evaluated with the
  // defaultDecimalsLookup, which throws. This should be caught and recorded
  // as a terminal skip (configuration issue), not retried forever.
  const testIntent = intent();
  const { hashIntent, perihelionDomain } = await import("@perihelion/sdk");
  const domain = perihelionDomain(baseConfig.sourceChainId, baseConfig.escrowAddress);
  const hash = hashIntent(testIntent, domain);
  const record = {
    intent: testIntent,
    signature: "0xdeadbeef" as const,
    hash,
    status: "pending" as const,
    createdAt: Math.floor(Date.now() / 1000),
  };

  const skips: string[] = [];
  const mockExecutor: Executor = {
    fill: async () => ({ settlementTx: "0xfilled" }),
  };

  const mockMetrics: Metrics = {
    recordFillAttempt: () => {},
    recordFillWon: () => {},
    recordFillLost: () => {},
    recordSkip: (reason) => skips.push(reason),
    recordFee: () => {},
    recordFees: () => {},
    snapshot: () => ({} as any),
  };

  const mockLogger: Logger = { info: () => {}, warn: () => {}, error: () => {} };
  global.fetch = mock.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ records: [record], nextCursor: undefined }),
  })) as any;

  // Use no decimalsLookup override -> defaultDecimalsLookup will throw for EVM addresses
  const pricingDeps: PricingDeps = {
    priceOracle: async () => RATE_SCALE,
    feeEstimator: async () => 0n,
  };

  const solver = new Solver(baseConfig, mockExecutor, mockLogger, mockMetrics, undefined, async () => true, pricingDeps);

  // First tick: should skip the intent and record it
  await solver.tick();
  const skipsBefore = skips.length;

  // Second tick: the intent is still in mempool, but it was marked terminal,
  // so it should be in the seen-set and not reconsidered.
  await solver.tick();
  const skipsAfter = skips.length;

  // The intent should have been recorded as a skip exactly once across both ticks.
  assert.equal(
    skipsAfter - skipsBefore,
    0,
    "terminal skip should not be recorded again on the second tick",
  );
});
