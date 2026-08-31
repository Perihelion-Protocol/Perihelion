// SPDX-License-Identifier: MIT
/**
 * Regression tests for:
 *   #547 – retryState must be bounded and pruned for intents that vanish from the mempool
 *   #546 – in-flight reservation must survive a successful fill until the next tick
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildIntent,
  hashIntent,
  perihelionDomain,
  type IntentRecord,
  type Hex,
} from "@perihelion/sdk";
import { Solver, type Executor, type Logger } from "../src/solver.js";
import { DefiniteFailureError } from "../src/executor.js";
import { InFlightTracker } from "../src/inventory.js";
import type { SolverConfig } from "../src/config.js";
import type { InventoryProvider } from "../src/inventory.js";
import { RATE_SCALE, type PricingDeps } from "../src/quote.js";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const CHAIN_ID = 8453;
const ESCROW = "0x0000000000000000000000000000000000000001" as const;
const USER = "0x0000000000000000000000000000000000000002" as const;
const domain = perihelionDomain(CHAIN_ID, ESCROW);

const baseConfig: SolverConfig = {
  mempoolUrl: "http://localhost:8080",
  solverAddress: "0x0000000000000000000000000000000000000003" as const,
  sourceChainId: CHAIN_ID,
  escrowAddress: ESCROW,
  minMarginBps: 10,
  pollIntervalMs: 1000,
  supportedDestAssets: ["native"],
  verificationCacheSize: 100,
  seenCacheSize: 1000,
  retryCacheSize: 10,
};

const pricingDeps: PricingDeps = {
  decimalsLookup: () => 6,
  priceOracle: async () => RATE_SCALE,
  feeEstimator: async () => 0n,
};

const silentLogger: Logger = { info: () => {}, warn: () => {}, error: () => {} };

let nonceCounter = 10000;
function makeIntent(overrides: { nonce?: string } = {}) {
  return buildIntent({
    user: USER,
    destination: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
    sourceChainId: CHAIN_ID,
    sourceAsset: "0x0000000000000000000000000000000000000004" as const,
    sourceAmount: "1000000",
    destAsset: "native",
    minDestAmount: "990000",
    deadline: Math.floor(Date.now() / 1000) + 600,
    nonce: overrides.nonce ?? String(nonceCounter++),
  });
}

function makeRecord(intent = makeIntent()): IntentRecord {
  const hash = hashIntent(intent, domain);
  return { intent, signature: "0xdeadbeef" as Hex, hash, status: "pending", createdAt: Math.floor(Date.now() / 1000) };
}

function setMempool(records: IntentRecord[]) {
  global.fetch = (async () => ({
    ok: true, status: 200,
    json: async () => ({ records, nextCursor: undefined }),
  })) as any;
}

/** Creates a fetch wrapper whose returned records can be swapped after the solver is constructed. */
function makeMutableMempool() {
  let current: IntentRecord[] = [];
  const fetcher = async () => ({
    ok: true, status: 200,
    json: async () => ({ records: current, nextCursor: undefined }),
  });
  global.fetch = fetcher as any;
  return { set: (records: IntentRecord[]) => { current = records; } };
}

// ---------------------------------------------------------------------------
// #547 – RetryStateLRU: TTL eviction via evictExpired()
// ---------------------------------------------------------------------------

test("#547: retryState entries are evicted once their clamped TTL has passed", async () => {
  // We test the RetryStateLRU directly by accessing it through the solver's
  // private field via casting. This is the most precise way to verify the
  // eviction logic without fighting the seen-set / scheduleRetry interactions.
  const intent = makeIntent();
  const record = makeRecord(intent);

  let fillCount = 0;
  const executor: Executor = {
    fill: async () => {
      fillCount++;
      throw new Error("always fail");
    },
  };

  setMempool([]);
  const solver = new Solver(
    // Use MAX_FILL_RETRIES=3, so we need to keep attempts below that.
    { ...baseConfig, retryCacheSize: 100 },
    executor, silentLogger,
    undefined, undefined,
    async () => true, pricingDeps,
  );

  const retryState = (solver as any).retryState as {
    evictExpired(): number;
    size(): number;
    get(hash: string): { attempts: number; nextRetryAt: number } | undefined;
    set(hash: string, state: { attempts: number; nextRetryAt: number }, deadlineMs: number): void;
  };

  // Directly insert an entry with a deadlineMs in the past.
  const pastDeadline = Date.now() - 1; // already expired
  retryState.set(record.hash, { attempts: 1, nextRetryAt: 0 }, pastDeadline);
  assert.equal(retryState.size(), 1, "entry should be present before eviction");

  // evictExpired() should remove the past-deadline entry.
  const evicted = retryState.evictExpired();
  assert.equal(evicted, 1, "one expired entry should be evicted");
  assert.equal(retryState.size(), 0, "retryState should be empty after eviction");
  assert.equal(retryState.get(record.hash), undefined, "entry must be gone after eviction");
});

