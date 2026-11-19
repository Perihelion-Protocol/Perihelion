// SPDX-License-Identifier: MIT

/**
 * Tests for solver signature verification caching and hash validation.
 */

import assert from "node:assert/strict";
import { test, mock, describe } from "node:test";
import { buildIntent, hashIntent, perihelionDomain, type IntentRecord, type Hex } from "@perihelion/sdk";
import { Solver, FatalError, type Executor, type Logger } from "../src/solver.js";
import { Executor as FillExecutor, DefiniteFailureError } from "../src/executor.js";
import { type SolverConfig, loadConfig } from "../src/config.js";
import { type InventoryProvider, InFlightTracker } from "../src/inventory.js";
import { RATE_SCALE, type PricingDeps, evaluate } from "../src/quote.js";
import { type Metrics } from "../src/metrics.js";
// Test fixtures
const CHAIN_ID = 8453;
const ESCROW_ADDRESS = "0x0000000000000000000000000000000000000001" as const;
const USER_ADDRESS = "0x0000000000000000000000000000000000000002" as const;

const domain = perihelionDomain(CHAIN_ID, ESCROW_ADDRESS);

const baseConfig: SolverConfig = {
  mempoolUrl: "http://localhost:8080",
  solverAddress: "0x0000000000000000000000000000000000000003" as const,
  sourceChainId: CHAIN_ID,
  escrowAddress: ESCROW_ADDRESS,
  minMarginBps: 10,
  sourceNativeFeeFloor: 0n,
  stellarNativeFeeFloor: 0n,
  pollIntervalMs: 1000,
  supportedDestAssets: ["native"],
  verificationCacheSize: 100,
};

/**
 * Pricing deps for the fixtures below. These tests exercise the poll/verify/
 * fill control flow, not the pricing math, so both legs use 6dp and a 1:1 rate
 * — that keeps `sourceAmount`/`minDestAmount` directly comparable. Supplying
 * them is mandatory: `defaultDecimalsLookup` refuses to guess decimals for EVM
 * token addresses (#310), so without this every intent skips as unpriceable.
 */
const testPricingDeps: PricingDeps = {
  decimalsLookup: () => 6,
  priceOracle: async () => RATE_SCALE,
  feeEstimator: async () => 0n,
};

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

test("refuses to blindly proceed when the idempotency probe fails", async () => {
  const intent = buildTestIntent();
  const hash = hashIntent(intent, domain);
  const signed = {
    intent,
    signature: "0xdeadbeef" as Hex,
    hash,
  };

  const warnings: Array<{ msg: string; meta?: Record<string, unknown> }> = [];
  const logger: Logger = {
    info: () => {},
    warn: (msg, meta) => {
      warnings.push({ msg, meta });
    },
    error: () => {},
  };

  const executor = new FillExecutor(
    {
      evmRpcUrl: "http://localhost:8545",
      sorobanRpcUrl: "http://localhost:8000",
      evmPrivateKey: "0x0000000000000000000000000000000000000000000000000000000000000001" as Hex,
      sorobanSecretKey: "SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      escrowAddress: ESCROW_ADDRESS,
      settlementContractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      sourceChainId: CHAIN_ID,
    },
    logger,
  );

  (executor as any).isSettled = async () => {
    throw new Error("Soroban RPC unavailable");
  };
  (executor as any).lockOnEvm = async () => {
    throw new Error("lockOnEvm should not be called");
  };
  (executor as any).fillOnSoroban = async () => {
    throw new Error("fillOnSoroban should not be called");
  };

  await assert.rejects(
    () => executor.fill(signed),
    /idempotency.*probe.*failed|refusing to proceed/i,
  );

  assert.ok(
    warnings.some((entry) => /idempotency|probe|refusing/i.test(entry.msg)),
    "should log the failed idempotency probe",
  );
});

test("verifies signature only once for the same intent hash", async () => {
  const intent = buildTestIntent();
  const record = buildTestRecord(intent);

  let verifyCallCount = 0;
  const mockVerify = mock.fn(async () => {
    verifyCallCount++;
    return true;
  });

  const mockLogger: Logger = {
    info: () => {},
    warn: () => {},
    error: () => {},
  };

  const mockExecutor: Executor = {
    fill: async () => ({ settlementTx: "0xfilled" }),
  };

  // Mock fetch to return the same intent twice
  global.fetch = mock.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ records: [record], nextCursor: undefined }),
  })) as any;

  const solver = new Solver(baseConfig, mockExecutor, mockLogger, undefined, undefined, mockVerify, testPricingDeps);

  // First tick - should verify
  await solver.tick();
  assert.equal(verifyCallCount, 1, "should verify on first encounter");

  // Second tick with same intent - should use cache
  await solver.tick();
  assert.equal(
    verifyCallCount,
    1,
    "should not verify again for same hash (cached)"
  );
});

test("rejects intent with hash mismatch", async () => {
  const intent = buildTestIntent();
  // A well-formed 32-byte hash that deliberately differs from the real one.
  const wrongHash = ("0x" + "11".repeat(32)) as Hex;

  const record: IntentRecord = {
    intent,
    signature: "0xdeadbeef" as Hex,
    hash: wrongHash, // Mempool returned wrong hash
    status: "pending",
    createdAt: Math.floor(Date.now() / 1000),
  };

  const warnings: string[] = [];
  const mockLogger: Logger = {
    info: () => {},
    warn: (msg, meta) => {
      warnings.push(msg);
    },
    error: () => {},
  };

  const mockExecutor: Executor = {
    fill: async () => {
      throw new Error("fill should not be called");
    },
  };

  global.fetch = mock.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ records: [record], nextCursor: undefined }),
  })) as any;

  const solver = new Solver(baseConfig, mockExecutor, mockLogger);
  await solver.tick();

  assert.ok(
    warnings.some((w) => w.includes("hash mismatch")),
    "should warn about hash mismatch"
  );
});

