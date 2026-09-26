// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { test } from "node:test";
import { buildIntent } from "@perihelion/sdk";
import { zeroAddress } from "viem";
import { loadConfig } from "../src/config.js";
import { evaluate, RATE_SCALE } from "../src/quote.js";
import type { PricingDeps } from "../src/quote.js";

const config = loadConfig({
  PERIHELION_SOLVER_ADDRESS: "0x3333333333333333333333333333333333333333",
  PERIHELION_ESCROW_ADDRESS: "0x2222222222222222222222222222222222222222",
  PERIHELION_SUPPORTED_ASSETS: "native,USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
  PERIHELION_MIN_MARGIN_BPS: "10",
});

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
    sourceAmount: "1000000",
    destAsset: "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
    minDestAmount: "9900000",
    deadline: Math.floor(Date.now() / 1000) + 3_600,
    ...overrides,
  });
}

// ---- #731 malformed preferredSolver ----

test("evaluate: malformed preferredSolver produces terminal skip, not exception", async () => {
  // A malformed address like "not_an_address" would cause isSolverEligible to
  // pass it to isAddressEqual, which throws InvalidAddressError. This must
  // be caught and converted to a terminal skip, not allowed to escape.
  // Build the intent directly to bypass SDK validation of preferredSolver.
  const malformedIntent = { ...intent(), preferredSolver: "not_an_address" };
  const decision = await evaluate(
    malformedIntent,
    config,
    usdcDeps,
  );
  assert.equal(decision.fill, false);
  assert.equal(decision.terminal, true);
  assert.match(decision.reason, /address|solver/i);
});

test("evaluate: malformed preferredSolver throws no exception", async () => {
  // Regression: ensure that isSolverEligible's call to isAddressEqual is wrapped
  // in error handling so that InvalidAddressError doesn't escape to the caller.
  const malformedIntent = { ...intent(), preferredSolver: "definitely_not_an_address" };
  const decision = await evaluate(
    malformedIntent,
    config,
    usdcDeps,
  );
  // The test passes if we reach here without an uncaught exception
  assert.ok(!decision.fill, "evaluation should not fill malformed intent");
});