test("#547: evictExpired() is called each tick and prunes stale entries", async () => {
  const intent = makeIntent();
  const record = makeRecord(intent);

  let fillCount = 0;
  const executor: Executor = {
    fill: async () => {
      fillCount++;
      throw new Error("always fail");
    },
  };

  const errors: string[] = [];
  const logger: Logger = { ...silentLogger, error: (m) => errors.push(m) };

  // Use a mutable mempool wrapper (SDK client captures fetch at construction time).
  const mempool = makeMutableMempool();
  mempool.set([record]);

  // First tick: intent fails → added to retryState (attempts=1, nextRetryAt = now+1s).
  const solver = new Solver(baseConfig, executor, logger, undefined, undefined, async () => true, pricingDeps);
  await solver.tick();
  assert.equal(fillCount, 1, "fill attempted on first tick");

  const retryState = (solver as any).retryState as {
    evictExpired(): number;
    size(): number;
    get(hash: string): unknown;
  };
  assert.equal(retryState.size(), 1, "retryState has one entry after first fill failure");

  // Time-travel past the clamped TTL (MIN_SEEN_TTL_MS = 10 min).
  const orig = Date.now;
  try {
    Date.now = () => orig() + 11 * 60_000;

    // Second tick: empty mempool, but evictExpired() runs and prunes the entry.
    mempool.set([]);
    await solver.tick();

    assert.equal(retryState.size(), 0, "retryState entry should be pruned by evictExpired() after TTL");
  } finally {
    Date.now = orig;
  }
});

// ---------------------------------------------------------------------------
// #547 – RetryStateLRU: LRU capacity eviction
// ---------------------------------------------------------------------------

test("#547: retryState is bounded by retryCacheSize via LRU eviction", () => {
  const solver = new Solver(
    { ...baseConfig, retryCacheSize: 2 },
    { fill: async () => ({ settlementTx: "0x" }) },
    silentLogger,
  );

  const retryState = (solver as any).retryState as {
    size(): number;
    set(hash: string, state: { attempts: number; nextRetryAt: number }, deadlineMs: number): void;
    get(hash: string): unknown;
  };

  const farFuture = Date.now() + 60 * 60_000;

  retryState.set("0xaaaa", { attempts: 1, nextRetryAt: 0 }, farFuture);
  retryState.set("0xbbbb", { attempts: 1, nextRetryAt: 0 }, farFuture);
  assert.equal(retryState.size(), 2, "two entries fit within capacity");

  // Inserting a third evicts the LRU entry (0xaaaa).
  retryState.set("0xcccc", { attempts: 1, nextRetryAt: 0 }, farFuture);
  assert.equal(retryState.size(), 2, "size stays at capacity after LRU eviction");
  assert.equal(retryState.get("0xaaaa"), undefined, "0xaaaa (LRU) must have been evicted");
  assert.notEqual(retryState.get("0xbbbb"), undefined, "0xbbbb should still be present");
  assert.notEqual(retryState.get("0xcccc"), undefined, "0xcccc should be present");
});

// ---------------------------------------------------------------------------
// #547 – resubmitted hash after eviction gets fresh state
// ---------------------------------------------------------------------------