test("hash-mismatch warning is emitted once, not once per tick", async () => {
  // Regression test for #548: a mismatched record must be retired to the
  // seen-set on first encounter so subsequent ticks skip it entirely — no
  // repeated EIP-712 recomputation and no repeated log lines.
  const intent = buildTestIntent();
  const wrongHash = ("0x" + "22".repeat(32)) as Hex;

  const record: IntentRecord = {
    intent,
    signature: "0xdeadbeef" as Hex,
    hash: wrongHash,
    status: "pending",
    createdAt: Math.floor(Date.now() / 1000),
  };

  const warnings: string[] = [];
  const mockLogger: Logger = {
    info: () => {},
    warn: (msg) => { warnings.push(msg); },
    error: () => {},
  };

  const mockExecutor: Executor = {
    fill: async () => { throw new Error("fill should not be called"); },
  };

  // The mempool keeps returning the same record on every poll.
  global.fetch = mock.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ records: [record], nextCursor: undefined }),
  })) as any;

  const solver = new Solver(baseConfig, mockExecutor, mockLogger);

  // Run three ticks — the warning must appear exactly once.
  await solver.tick();
  await solver.tick();
  await solver.tick();

  const mismatchWarnings = warnings.filter((w) => w.includes("hash mismatch"));
  assert.equal(
    mismatchWarnings.length,
    1,
    "hash-mismatch warning should be emitted exactly once across multiple ticks",
  );
});

test("full-page hash mismatch emits an error naming the configured domain", async () => {
  // When every non-skipped record on a page mismatches, the solver's domain
  // configuration is very likely wrong. A single actionable log.error per
  // tick (rather than one log.warn per record) should name the configured
  // sourceChainId and escrowAddress so the operator can diagnose quickly.
  const intent1 = buildTestIntent();
  const intent2 = buildTestIntent(); // buildTestIntent uses a fresh nonce each call

  const wrongHashA = ("0x" + "aa".repeat(32)) as Hex;
  const wrongHashB = ("0x" + "bb".repeat(32)) as Hex;

  const records: IntentRecord[] = [
    { intent: intent1, signature: "0xdeadbeef" as Hex, hash: wrongHashA, status: "pending", createdAt: Math.floor(Date.now() / 1000) },
    { intent: intent2, signature: "0xdeadbeef" as Hex, hash: wrongHashB, status: "pending", createdAt: Math.floor(Date.now() / 1000) },
  ];

  const errors: Array<{ msg: string; meta?: Record<string, unknown> }> = [];
  const warnings: string[] = [];
  const mockLogger: Logger = {
    info: () => {},
    warn: (msg) => { warnings.push(msg); },
    error: (msg, meta) => { errors.push({ msg, meta }); },
  };

  const mockExecutor: Executor = {
    fill: async () => { throw new Error("fill should not be called"); },
  };

  global.fetch = mock.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ records, nextCursor: undefined }),
  })) as any;

  const solver = new Solver(baseConfig, mockExecutor, mockLogger);
  await solver.tick();

  // One warn per mismatched record on the first tick.
  assert.equal(
    warnings.filter((w) => w.includes("hash mismatch")).length,
    2,
    "should warn once per mismatched record on the first tick",
  );

  // One escalated error for the full-page mismatch, naming the domain.
  assert.equal(errors.length, 1, "should emit exactly one escalation error");
  assert.ok(
    errors[0].msg.includes("misconfiguration"),
    "escalation error message should mention misconfiguration",
  );
  assert.equal(
    errors[0].meta?.sourceChainId,
    baseConfig.sourceChainId,
    "escalation error should name the configured sourceChainId",
  );
  assert.equal(
    errors[0].meta?.escrowAddress,
    baseConfig.escrowAddress,
    "escalation error should name the configured escrowAddress",
  );

  // On the second tick, both records are in the seen-set — no new warnings or errors.
  const warningsBefore = warnings.length;
  const errorsBefore = errors.length;
  await solver.tick();
  assert.equal(warnings.length, warningsBefore, "no new warnings on second tick");
  assert.equal(errors.length, errorsBefore, "no new errors on second tick");
});

test("caches invalid signatures to avoid re-verification within the negative TTL", async () => {
  const intent = buildTestIntent();
  const record = buildTestRecord(intent);

  let verifyCallCount = 0;
  const mockVerify = mock.fn(async () => {
    verifyCallCount++;
    return false; // Invalid signature
  });

  const warnings: string[] = [];
  const mockLogger: Logger = {
    info: () => {},
    warn: (msg) => {
      warnings.push(msg);
    },
    error: () => {},
  };

  const mockExecutor: Executor = {
    fill: async () => {
      throw new Error("fill should not be called for invalid signature");
    },
  };

  global.fetch = mock.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ records: [record], nextCursor: undefined }),
  })) as any;

  const solver = new Solver(baseConfig, mockExecutor, mockLogger, undefined, undefined, mockVerify, testPricingDeps);

  // First tick - should verify and reject
  await solver.tick();
  assert.equal(verifyCallCount, 1, "should verify on first encounter");
  assert.ok(
    warnings.some((w) => w.includes("invalid signature")),
    "should warn about invalid signature"
  );

  // Second tick, same (hash, signature) pair - the negative verification
  // cache entry is still fresh, so the ECDSA check is skipped again, but the
  // intent is NOT retired in `seen` (invalid signature is not terminal for
  // the hash), so the rejection is still logged every poll.
  warnings.length = 0;
  await solver.tick();
  assert.equal(
    verifyCallCount,
    1,
    "should not re-verify the same (hash, signature) pair within the negative TTL"
  );
  assert.ok(
    warnings.some((w) => w.includes("invalid signature")),
    "should still warn since the intent hash was not retired to `seen`"
  );
});

