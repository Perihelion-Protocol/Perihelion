/**
 * Tests for solver signature verification caching and hash validation.
 */

import assert from "node:assert/strict";
import { test, mock } from "node:test";
import {
  buildIntent,
  hashIntent,
  perihelionDomain,
  type IntentRecord,
  type Hex,
} from "@perihelion/sdk";
import { Solver, type Executor, type Logger } from "../src/solver.js";
import type { SolverConfig } from "../src/config.js";

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
  pollIntervalMs: 1000,
  supportedDestAssets: ["native"],
  verificationCacheSize: 100,
};

function buildTestIntent() {
  return buildIntent({
    user: USER_ADDRESS,
    destination: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4",
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

test("verifies signature only once for the same intent hash", async () => {
  const intent = buildTestIntent();
  const record = buildTestRecord(intent);

  let verifyCallCount = 0;
  const mockVerify = mock.fn(async () => {
    verifyCallCount++;
    return true;
  });

  // Create a custom mock module to intercept verifyIntent
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
    json: async () => [record],
  })) as any;

  // Temporarily override the SDK's verifyIntent
  const sdkModule = await import("@perihelion/sdk");
  const originalVerify = sdkModule.verifyIntent;
  (sdkModule as any).verifyIntent = mockVerify;

  try {
    const solver = new Solver(baseConfig, mockExecutor, mockLogger);

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
  } finally {
    // Restore original
    (sdkModule as any).verifyIntent = originalVerify;
  }
});

test("rejects intent with hash mismatch", async () => {
  const intent = buildTestIntent();
  const correctHash = hashIntent(intent, domain);
  const wrongHash = "0xwronghash0000000000000000000000000000000000000000000000000000" as Hex;

  const record: IntentRecord = {
    intent,
    signature: "0xvalidsig" as Hex,
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
    json: async () => [record],
  })) as any;

  const solver = new Solver(baseConfig, mockExecutor, mockLogger);
  await solver.tick();

  assert.ok(
    warnings.some((w) => w.includes("hash mismatch")),
    "should warn about hash mismatch"
  );
});

test("caches invalid signatures to avoid re-verification", async () => {
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
    json: async () => [record],
  })) as any;

  const sdkModule = await import("@perihelion/sdk");
  const originalVerify = sdkModule.verifyIntent;
  (sdkModule as any).verifyIntent = mockVerify;

  try {
    const solver = new Solver(baseConfig, mockExecutor, mockLogger);

    // First tick - should verify and reject
    await solver.tick();
    assert.equal(verifyCallCount, 1, "should verify on first encounter");
    assert.ok(
      warnings.some((w) => w.includes("invalid signature")),
      "should warn about invalid signature"
    );

    // Second tick - should use cached rejection
    warnings.length = 0;
    await solver.tick();
    assert.equal(
      verifyCallCount,
      1,
      "should not verify again (cached invalid result)"
    );
    assert.ok(
      warnings.some((w) => w.includes("invalid signature")),
      "should still reject with cached result"
    );
  } finally {
    (sdkModule as any).verifyIntent = originalVerify;
  }
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

  const mockExecutor: Executor = {
    fill: async () => ({ settlementTx: "0xfilled" }),
  };

  const sdkModule = await import("@perihelion/sdk");
  const originalVerify = sdkModule.verifyIntent;
  (sdkModule as any).verifyIntent = mockVerify;

  try {
    const solver = new Solver(smallCacheConfig, mockExecutor, mockLogger);

    // Process intent1 and intent2 (fills cache to capacity)
    global.fetch = mock.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => [record1],
    })) as any;
    await solver.tick();

    global.fetch = mock.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => [record2],
    })) as any;
    await solver.tick();

    assert.equal(verifiedHashes.length, 2, "should verify both intents");
    verifiedHashes = [];

    // Process intent3 (should evict intent1)
    global.fetch = mock.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => [record3],
    })) as any;
    await solver.tick();

    assert.equal(verifiedHashes.length, 1, "should verify new intent3");
    verifiedHashes = [];

    // Process intent1 again (should re-verify since it was evicted)
    global.fetch = mock.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => [record1],
    })) as any;
    await solver.tick();

    assert.equal(
      verifiedHashes.length,
      1,
      "should re-verify intent1 after eviction"
    );
    assert.equal(verifiedHashes[0], record1.hash, "re-verified intent1");

    // Process intent2 again (should still be cached)
    verifiedHashes = [];
    global.fetch = mock.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => [record2],
    })) as any;
    await solver.tick();

    assert.equal(
      verifiedHashes.length,
      0,
      "intent2 should still be cached (not evicted)"
    );
  } finally {
    (sdkModule as any).verifyIntent = originalVerify;
  }
});

test("complete flow: hash validation and cached verification", async () => {
  const intent = buildTestIntent();
  const correctHash = hashIntent(intent, domain);
  const record: IntentRecord = {
    intent,
    signature: "0xvalidsignature" as Hex,
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
    json: async () => [record],
  })) as any;

  const sdkModule = await import("@perihelion/sdk");
  const originalVerify = sdkModule.verifyIntent;
  (sdkModule as any).verifyIntent = mockVerify;

  try {
    const solver = new Solver(baseConfig, mockExecutor, mockLogger);

    // First tick: verify and fill
    await solver.tick();
    assert.equal(verifyCount, 1, "should verify on first tick");
    assert.equal(fills.length, 1, "should fill the intent");
    assert.equal(fills[0], correctHash, "filled correct intent");

    // Second tick: use cached verification, but don't fill (seen)
    await solver.tick();
    assert.equal(verifyCount, 1, "should not re-verify (cached)");
    assert.equal(fills.length, 1, "should not fill again (already seen)");
  } finally {
    (sdkModule as any).verifyIntent = originalVerify;
  }
});