test("#547: resubmitted hash after TTL eviction gets a fresh attempt counter", () => {
  const solver = new Solver(
    baseConfig,
    { fill: async () => ({ settlementTx: "0x" }) },
    silentLogger,
  );

  const retryState = (solver as any).retryState as {
    size(): number;
    set(hash: string, state: { attempts: number; nextRetryAt: number }, deadlineMs: number): void;
    get(hash: string): { attempts: number } | undefined;
    evictExpired(): number;
  };

  const hash = "0xdeadbeef00000000000000000000000000000000000000000000000000001234";
  // Insert with a past deadline.
  retryState.set(hash, { attempts: 2, nextRetryAt: 0 }, Date.now() - 1);

  // Evict.
  retryState.evictExpired();
  assert.equal(retryState.get(hash), undefined, "entry should be gone after eviction");

  // Re-insert as fresh.
  retryState.set(hash, { attempts: 1, nextRetryAt: 0 }, Date.now() + 60_000);
  assert.equal(retryState.get(hash)?.attempts, 1, "resubmitted hash starts fresh (attempts=1)");
});

// ---------------------------------------------------------------------------
// #546 – InFlightTracker unit tests
// ---------------------------------------------------------------------------

test("#546 InFlightTracker: holdForRefresh keeps capital committed immediately after fill", () => {
  const tracker = new InFlightTracker();
  tracker.reserve("native", 990_000n);
  tracker.holdForRefresh("native", 990_000n);

  assert.equal(
    tracker.reservedFor("native"), 990_000n,
    "capital must still appear reserved right after holdForRefresh (held bucket counts)",
  );
});

test("#546 InFlightTracker: flushHeld releases the held amount after the tick boundary", () => {
  const tracker = new InFlightTracker();
  tracker.reserve("native", 990_000n);
  tracker.holdForRefresh("native", 990_000n);
  assert.equal(tracker.reservedFor("native"), 990_000n, "held before flush");

  tracker.flushHeld();
  assert.equal(tracker.reservedFor("native"), 0n, "held is zero after flush");
});

test("#546 InFlightTracker: release (definite-failure path) frees capital immediately without holding", () => {
  const tracker = new InFlightTracker();
  tracker.reserve("native", 990_000n);
  tracker.release("native", 990_000n);

  assert.equal(tracker.reservedFor("native"), 0n, "capital immediately free on definite failure");
});

test("#546 InFlightTracker: both reserved and held buckets count toward reservedFor", () => {
  const tracker = new InFlightTracker();
  // Two concurrent fills, one in-flight and one just completed but held.
  tracker.reserve("native", 500_000n);          // in-flight
  tracker.reserve("native", 490_000n);          // second in-flight
  tracker.holdForRefresh("native", 490_000n);   // second fill succeeded, moved to held

  // reserved bucket: 500_000; held bucket: 490_000 → total: 990_000.
  assert.equal(tracker.reservedFor("native"), 990_000n,
    "reservedFor must sum both reserved and held buckets");
});

// ---------------------------------------------------------------------------
// #546 – Solver integration: stale inventory cannot over-commit
// ---------------------------------------------------------------------------

test("#546: successful fill holds reservation — stale inventory cannot over-commit in same tick", async () => {
  // Balance covers exactly one fill. Inventory is deliberately stale: it never
  // updates to reflect the first fill's deduction.
  const intentA = makeIntent();
  const intentB = makeIntent();
  const recordA = makeRecord(intentA);
  const recordB = makeRecord(intentB);

  const staleInventory: InventoryProvider = {
    availableBalance: async () => 990_000n,
  };

  const fillAttempts: string[] = [];
  const executor: Executor = {
    fill: async (r) => {
      fillAttempts.push(r.intent.nonce);
      return { settlementTx: "0xok" };
    },
  };

  setMempool([]);
  const solver = new Solver(
    baseConfig, executor, silentLogger,
    undefined, staleInventory,
    async () => true, pricingDeps,
  );
  const consider = (solver as any).consider.bind(solver) as (r: IntentRecord) => Promise<void>;

  // Fill A: succeeds → reservation moves to `held`.
  await consider(recordA);
  assert.equal(fillAttempts.length, 1, "intentA should fill");

  // B is evaluated in the same tick. Even though stale balance still reads
  // 990_000, the `held` bucket adds 990_000 to reservedFor → available − held = 0.
  // evaluate() must reject B.
  await consider(recordB);
  assert.equal(
    fillAttempts.length, 1,
    "intentB must be blocked: held reservation prevents double-spend against stale balance",
  );
});