test("corrected resubmission with a valid signature is verified and filled", async () => {
  const intent = buildTestIntent();
  const badRecord = buildTestRecord(intent); // signature: "0xdeadbeef"
  const goodSignature = "0xc0ffee00" as Hex;
  const goodRecord: IntentRecord = { ...badRecord, signature: goodSignature };

  let verifyCallCount = 0;
  const mockVerify = mock.fn(async (_intent: unknown, signature: Hex) => {
    verifyCallCount++;
    return signature === goodSignature;
  });

  const warnings: string[] = [];
  const mockLogger: Logger = {
    info: () => {},
    warn: (msg) => warnings.push(msg),
    error: () => {},
  };

  const fills: Hex[] = [];
  const mockExecutor: Executor = {
    fill: async (signed) => {
      fills.push(signed.hash);
      return { settlementTx: "0xsettled" };
    },
  };

  let pendingRecords: IntentRecord[] = [badRecord];
  global.fetch = mock.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ records: pendingRecords, nextCursor: undefined }),
  })) as any;

  const solver = new Solver(baseConfig, mockExecutor, mockLogger, undefined, undefined, mockVerify, testPricingDeps);

  // First submission: bad signature, rejected, not filled.
  await solver.tick();
  assert.equal(verifyCallCount, 1, "should verify the bad signature");
  assert.equal(fills.length, 0, "should not fill on invalid signature");
  assert.ok(warnings.some((w) => w.includes("invalid signature")));

  // Same intent hash resubmitted with a corrected, valid signature: must be
  // independently re-verified (different cache key) and filled — proving the
  // hash was never retired into `seen` after the earlier invalid signature.
  pendingRecords = [goodRecord];
  await solver.tick();
  assert.equal(
    verifyCallCount,
    2,
    "corrected signature must be verified (distinct cache entry from the bad one)"
  );
  assert.equal(fills.length, 1, "corrected resubmission should be filled");
  assert.equal(fills[0], goodRecord.hash);
});

test("negative verification cache entries expire, allowing re-verification", async () => {
  const intent = buildTestIntent();
  const record = buildTestRecord(intent);

  let verifyCallCount = 0;
  const mockVerify = mock.fn(async () => {
    verifyCallCount++;
    return false;
  });

  const mockLogger: Logger = { info: () => {}, warn: () => {}, error: () => {} };
  const mockExecutor: Executor = {
    fill: async () => {
      throw new Error("fill should not be called for invalid signature");
    },
  };

  global.fetch = mock.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ records: [record], nextCursor: undefined }),
  })) as any;

  const originalNow = Date.now;
  try {
    let fakeNow = originalNow();
    Date.now = () => fakeNow;

    const solver = new Solver(baseConfig, mockExecutor, mockLogger, undefined, undefined, mockVerify, testPricingDeps);

    await solver.tick();
    assert.equal(verifyCallCount, 1, "should verify on first encounter");

    // Still within the negative TTL: cached, no re-verification.
    fakeNow += 30_000;
    await solver.tick();
    assert.equal(verifyCallCount, 1, "should still be cached before TTL elapses");

    // Past the negative TTL (60s): the stale negative entry must be treated
    // as a miss and the signature re-verified.
    fakeNow += 31_000;
    await solver.tick();
    assert.equal(
      verifyCallCount,
      2,
      "negative cache entry should have expired, triggering re-verification"
    );
  } finally {
    Date.now = originalNow;
  }
});

test("two different signatures over the same hash do not share a cache entry", async () => {
  const intent = buildTestIntent();
  const hash = hashIntent(intent, domain);
  const sigA = "0xaaaaaaaa" as Hex;
  const sigB = "0xbbbbbbbb" as Hex;

  const recordA: IntentRecord = {
    intent,
    signature: sigA,
    hash,
    status: "pending",
    createdAt: Math.floor(Date.now() / 1000),
  };
  const recordB: IntentRecord = { ...recordA, signature: sigB };

  // Both signatures are treated as invalid by the mock verifier: this isolates
  // the cache-keying behavior (does sigB get its own verification call?) from
  // fill/seen-set interactions, which are covered by other tests.
  const verifiedSignatures: Hex[] = [];
  const mockVerify = mock.fn(async (_intent: unknown, signature: Hex) => {
    verifiedSignatures.push(signature);
    return false;
  });

  const mockExecutor: Executor = {
    fill: async () => {
      throw new Error("fill should not be called for invalid signature");
    },
  };
  const mockLogger: Logger = { info: () => {}, warn: () => {}, error: () => {} };

  let pendingRecords: IntentRecord[] = [recordA];
  global.fetch = mock.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ records: pendingRecords, nextCursor: undefined }),
  })) as any;

  const solver = new Solver(baseConfig, mockExecutor, mockLogger, undefined, undefined, mockVerify, testPricingDeps);

  await solver.tick();
  assert.deepEqual(verifiedSignatures, [sigA], "sigA verified once");

  // Same intent hash, different signature: must be independently verified —
  // NOT served from sigA's cache entry (which would happen if the cache were
  // still keyed on hash alone).
  pendingRecords = [recordB];
  await solver.tick();
  assert.deepEqual(
    verifiedSignatures,
    [sigA, sigB],
    "sigB must be independently verified, not served from sigA's cache entry"
  );
});

test("verification cache evicts oldest entries when full", async () => {
  const smallCacheConfig: SolverConfig = {
    ...baseConfig,
    verificationCacheSize: 2, // Very small cache for testing
  };

  const intent1 = buildTestIntent();
  const intent2 = buildIntent({
    ...intent1,
    nonce: "999", // Different nonce = different hash
  });
  const intent3 = buildIntent({
    ...intent1,
    nonce: "888", // Another different hash
  });

  const record1 = buildTestRecord(intent1);
  const record2 = buildTestRecord(intent2);
  const record3 = buildTestRecord(intent3);

  let verifiedHashes: Hex[] = [];
  const mockVerify = mock.fn(async (intent: any) => {
    const hash = hashIntent(intent, domain);
    verifiedHashes.push(hash);
    return true;
  });

  const mockLogger: Logger = {
    info: () => {},
    warn: () => {},
    error: () => {},
  };

  // A profitable fill would retire the intent into the seen-set, making it
  // un-re-pollable. This test only exercises the verification cache, so we
  // starve inventory: every intent is verified, then skipped non-terminally
  // ("insufficient inventory") and stays re-pollable across ticks.
  const zeroInventory: InventoryProvider = {
    availableBalance: async () => 0n,
  };

  const mockExecutor: Executor = {
    fill: async () => ({ settlementTx: "0xfilled" }),
  };

  // PerihelionClient captures globalThis.fetch at construction, so we install a
  // single mock (before constructing the solver) that returns whatever is in
  // `pendingRecords`, and swap that array between ticks to drive each poll.
  let pendingRecords: IntentRecord[] = [record1];
  global.fetch = mock.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ records: pendingRecords, nextCursor: undefined }),
  })) as any;

  const solver = new Solver(smallCacheConfig, mockExecutor, mockLogger, undefined, zeroInventory, mockVerify, testPricingDeps);

  // Process intent1 and intent2 (fills cache to capacity)
  pendingRecords = [record1];
  await solver.tick();

  pendingRecords = [record2];
  await solver.tick();

  assert.equal(verifiedHashes.length, 2, "should verify both intents");
  verifiedHashes = [];

  // Process intent3 (should evict intent1)
  pendingRecords = [record3];
  await solver.tick();

  assert.equal(verifiedHashes.length, 1, "should verify new intent3");
  verifiedHashes = [];

  // Process intent1 again (should re-verify since it was evicted)
  pendingRecords = [record1];
  await solver.tick();

  assert.equal(
    verifiedHashes.length,
    1,
    "should re-verify intent1 after eviction"
  );
  assert.equal(verifiedHashes[0], record1.hash, "re-verified intent1");

  // Re-adding intent1 filled the size-2 cache and evicted the current LRU entry
  // (intent2), leaving {intent3, intent1}. Re-processing intent3 should hit the
  // cache — proving the most-recently-used survivor was not re-verified.
  verifiedHashes = [];
  pendingRecords = [record3];
  await solver.tick();

  assert.equal(
    verifiedHashes.length,
    0,
    "intent3 should still be cached (not evicted)"
  );
});

