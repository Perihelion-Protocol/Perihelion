/**
 * Tests for Solver.tick retry / terminal-skip behaviour (#84).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildIntent } from "@perihelion/sdk";
import { loadConfig } from "../src/config.js";
import { Solver, type Executor, type Logger } from "../src/solver.js";
import type { PricingDeps } from "../src/quote.js";

const VALID_ADDRESS = "0x0000000000000000000000000000000000000001" as const;
const VALID_HASH = ("0x" + "ab".repeat(32)) as `0x${string}`;
const VALID_SIG = ("0x" + "cd".repeat(65)) as `0x${string}`;

const config = loadConfig({
  PERIHELION_MEMPOOL_URL: "http://localhost:8080",
  PERIHELION_SOLVER_ADDRESS: VALID_ADDRESS,
  PERIHELION_SUPPORTED_ASSETS: "USDC:GA5Z",
  PERIHELION_MIN_MARGIN_BPS: "0",
});

const baseIntent = buildIntent({
  user: VALID_ADDRESS,
  destination: "GUSER",
  sourceChainId: 8453,
  sourceAsset: VALID_ADDRESS,
  sourceAmount: "1000000",    // 6dp
  destAsset: "USDC:GA5Z",
  minDestAmount: "1",         // tiny floor so profit check passes
  deadline: 4102444800,
});

/** Pricing deps that treat source as 6dp, dest as 7dp, 1:1 rate, no fees. */
const testDeps: PricingDeps = {
  decimalsLookup: (id) => (id.startsWith("0x") ? 6 : 7),
  priceOracle: async () => 1.0,
  feeEstimator: async () => 0n,
};

function makeRecord(intent = baseIntent, hash = VALID_HASH) {
  return { intent, signature: VALID_SIG, hash, status: "pending" as const, createdAt: 1700000000 };
}

function stubFetch(records: object[]) {
  return async () => new Response(JSON.stringify(records), { status: 200 });
}

const silentLogger: Logger = { info: () => {}, warn: () => {}, error: () => {} };

// ─── helper to access private state ──────────────────────────────────────────
type SolverPrivate = {
  seen: Set<string>;
  retryState: Map<string, { attempts: number; nextRetryAt: number }>;
};
const priv = (s: Solver): SolverPrivate => s as unknown as SolverPrivate;

// ─── transient failure then success ──────────────────────────────────────────

test("transient fill failure: intent is retried and eventually filled", async () => {
  const record = makeRecord();
  let fillCalls = 0;

  const executor: Executor = {
    fill: async () => {
      fillCalls++;
      if (fillCalls < 2) throw new Error("transient RPC error");
      return { settlementTx: "0xtx" };
    },
  };

  const solver = new Solver(config, executor, silentLogger, stubFetch([record]) as typeof fetch, testDeps);

  // First tick: fill fails → intent is not retired (not in seen).
  await solver.tick();
  assert.equal(fillCalls, 1);
  assert.ok(!priv(solver).seen.has(record.hash), "not retired after transient failure");
  assert.ok(priv(solver).retryState.has(record.hash), "retry state recorded");

  // Fast-forward backoff.
  priv(solver).retryState.get(record.hash)!.nextRetryAt = 0;

  // Second tick: fill succeeds → intent is retired.
  await solver.tick();
  assert.equal(fillCalls, 2, "fill retried on second tick");
  assert.ok(priv(solver).seen.has(record.hash), "intent retired after successful fill");
});

// ─── terminal skip ────────────────────────────────────────────────────────────

test("expired intent is permanently skipped after one tick (terminal)", async () => {
  const expired = buildIntent({ ...baseIntent, deadline: 1 });
  const record = makeRecord(expired);
  let fillCalls = 0;

  const executor: Executor = {
    fill: async () => { fillCalls++; return { settlementTx: "0x" }; },
  };
  const solver = new Solver(config, executor, silentLogger, stubFetch([record]) as typeof fetch, testDeps);

  await solver.tick();
  assert.equal(fillCalls, 0);
  assert.ok(priv(solver).seen.has(record.hash), "expired intent immediately retired");

  await solver.tick();
  assert.equal(fillCalls, 0, "not reconsidered on subsequent tick");
});

// ─── max retries exhausted ────────────────────────────────────────────────────

test("intent is retired after MAX_FILL_RETRIES (3) transient failures", async () => {
  const record = makeRecord();
  let fillCalls = 0;

  const executor: Executor = {
    fill: async () => { fillCalls++; throw new Error("always fails"); },
  };

  const solver = new Solver(config, executor, silentLogger, stubFetch([record]) as typeof fetch, testDeps);

  for (let i = 0; i < 5; i++) {
    const rs = priv(solver).retryState.get(record.hash);
    if (rs) rs.nextRetryAt = 0;
    if (priv(solver).seen.has(record.hash)) break;
    await solver.tick();
  }

  assert.ok(priv(solver).seen.has(record.hash), "intent retired after exhausting retries");
  assert.equal(fillCalls, 3, "fill attempted exactly MAX_FILL_RETRIES times");
});