test("#546: flushHeld at tick start releases reservation so the next tick fills B", async () => {
  const intentA = makeIntent();
  const intentB = makeIntent();
  const recordA = makeRecord(intentA);
  const recordB = makeRecord(intentB);

  const staleInventory: InventoryProvider = {
    availableBalance: async () => 990_000n,
  };

  const fillAttempts: string[] = [];
  const executor: Executor = {
    fill: async (r) => {
      fillAttempts.push(r.intent.nonce);
      return { settlementTx: "0xok" };
    },
  };

  // Must set up the fetch BEFORE constructing the solver; the SDK client
  // captures globalThis.fetch at construction time.  Use a mutable wrapper
  // so we can swap out which records are "pending" between ticks.
  const mempool = makeMutableMempool();
  mempool.set([recordA]);

  const solver = new Solver(
    baseConfig, executor, silentLogger,
    undefined, staleInventory,
    async () => true, pricingDeps,
  );

  // Tick 1: A fills, reservation moves to held.
  await solver.tick();
  assert.equal(fillAttempts.length, 1, "intentA fills in tick 1");

  // Tick 2: flushHeld() fires at the top of tick, clearing A's held amount.
  // B now sees 990_000 available − 0 reserved = fillable.
  mempool.set([recordB]);
  await solver.tick();
  assert.equal(fillAttempts.length, 2, "intentB fills in tick 2 after held is flushed");
});

// ---------------------------------------------------------------------------
// #546 – DefiniteFailureError releases reservation immediately
// ---------------------------------------------------------------------------

test("#546: DefiniteFailureError releases reservation immediately (no tick boundary needed)", async () => {
  const intentA = makeIntent();
  const intentB = makeIntent();
  const recordA = makeRecord(intentA);
  const recordB = makeRecord(intentB);

  const inventory: InventoryProvider = { availableBalance: async () => 990_000n };

  const fillAttempts: string[] = [];
  const executor: Executor = {
    fill: async (r) => {
      fillAttempts.push(r.intent.nonce);
      if (r.intent.nonce === intentA.nonce) {
        throw new DefiniteFailureError("on-chain revert: InsufficientBalance");
      }
      return { settlementTx: "0xok" };
    },
  };

  setMempool([]);
  const solver = new Solver(
    baseConfig, executor, silentLogger,
    undefined, inventory,
    async () => true, pricingDeps,
  );
  const consider = (solver as any).consider.bind(solver) as (r: IntentRecord) => Promise<void>;

  // A fails with DefiniteFailureError → immediate release (not held).
  await consider(recordA);
  assert.equal(fillAttempts.length, 1, "intentA attempted and failed definitively");

  // B fills in the same tick: A's reservation was released immediately.
  await consider(recordB);
  assert.equal(
    fillAttempts.length, 2,
    "intentB must fill immediately after DefiniteFailureError released A's reservation",
  );
});

test("#546: indefinite failure (generic Error) holds reservation until next tick", async () => {
  const intentA = makeIntent();
  const intentB = makeIntent();
  const recordA = makeRecord(intentA);
  const recordB = makeRecord(intentB);

  const inventory: InventoryProvider = { availableBalance: async () => 990_000n };

  const fillAttempts: string[] = [];
  const executor: Executor = {
    fill: async (r) => {
      fillAttempts.push(r.intent.nonce);
      if (r.intent.nonce === intentA.nonce) {
        throw new Error("confirmation timeout"); // indefinite — tx may have landed
      }
      return { settlementTx: "0xok" };
    },
  };

  // Use a mutable mempool wrapper (SDK client captures fetch at construction time).
  const mempool = makeMutableMempool();
  mempool.set([]);

  const solver = new Solver(
    baseConfig, executor, silentLogger,
    undefined, inventory,
    async () => true, pricingDeps,
  );
  const consider = (solver as any).consider.bind(solver) as (r: IntentRecord) => Promise<void>;

  // A fails with an indefinite error → reservation moves to held, not released.
  await consider(recordA);
  assert.equal(fillAttempts.length, 1, "intentA attempted");

  // B in the same tick: held reservation blocks it (stale balance = 990_000,
  // held = 990_000 → net available = 0).
  await consider(recordB);
  assert.equal(
    fillAttempts.length, 1,
    "intentB must be blocked while A's reservation is held (indefinite failure)",
  );

  // After a tick boundary, flushHeld() runs and B can fill.
  mempool.set([recordB]);
  await solver.tick(); // flushHeld fires at top
  assert.equal(fillAttempts.length, 2, "intentB fills after held is flushed at next tick");
});