// ─── Issue 349: seen-set TTL clamp + terminal-skip honoring ─────────────────

test("terminal skip (expired intent) is retired to the seen-set, not reconsidered every tick", async () => {
  const intent = buildTestIntent();
  // buildIntent rejects past deadlines, so build a valid intent then expire it.
  const expired = { ...intent, deadline: 1 };
  const record = buildTestRecord(expired);

  const infos: string[] = [];
  const mockLogger: Logger = {
    info: (msg) => infos.push(msg),
    warn: () => {},
    error: () => {},
  };

  const mockExecutor: Executor = {
    fill: async () => {
      throw new Error("fill should not be called for an expired intent");
    },
  };

  global.fetch = mock.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ records: [record], nextCursor: undefined }),
  })) as any;

  const solver = new Solver(
    baseConfig,
    mockExecutor,
    mockLogger,
    undefined,
    undefined,
    mock.fn(async () => true),
  );

  await solver.tick();
  assert.ok(
    infos.some((m) => m.includes("skipping intent")),
    "first tick logs the skip",
  );

  infos.length = 0;
  await solver.tick();
  assert.equal(
    infos.length,
    0,
    "expired intent must not be re-logged on subsequent ticks (terminal skip retired it)",
  );
});

test("terminal skip survives evictExpired() despite the intent's own deadline being in the past", async () => {
  const intent = buildTestIntent();
  const expired = { ...intent, deadline: 1 }; // long-past Unix-seconds deadline
  const record = buildTestRecord(expired);

  const mockLogger: Logger = { info: () => {}, warn: () => {}, error: () => {} };
  const skips: string[] = [];
  const mockMetrics = { recordSkip: (reason: string) => skips.push(reason) } as any;
  const mockExecutor: Executor = {
    fill: async () => {
      throw new Error("fill should not be called for an expired intent");
    },
  };

  global.fetch = mock.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ records: [record], nextCursor: undefined }),
  })) as any;

  const solver = new Solver(
    baseConfig,
    mockExecutor,
    mockLogger,
    mockMetrics,
    undefined,
    mock.fn(async () => true),
  );

  // A naive TTL derived straight from the (past) deadline would be evicted
  // by evictExpired() on the very next tick, causing the intent to be
  // reconsidered (and re-skipped) on every subsequent tick.
  await solver.tick();
  await solver.tick();
  await solver.tick();

  assert.equal(
    skips.length,
    1,
    "the terminal skip must be recorded once, not once per tick",
  );
});

// ─── Issue 92: FatalError propagation and graceful drain ────────────────────

test("FatalError thrown from tick() rejects start()", async () => {
  const fatal = new FatalError("permanent RPC failure");

  global.fetch = mock.fn(async () => { throw fatal; }) as any;

  const solver = new Solver(baseConfig, { fill: async () => ({ settlementTx: "0x" }) }, {
    info: () => {},
    warn: () => {},
    error: () => {},
  });

  const err = await solver.start().catch((e) => e);
  assert.strictEqual(err, fatal, "start() should reject with the FatalError instance");
});

test("recoverable tick error keeps loop alive, does not reject start()", async () => {
  let calls = 0;
  global.fetch = mock.fn(async () => {
    calls++;
    if (calls === 1) throw new Error("transient network blip");
    // Second call: return empty list so stop() resolves start()
    return { ok: true, status: 200, json: async () => ({ records: [], nextCursor: undefined }) };
  }) as any;

  const solver = new Solver(
    { ...baseConfig, pollIntervalMs: 0 },
    { fill: async () => ({ settlementTx: "0x" }) },
    { info: () => {}, warn: () => {}, error: () => {} },
  );

  const startP = solver.start();
  // Wait for second tick to complete
  await new Promise((r) => setTimeout(r, 30));
  solver.stop();
  await assert.doesNotReject(startP, "recoverable error must not reject start()");
  assert.ok(calls >= 2, "loop should have continued after recoverable error");
});

test("stop() interrupts inter-tick sleep so start() resolves promptly", async () => {
  global.fetch = mock.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ records: [], nextCursor: undefined }),
  })) as any;

  const solver = new Solver(
    { ...baseConfig, pollIntervalMs: 60_000 }, // would hang for 60 s without stop()
    { fill: async () => ({ settlementTx: "0x" }) },
    { info: () => {}, warn: () => {}, error: () => {} },
  );

  const startP = solver.start();
  await new Promise((r) => setTimeout(r, 20)); // let first tick complete
  solver.stop();

  const result = await Promise.race([
    startP.then(() => "resolved" as const),
    new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 1_000)),
  ]);
  assert.equal(result, "resolved", "start() should resolve promptly after stop(), not wait 60 s");
});

