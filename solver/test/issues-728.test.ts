// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { test, mock } from "node:test";
import { buildIntent } from "@perihelion/sdk";
import type { IntentRecord, Hex } from "@perihelion/sdk";
import { hashIntent, perihelionDomain } from "@perihelion/sdk";
import type { SolverConfig } from "../src/config.js";
import { Solver, type Executor, type Logger } from "../src/solver.js";
import { RATE_SCALE, type PricingDeps } from "../src/quote.js";

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

const testPricingDeps: PricingDeps = {
  decimalsLookup: () => 6,
  priceOracle: async () => RATE_SCALE,
  feeEstimator: async () => 0n,
};

const CHAIN_ID = 8453;
const ESCROW_ADDRESS = "0x0000000000000000000000000000000000000001" as const;
const USER_ADDRESS = "0x0000000000000000000000000000000000000002" as const;

const domain = perihelionDomain(CHAIN_ID, ESCROW_ADDRESS);

function buildTestIntent() {
  return buildIntent({
    user: USER_ADDRESS,
    destination: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
    sourceChainId: CHAIN_ID,
    sourceAsset: "0x0000000000000000000000000000000000000004" as const,
    sourceAmount: "1000000",
    destAsset: "native",
    minDestAmount: "990000",
    deadline: Math.floor(Date.now() / 1000) + 600,
  });
}

function buildTestRecord(intent = buildTestIntent()): IntentRecord {
  const hash = hashIntent(intent, domain);
  return {
    intent,
    signature: "0xdeadbeef" as Hex,
    hash,
    status: "pending",
    createdAt: Math.floor(Date.now() / 1000),
  };
}

// ---- #728 concurrent processing of intents ----

test("tick: processes multiple intents concurrently when fillConcurrency is configured", async () => {
  const intentA = buildTestIntent();
  const intentB = buildIntent({ ...intentA, nonce: "111111" });
  const intentC = buildIntent({ ...intentA, nonce: "222222" });
  const recordA = buildTestRecord(intentA);
  const recordB = buildTestRecord(intentB);
  const recordC = buildTestRecord(intentC);

  let fillInFlight = 0;
  let maxConcurrent = 0;
  let releaseFillB!: () => void;
  const fillBGate = new Promise<void>((resolve) => {
    releaseFillB = resolve;
  });

  const mockExecutor: Executor = {
    fill: async (signed) => {
      fillInFlight++;
      maxConcurrent = Math.max(maxConcurrent, fillInFlight);
      if (signed.intent.nonce === intentB.nonce) {
        await fillBGate;
      }
      fillInFlight--;
      return { settlementTx: "0xfilled" };
    },
  };

  const mockLogger: Logger = { info: () => {}, warn: () => {}, error: () => {} };
  global.fetch = mock.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ records: [recordA, recordB, recordC], nextCursor: undefined }),
  })) as any;

  const solver = new Solver(
    { ...baseConfig, fillConcurrency: 2 },
    mockExecutor,
    mockLogger,
    undefined,
    undefined,
    async () => true,
    testPricingDeps,
  );

  const tickPromise = solver.tick();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(maxConcurrent >= 2, "should have at least 2 fills concurrent");

  releaseFillB();
  await tickPromise;
  assert.ok(
    maxConcurrent <= 2,
    "concurrency should not exceed the configured bound of 2",
  );
});

test("tick: respects fillConcurrency=1 for strictly sequential processing", async () => {
  const intentA = buildTestIntent();
  const intentB = buildIntent({ ...intentA, nonce: "333333" });
  const recordA = buildTestRecord(intentA);
  const recordB = buildTestRecord(intentB);

  const fillOrder: string[] = [];
  let releaseFillA!: () => void;
  const fillAGate = new Promise<void>((resolve) => {
    releaseFillA = resolve;
  });

  const mockExecutor: Executor = {
    fill: async (signed) => {
      fillOrder.push(`start:${signed.intent.nonce}`);
      if (signed.intent.nonce === intentA.nonce) {
        await fillAGate;
      }
      fillOrder.push(`done:${signed.intent.nonce}`);
      return { settlementTx: "0xfilled" };
    },
  };

  const mockLogger: Logger = { info: () => {}, warn: () => {}, error: () => {} };
  global.fetch = mock.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ records: [recordA, recordB], nextCursor: undefined }),
  })) as any;

  const solver = new Solver(
    { ...baseConfig, fillConcurrency: 1 },
    mockExecutor,
    mockLogger,
    undefined,
    undefined,
    async () => true,
    testPricingDeps,
  );

  const tickPromise = solver.tick();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(
    fillOrder.includes(`start:${intentA.nonce}`),
    "intent A fill should have started",
  );
  assert.ok(
    !fillOrder.some((e) => e.startsWith("start:") && e.endsWith(intentB.nonce)),
    "intent B fill should not start until A is done",
  );

  releaseFillA();
  await tickPromise;
  assert.ok(
    fillOrder.some((e) => e.startsWith("start:") && e.endsWith(intentB.nonce)),
    "intent B fill should start after A completes",
  );
});

test("tick: N concurrent fills complete in roughly the time of one fill (not N serial fills)", async () => {
  // Issue #728: Currently tick processes intents sequentially, so N fills take N * fillTime.
  // With bounded concurrency, N fills should take roughly max(fillTime, fillTime) time.
  const intentA = buildTestIntent();
  const intentB = buildIntent({ ...intentA, nonce: "444444" });
  const intentC = buildIntent({ ...intentA, nonce: "555555" });
  const recordA = buildTestRecord(intentA);
  const recordB = buildTestRecord(intentB);
  const recordC = buildTestRecord(intentC);

  const fillTimings: { start: number; end: number; nonce: string }[] = [];
  const FILL_DELAY_MS = 50;

  const mockExecutor: Executor = {
    fill: async (signed) => {
      const start = Date.now();
      fillTimings.push({ start, end: 0, nonce: signed.intent.nonce });
      await new Promise((resolve) => setTimeout(resolve, FILL_DELAY_MS));
      fillTimings.find((f) => f.nonce === signed.intent.nonce)!.end = Date.now();
      return { settlementTx: "0xfilled" };
    },
  };

  const mockLogger: Logger = { info: () => {}, warn: () => {}, error: () => {} };
  global.fetch = mock.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ records: [recordA, recordB, recordC], nextCursor: undefined }),
  })) as any;

  const solver = new Solver(
    { ...baseConfig, fillConcurrency: 3 },
    mockExecutor,
    mockLogger,
    undefined,
    undefined,
    async () => true,
    testPricingDeps,
  );

  const tickStart = Date.now();
  await solver.tick();
  const tickTotal = Date.now() - tickStart;

  // With 3 concurrent fills, each taking 50ms, total should be ~50-100ms (not 150ms).
  // Serial would take ~150ms+.
  const serialTimeExpected = 3 * FILL_DELAY_MS;
  assert.ok(
    tickTotal < serialTimeExpected * 0.75,
    `with fillConcurrency=3, tick should complete in <${serialTimeExpected * 0.75}ms, but took ${tickTotal}ms`,
  );
});