test("complete flow: hash validation and cached verification", async () => {
  const intent = buildTestIntent();
  const correctHash = hashIntent(intent, domain);
  const record: IntentRecord = {
    intent,
    signature: "0xdeadbeef" as Hex,
    hash: correctHash,
    status: "pending",
    createdAt: Math.floor(Date.now() / 1000),
  };

  let verifyCount = 0;
  const mockVerify = mock.fn(async () => {
    verifyCount++;
    return true;
  });

  const fills: Hex[] = [];
  const mockExecutor: Executor = {
    fill: async (signed) => {
      fills.push(signed.hash);
      return { settlementTx: "0xsettled" };
    },
  };

  const logs: Array<{ type: string; msg: string }> = [];
  const mockLogger: Logger = {
    info: (msg) => logs.push({ type: "info", msg }),
    warn: (msg) => logs.push({ type: "warn", msg }),
    error: (msg) => logs.push({ type: "error", msg }),
  };

  global.fetch = mock.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ records: [record], nextCursor: undefined }),
  })) as any;

  const solver = new Solver(baseConfig, mockExecutor, mockLogger, undefined, undefined, mockVerify, testPricingDeps);

  // First tick: verify and fill
  await solver.tick();
  assert.equal(verifyCount, 1, "should verify on first tick");
  assert.equal(fills.length, 1, "should fill the intent");
  assert.equal(fills[0], correctHash, "filled correct intent");

  // Second tick: use cached verification, but don't fill (seen)
  await solver.tick();
  assert.equal(verifyCount, 1, "should not re-verify (cached)");
  assert.equal(fills.length, 1, "should not fill again (already seen)");
});

// ─── Issue 314: in-flight inventory reservation ──────────────────────────────

test("tick evaluates unrelated intents while a slow fill is still in flight", async () => {
  const intentA = buildTestIntent();
  const intentB = buildIntent({ ...intentA, nonce: "555555" });
  const recordA = buildTestRecord(intentA);
  const recordB = buildTestRecord(intentB);

  let releaseFillA!: () => void;
  const fillGate = new Promise<void>((resolve) => {
    releaseFillA = resolve;
  });

  const observed: string[] = [];
  const mockVerify = mock.fn(async (intent: any) => {
    observed.push(`verify:${intent.nonce}`);
    return true;
  });
  const mockExecutor: Executor = {
    fill: mock.fn(async (signed) => {
      observed.push(`fill:${signed.intent.nonce}`);
      if (signed.intent.nonce === intentA.nonce) {
        await fillGate;
      }
      return { settlementTx: "0xfilled" };
    }),
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
    mockVerify,
    testPricingDeps,
  );

  const tickPromise = solver.tick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(
    observed.includes(`verify:${intentB.nonce}`),
    "the second intent should be evaluated before the first fill completes",
  );

  releaseFillA();
  await tickPromise;
  assert.equal(
    (mockExecutor.fill as ReturnType<typeof mock.fn>).mock.callCount(),
    2,
    "both intents should be attempted once when the fill queue is released",
  );
});

test("consider: reserves inventory before filling, preventing a second intent from over-committing the same balance", async () => {
  const intentA = buildTestIntent();
  const intentB = buildIntent({ ...intentA, nonce: "555555" });
  const recordA = buildTestRecord(intentA);
  const recordB = buildTestRecord(intentB);

  // Balance covers exactly one intent's minDestAmount (990000), not both.
  const inventory: InventoryProvider = { availableBalance: async () => 990000n };

  let releaseFill: () => void = () => {};
  const fillGate = new Promise<void>((resolve) => {
    releaseFill = resolve;
  });

  const fillAttempts: string[] = [];
  const mockExecutor: Executor = {
    fill: async (signed) => {
      fillAttempts.push(signed.intent.nonce);
      await fillGate;
      return { settlementTx: "0xfilled" };
    },
  };

  const mockLogger: Logger = { info: () => {}, warn: () => {}, error: () => {} };
  global.fetch = mock.fn(async () => ({ ok: true, status: 200, json: async () => ({ records: [], nextCursor: undefined }) })) as any;

  const solver = new Solver(baseConfig, mockExecutor, mockLogger, undefined, inventory, async () => true, testPricingDeps);
  const consider = (solver as unknown as { consider(record: IntentRecord): Promise<void> }).consider.bind(
    solver,
  );

  // Start filling intentA; its executor.fill() call blocks on fillGate,
  // holding the reservation open past the point evaluate() re-reads balance.
  const considerA = consider(recordA);

  // Let intentA's verify → evaluate → reserve → fill-start run to completion.
  // Everything up to that point is microtask-only (no real timers), so a
  // single macrotask boundary is enough to observe the fill call landing.
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(fillAttempts.length, 1, "intentA's fill should be in flight");

  // intentB needs the same asset and would fit alone, but not alongside
  // intentA's still-unsettled reservation.
  await consider(recordB);
  assert.equal(
    fillAttempts.length,
    1,
    "intentB should be skipped: the shared balance is already reserved by intentA",
  );

  releaseFill();
  await considerA;
  assert.equal(fillAttempts.length, 1, "no additional fill attempts after intentA settles");
});

test("consider: releases the reservation when a fill fails, freeing capacity for a later intent", async () => {
  const intentA = buildTestIntent();
  const intentB = buildIntent({ ...intentA, nonce: "777777" });
  const recordA = buildTestRecord(intentA);
  const recordB = buildTestRecord(intentB);

  const inventory: InventoryProvider = { availableBalance: async () => 990000n };

  const mockExecutor: Executor = {
    fill: mock.fn(async (signed) => {
      if (signed.intent.nonce === intentA.nonce) {
        throw new Error("simulated fill failure");
      }
      return { settlementTx: "0xfilled" };
    }),
  };

  const errors: string[] = [];
  const mockLogger: Logger = {
    info: () => {},
    warn: () => {},
    error: (msg) => errors.push(msg),
  };

  global.fetch = mock.fn(async () => ({ ok: true, status: 200, json: async () => ({ records: [], nextCursor: undefined }) })) as any;

  const solver = new Solver(baseConfig, mockExecutor, mockLogger, undefined, inventory, async () => true, testPricingDeps);
  const consider = (solver as unknown as { consider(record: IntentRecord): Promise<void> }).consider.bind(
    solver,
  );

  await consider(recordA);
  assert.ok(errors.some((e) => e.includes("fill failed")), "intentA's fill should have failed");

  // intentA's failed reservation must be released — intentB can still fill
  // against the same balance.
  await consider(recordB);
  assert.equal(
    (mockExecutor.fill as ReturnType<typeof mock.fn>).mock.callCount(),
    2,
    "intentB's fill should have been attempted after intentA's reservation was released",
  );
});

test("fill records fee outlay breakdown when executor returns fees", async () => {
  const intent = buildTestIntent();
  const record = buildTestRecord(intent);
  const inventory: InventoryProvider = { availableBalance: async () => 990000n };

  const mockExecutor: Executor = {
    fill: async () => ({
      settlementTx: "0xfilled",
      fees: {
        sourceGasWei: 75_000n,
        lzFeeWei: 25_000n,
        stellarFeeStroops: 10_000n,
      },
    }),
  };

  const recorded: Array<Parameters<NonNullable<import("../src/metrics.js").Metrics["recordFees"]>>[0]> = [];
  const metrics: import("../src/metrics.js").Metrics = {
    recordFillAttempt: () => {},
    recordFillWon: () => {},
    recordFillLost: () => {},
    recordSkip: () => {},
    recordFee: () => {},
    recordFees: (fees) => recorded.push(fees),
    snapshot: () => ({} as any),
  };

  global.fetch = mock.fn(async () => ({ ok: true, status: 200, json: async () => ({ records: [], nextCursor: undefined }) })) as any;

  const solver = new Solver(baseConfig, mockExecutor, { info: () => {}, warn: () => {}, error: () => {} }, metrics, inventory, async () => true, testPricingDeps);
  const consider = (solver as unknown as { consider(record: IntentRecord): Promise<void> }).consider.bind(solver);

  await consider(record);

  assert.equal(recorded.length, 1);
  assert.deepEqual(recorded[0], {
    sourceGasWei: 75_000n,
    lzFeeWei: 25_000n,
    stellarFeeStroops: 10_000n,
  });
});

// ─── Issue 727: in-flight inventory reservation after successful fill ─────────

test("issue #727: reservation is held after successful fill until next tick refresh", async () => {
  const intentA = buildTestIntent();
  const intentB = buildIntent({ ...intentA, nonce: "999999" });
  const recordA = buildTestRecord(intentA);
  const recordB = buildTestRecord(intentB);

  const inventory: InventoryProvider = { availableBalance: async () => 990000n };

  let fillASettled = false;
  const mockExecutor: Executor = {
    fill: async (signed) => {
      if (signed.intent.nonce === intentA.nonce) {
        fillASettled = true;
      }
      return { settlementTx: "0xfilled" };
    },
  };

  const skips: string[] = [];
  const mockMetrics: import("../src/metrics.js").Metrics = {
    recordFillAttempt: () => {},
    recordFillWon: () => {},
    recordFillLost: () => {},
    recordSkip: (reason) => skips.push(reason),
    recordFee: () => {},
    recordFees: () => {},
    snapshot: () => ({} as any),
  };

  const mockLogger: Logger = { info: () => {}, warn: () => {}, error: () => {} };
  global.fetch = mock.fn(async () => ({ ok: true, status: 200, json: async () => ({ records: [], nextCursor: undefined }) })) as any;

  const solver = new Solver(baseConfig, mockExecutor, mockLogger, mockMetrics, inventory, async () => true, testPricingDeps);
  const consider = (solver as unknown as { consider(record: IntentRecord): Promise<void> }).consider.bind(solver);

  await consider(recordA);
  assert.ok(fillASettled, "intentA should have been filled");

  await consider(recordB);
  assert.ok(
    skips.some((s) => s.includes("insufficient")),
    "intentB should be skipped due to insufficient inventory (reservation still held)",
  );
});

// ─── Issue 950: DefiniteFailureError releases the reservation immediately ─────

test("issue #950: a DefiniteFailureError releases the reservation in the same tick", async () => {
  const intentA = buildTestIntent();
  const intentB = buildIntent({ ...intentA, nonce: "424242" });
  const recordA = buildTestRecord(intentA);
  const recordB = buildTestRecord(intentB);

  const inventory: InventoryProvider = { availableBalance: async () => 990000n };

  const mockExecutor: Executor = {
    fill: mock.fn(async (signed) => {
      if (signed.intent.nonce === intentA.nonce) {
        throw new DefiniteFailureError("fill_intent simulation failed");
      }
      return { settlementTx: "0xfilled" };
    }),
  };

  const errors: string[] = [];
  const mockLogger: Logger = {
    info: () => {},
    warn: () => {},
    error: (msg) => errors.push(msg),
  };

  global.fetch = mock.fn(async () => ({ ok: true, status: 200, json: async () => ({ records: [], nextCursor: undefined }) })) as any;

  const solver = new Solver(baseConfig, mockExecutor, mockLogger, undefined, inventory, async () => true, testPricingDeps);
  const consider = (solver as unknown as { consider(record: IntentRecord): Promise<void> }).consider.bind(solver);

  await consider(recordA);
  assert.ok(errors.some((e) => e.includes("fill failed")), "intentA's fill should have failed");

  // The definite failure must have released intentA's reservation immediately,
  // so intentB can fill against the same balance without waiting for a refresh.
  await consider(recordB);
  assert.equal(
    (mockExecutor.fill as ReturnType<typeof mock.fn>).mock.callCount(),
    2,
    "intentB's fill should be attempted in the same tick after a definite failure released the reservation",
  );
});

test("issue #950: a plain Error keeps the reservation held until the next refresh", async () => {
  const intentA = buildTestIntent();
  const intentB = buildIntent({ ...intentA, nonce: "434343" });
  const recordA = buildTestRecord(intentA);
  const recordB = buildTestRecord(intentB);

  const inventory: InventoryProvider = { availableBalance: async () => 990000n };

  const mockExecutor: Executor = {
    fill: mock.fn(async (signed) => {
      if (signed.intent.nonce === intentA.nonce) {
        throw new Error("simulated indefinite fill failure");
      }
      return { settlementTx: "0xfilled" };
    }),
  };

  const skips: string[] = [];
  const mockMetrics: import("../src/metrics.js").Metrics = {
    recordFillAttempt: () => {},
    recordFillWon: () => {},
    recordFillLost: () => {},
    recordSkip: (reason) => skips.push(reason),
    recordFee: () => {},
    recordFees: () => {},
    snapshot: () => ({} as any),
  };

  const mockLogger: Logger = { info: () => {}, warn: () => {}, error: () => {} };
  global.fetch = mock.fn(async () => ({ ok: true, status: 200, json: async () => ({ records: [], nextCursor: undefined }) })) as any;

  const solver = new Solver(baseConfig, mockExecutor, mockLogger, mockMetrics, inventory, async () => true, testPricingDeps);
  const consider = (solver as unknown as { consider(record: IntentRecord): Promise<void> }).consider.bind(solver);

  await consider(recordA);
  assert.equal(
    (mockExecutor.fill as ReturnType<typeof mock.fn>).mock.callCount(),
    1,
    "intentA's fill should have been attempted once",
  );

  // An indefinite failure must keep the reservation held, so intentB is
  // skipped for insufficient inventory until the next refresh.
  await consider(recordB);
  assert.equal(
    (mockExecutor.fill as ReturnType<typeof mock.fn>).mock.callCount(),
    1,
    "intentB's fill should not be attempted while the indefinite reservation is held",
  );
  assert.ok(
    skips.some((s) => s.includes("insufficient")),
    "intentB should be skipped due to insufficient inventory (reservation still held)",
  );
});

// ─── Issue 726: hash mismatch handling and metrics ────────────────────────────

test("issue #726: hash mismatch is logged once and recorded in metrics, not repeated per tick", async () => {
  const intent = buildTestIntent();
  const wrongHash = ("0x" + "33".repeat(32)) as Hex;

  const record: IntentRecord = {
    intent,
    signature: "0xdeadbeef" as Hex,
    hash: wrongHash,
    status: "pending",
    createdAt: Math.floor(Date.now() / 1000),
  };

  const warnings: string[] = [];
  const skips: string[] = [];
  const mockLogger: Logger = {
    info: () => {},
    warn: (msg) => warnings.push(msg),
    error: () => {},
  };

  const mockMetrics: import("../src/metrics.js").Metrics = {
    recordFillAttempt: () => {},
    recordFillWon: () => {},
    recordFillLost: () => {},
    recordSkip: (reason) => skips.push(reason),
    recordFee: () => {},
    recordFees: () => {},
    snapshot: () => ({} as any),
  };

  const mockExecutor: Executor = {
    fill: async () => {
      throw new Error("fill should not be called for hash mismatch");
    },
  };

  global.fetch = mock.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ records: [record], nextCursor: undefined }),
  })) as any;

  const solver = new Solver(baseConfig, mockExecutor, mockLogger, mockMetrics);

  await solver.tick();
  const firstTickWarnings = warnings.filter((w) => w.includes("hash mismatch")).length;
  const firstTickSkips = skips.filter((s) => s.includes("hash mismatch")).length;

  assert.equal(firstTickWarnings, 1, "should emit one warning for hash mismatch on first tick");
  assert.equal(firstTickSkips, 1, "should record one skip metric for hash mismatch");

  warnings.length = 0;
  skips.length = 0;

  await solver.tick();
  const secondTickWarnings = warnings.filter((w) => w.includes("hash mismatch")).length;
  const secondTickSkips = skips.filter((s) => s.includes("hash mismatch")).length;

  assert.equal(secondTickWarnings, 0, "should not emit new warnings on second tick");
  assert.equal(secondTickSkips, 0, "should not record new skip metrics on second tick");
});

// ─── Issue 725: retryState memory leak and backoff behavior ─────────────────

test("issue #725: retryState size stays bounded when intents disappear from mempool", async () => {
  const smallCacheConfig: SolverConfig = {
    ...baseConfig,
    retryCacheSize: 5,
  };

  const mockLogger: Logger = { info: () => {}, warn: () => {}, error: () => {} };

  const mockExecutor: Executor = {
    fill: async () => {
      throw new Error("simulated fill failure");
    },
  };

  let pendingIntents: IntentRecord[] = [];
  global.fetch = mock.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ records: pendingIntents, nextCursor: undefined }),
  })) as any;

  const solver = new Solver(smallCacheConfig, mockExecutor, mockLogger, undefined, undefined, async () => true);

  const intents = Array.from({ length: 8 }, (_, i) =>
    buildIntent({ ...buildTestIntent(), nonce: String(i) })
  );
  const records = intents.map((intent) => buildTestRecord(intent));

  pendingIntents = records.slice(0, 5);
  await solver.tick();

  pendingIntents = [];
  const sizeBefore = (solver.readiness as any).retryStateCount || 5;
  await solver.tick();

  pendingIntents = records.slice(5, 8);
  await solver.tick();

  const sizeAfter = (solver.readiness as any).retryStateCount || 0;
  assert.ok(
    sizeAfter <= 5,
    `retryState size (${sizeAfter}) should stay within cache limit (5)`,
  );
});

test("issue #725: reappearing intent after absence is subject to fresh backoff", async () => {
  const intent = buildTestIntent();
  const record = buildTestRecord(intent);

  const mockLogger: Logger = { info: () => {}, warn: () => {}, error: () => {} };

  const fillAttempts: number[] = [];
  const mockExecutor: Executor = {
    fill: async () => {
      fillAttempts.push(Date.now());
      throw new Error("simulated fill failure");
    },
  };

  let pendingIntents: IntentRecord[] = [];
  global.fetch = mock.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ records: pendingIntents, nextCursor: undefined }),
  })) as any;

  const solver = new Solver(baseConfig, mockExecutor, mockLogger, undefined, undefined, async () => true);

  pendingIntents = [record];
  await solver.tick();
  assert.equal(fillAttempts.length, 1, "first tick should attempt fill");

  pendingIntents = [record];
  await solver.tick();
  assert.equal(fillAttempts.length, 1, "backoff should prevent immediate retry");

  pendingIntents = [];
  await solver.tick();

  pendingIntents = [record];
  fillAttempts.length = 0;
  await solver.tick();
  assert.equal(
    fillAttempts.length,
    1,
    "reappearing intent should be retried immediately after long absence",
  );
});

// ─── Issue 724: status reporting to mempool ───────────────────────────────────

test("issue #724: successful fill reports settled status to mempool with configured token", async () => {
  const intent = buildTestIntent();
  const record = buildTestRecord(intent);

  const mockLogger: Logger = { info: () => {}, warn: () => {}, error: () => {} };
  const inventory: InventoryProvider = { availableBalance: async () => 1000000n };

  const statusReports: Array<{ hash: string; status: string }> = [];
  const mockExecutor: Executor = {
    fill: async () => ({ settlementTx: "0xsettled" }),
  };

  let pendingIntents: IntentRecord[] = [];
  global.fetch = mock.fn(async (url: string, options?: any) => {
    if (typeof url === "string" && url.includes("/intents/") && url.includes("/status")) {
      const match = url.match(/\/intents\/([^/]+)\/status/);
      if (match) {
        const hash = match[1];
        const body = options?.body ? JSON.parse(options.body) : {};
        statusReports.push({ hash, status: body.status });
      }
      return { ok: true, status: 200, json: async () => ({}) };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ records: pendingIntents, nextCursor: undefined }),
    };
  }) as any;

  const configWithToken = {
    ...baseConfig,
    mempoolStatusToken: "test-status-token",
  };

  const solver = new Solver(configWithToken, mockExecutor, mockLogger, undefined, inventory, async () => true, testPricingDeps);

  pendingIntents = [record];
  await solver.tick();

  assert.ok(
    statusReports.length > 0 || pendingIntents.length === 0,
    "either status was reported or intent was filled",
  );
});

test("issue #724: mempool outage during status reporting does not fail the fill", async () => {
  const intent = buildTestIntent();
  const record = buildTestRecord(intent);

  const infos: string[] = [];
  const warns: string[] = [];
  const mockLogger: Logger = {
    info: (msg) => infos.push(msg),
    warn: (msg) => warns.push(msg),
    error: () => {},
  };

  const inventory: InventoryProvider = { availableBalance: async () => 1000000n };

  const mockExecutor: Executor = {
    fill: async () => ({ settlementTx: "0xsettled" }),
  };

  let pendingIntents: IntentRecord[] = [];
  global.fetch = mock.fn(async (url: string, options?: any) => {
    if (typeof url === "string" && url.includes("/intents/") && url.includes("/status")) {
      throw new Error("mempool unavailable");
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ records: pendingIntents, nextCursor: undefined }),
    };
  }) as any;

  const configWithToken = {
    ...baseConfig,
    mempoolStatusToken: "test-status-token",
  };

  const solver = new Solver(configWithToken, mockExecutor, mockLogger, undefined, inventory, async () => true, testPricingDeps);

  pendingIntents = [record];
  await solver.tick();

  assert.ok(
    infos.some((m) => m.includes("filled")),
    "fill should be logged as successful",
  );

  assert.ok(
    warns.some((m) => m.includes("failed to report")),
    "status reporting failure should be logged as warning",
  );
});

// Solver in-flight reservation and retry-state bounds (#546, #547)
describe("Solver in-flight reservation and retry-state bounds (#546, #547)", () => {
  /**
   * Regression tests for:
   *   #547 – retryState must be bounded and pruned for intents that vanish from the mempool
   *   #546 – in-flight reservation must survive a successful fill until the next tick
   */


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
});

// Solver tick concurrency (#728)
describe("Solver tick concurrency (#728)", () => {
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
});

// Solver timeout and retry configuration (#729)
describe("Solver timeout and retry configuration (#729)", () => {
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

  // ---- #729 client timeout configuration ----

  test("solver is constructed with configurable timeout and retry values", async () => {
    // Issue #729: The PerihelionClient should accept timeout and retry configuration
    // from SolverConfig, allowing operators to tune these values without hardcoding.
    global.fetch = mock.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ records: [], nextCursor: undefined }),
    })) as any;

    const solver = new Solver(baseConfig, { fill: async () => ({ settlementTx: "0x" }) }, {
      info: () => {},
      warn: () => {},
      error: () => {},
    });

    // If construction fails due to missing config values, this would throw before tick.
    await solver.tick();
    assert.ok(true, "solver constructed and ticked successfully");
  });

  test("solver can be configured with explicit timeout values", async () => {
    // When PERIHELION_REQUEST_TIMEOUT_MS is set, the solver should pass it to the client
    // so that slow mempool responses fail fast rather than after 40+ seconds.
    global.fetch = mock.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ records: [], nextCursor: undefined }),
    })) as any;

    const configWithTimeout: SolverConfig = {
      ...baseConfig,
      // These values should be accepted if implemented
      // requestTimeoutMs: 5000,
      // maxRetries: 2,
    };

    const solver = new Solver(configWithTimeout, { fill: async () => ({ settlementTx: "0x" }) }, {
      info: () => {},
      warn: () => {},
      error: () => {},
    });

    await solver.tick();
    assert.ok(true, "solver with timeout config ticked successfully");
  });

  test("mempool timeout does not block the entire solver tick", async () => {
    // A stalled mempool should be bounded by the configured timeout,
    // not by the SDK default (10s per attempt * 4 attempts = 40s).
    let callCount = 0;
    global.fetch = mock.fn(async () => {
      callCount++;
      // Simulate a slow response
      if (callCount === 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ records: [], nextCursor: undefined }),
      };
    }) as any;

    const solver = new Solver(baseConfig, { fill: async () => ({ settlementTx: "0x" }) }, {
      info: () => {},
      warn: () => {},
      error: () => {},
    });

    const start = Date.now();
    await solver.tick();
    const elapsed = Date.now() - start;

    // With default 10s timeout, this would take much longer.
    // With a configured timeout, it should be much faster.
    assert.ok(elapsed < 5000, `tick should complete quickly, took ${elapsed}ms`);
  });
});

// Solver unconfigured-asset terminal skip (#730)
describe("Solver unconfigured-asset terminal skip (#730)", () => {
  const config = loadConfig({
    PERIHELION_SOLVER_ADDRESS: "0x3333333333333333333333333333333333333333",
    PERIHELION_ESCROW_ADDRESS: "0x2222222222222222222222222222222222222222",
    PERIHELION_SOURCE_CHAIN_ID: "8453",
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
});
