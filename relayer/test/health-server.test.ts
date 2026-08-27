// SPDX-License-Identifier: MIT

/**
 * Tests for the HealthServer (Issue 2).
 *
 * Validates:
 * - /healthz always returns 200 with {"status":"ok"}
 * - /readyz returns 503 before any tick has succeeded
 * - /readyz returns 200 after a successful tick with low lag
 * - /readyz returns 503 when last tick is stale
 * - /readyz returns 503 when lag exceeds maxLagBlocks
 * - /metrics returns Prometheus-format text with expected metric names
 * - Unknown paths return 404
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { request } from "node:http";
import { loadConfig } from "../src/config.js";
import { Relayer } from "../src/relayer.js";
import { HealthServer } from "../src/health-server.js";
import type { Logger, SourceWatcher, DestinationDelivery } from "../src/relayer.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const silent: Logger = { info() {}, warn() {}, error() {} };

const VALID_ESCROW = "0xaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaA";
const VALID_CONTRACT = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFCT4";

function baseConfig() {
  return loadConfig({
    PERIHELION_ESCROW_ADDRESS: VALID_ESCROW,
    PERIHELION_SETTLEMENT_CONTRACT: VALID_CONTRACT,
    PERIHELION_EVM_RPC_URL: "http://localhost:8545",
    PERIHELION_STELLAR_RPC_URL: "https://soroban-testnet.stellar.org",
    PERIHELION_SOURCE_EID: "30101",
    PERIHELION_STELLAR_EID: "40161",
    STELLAR_NETWORK: "Test SDF Network ; September 2015",
    SIGNER_SECRET: "SBZVMB74Z76QB3ZL2YFBN7EWUIXVXSNXKNQRIPZTKMZDDQ3FJBNRHWBU",
    PERIHELION_POLL_INTERVAL_MS: "1000",
  });
}

function makeRelayer(pollOverride?: () => Promise<{ messages: never[]; head: number }>): Relayer {
  const watcher: SourceWatcher = {
    poll: pollOverride ?? (async () => ({ messages: [], head: 10 })),
  };
  const delivery: DestinationDelivery = {
    async deliver() { return "0xdst"; },
    async isDelivered() { return false; },
  };
  return new Relayer(baseConfig(), watcher, delivery, silent);
}

/** Find a free port by creating a temporary server. */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

/** Make a simple HTTP GET request. */
function httpGet(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method: "GET" }, (res) => {
      let body = "";
      res.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("HealthServer /healthz always returns 200", async () => {
  const relayer = makeRelayer();
  const port = await freePort();
  const server = new HealthServer(relayer, port, silent, { stalenessThresholdMs: 60_000, maxLagBlocks: 500 });
  await server.start();

  try {
    const res = await httpGet(port, "/healthz");
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.status, "ok");
  } finally {
    server.stop();
  }
});

test("HealthServer /readyz returns 503 before any tick", async () => {
  const relayer = makeRelayer();
  const port = await freePort();
  const server = new HealthServer(relayer, port, silent, { stalenessThresholdMs: 5_000, maxLagBlocks: 500 });
  await server.start();

  try {
    const res = await httpGet(port, "/readyz");
    assert.equal(res.status, 503);
    const body = JSON.parse(res.body);
    assert.equal(body.status, "not ready");
    assert.ok(Array.isArray(body.reasons) && body.reasons.length > 0);
  } finally {
    server.stop();
  }
});

test("HealthServer /readyz returns 200 after successful tick with low lag", async () => {
  const relayer = makeRelayer(async () => ({ messages: [], head: 5 }));
  const port = await freePort();
  const server = new HealthServer(relayer, port, silent, {
    stalenessThresholdMs: 60_000,
    maxLagBlocks: 500,
  });
  await server.start();

  // Simulate what start() does after a successful tick.
  await relayer.tick();
  (relayer.readiness as { lastTickOk: boolean }).lastTickOk = true;
  (relayer.readiness as { lastTickAt: number }).lastTickAt = Date.now();

  try {
    const res = await httpGet(port, "/readyz");
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.status, "ready");
  } finally {
    server.stop();
  }
});

test("HealthServer /readyz returns 503 when tick is stale", async () => {
  const relayer = makeRelayer();
  const port = await freePort();
  const server = new HealthServer(relayer, port, silent, {
    stalenessThresholdMs: 1, // 1ms — anything older is stale
    maxLagBlocks: 500,
  });
  await server.start();

  // Simulate a tick that happened 100ms ago.
  (relayer.readiness as { lastTickOk: boolean }).lastTickOk = true;
  (relayer.readiness as { lastTickAt: number }).lastTickAt = Date.now() - 100;

  try {
    const res = await httpGet(port, "/readyz");
    assert.equal(res.status, 503);
    const body = JSON.parse(res.body);
    assert.ok(body.reasons.some((r: string) => r.includes("threshold")));
  } finally {
    server.stop();
  }
});

test("HealthServer /readyz returns 503 when lag exceeds maxLagBlocks", async () => {
  // head=1000 with default cursor=0 → lag=999
  const relayer = makeRelayer(async () => ({ messages: [], head: 1000 }));
  const port = await freePort();
  const server = new HealthServer(relayer, port, silent, {
    stalenessThresholdMs: 60_000,
    maxLagBlocks: 10,
  });
  await server.start();

  await relayer.tick();
  (relayer.readiness as { lastTickOk: boolean }).lastTickOk = true;
  (relayer.readiness as { lastTickAt: number }).lastTickAt = Date.now();

  try {
    const res = await httpGet(port, "/readyz");
    assert.equal(res.status, 503);
    const body = JSON.parse(res.body);
    assert.ok(body.reasons.some((r: string) => r.includes("lag")));
  } finally {
    server.stop();
  }
});

test("HealthServer /metrics returns Prometheus text with expected names", async () => {
  const relayer = makeRelayer();
  const port = await freePort();
  const server = new HealthServer(relayer, port, silent, { stalenessThresholdMs: 60_000, maxLagBlocks: 500 });
  await server.start();

  try {
    const res = await httpGet(port, "/metrics");
    assert.equal(res.status, 200);
    assert.ok(res.body.includes("relayer_delivered_total"));
    assert.ok(res.body.includes("relayer_failed_total"));
    assert.ok(res.body.includes("relayer_dead_lettered_total"));
    assert.ok(res.body.includes("relayer_cursor_lag_blocks"));
    assert.ok(res.body.includes("relayer_cursor_block"));
    assert.ok(res.body.includes("relayer_head_block"));
    assert.ok(res.body.includes("relayer_last_tick_timestamp_seconds"));
  } finally {
    server.stop();
  }
});

test("HealthServer /metrics reflects relayer metrics values", async () => {
  const relayer = makeRelayer();
  const port = await freePort();
  const server = new HealthServer(relayer, port, silent, { stalenessThresholdMs: 60_000, maxLagBlocks: 500 });
  await server.start();

  (relayer.metrics as { delivered: number }).delivered = 7;
  (relayer.metrics as { failed: number }).failed = 2;
  (relayer.metrics as { deadLettered: number }).deadLettered = 1;

  try {
    const res = await httpGet(port, "/metrics");
    assert.ok(res.body.includes("relayer_delivered_total 7"));
    assert.ok(res.body.includes("relayer_failed_total 2"));
    assert.ok(res.body.includes("relayer_dead_lettered_total 1"));
  } finally {
    server.stop();
  }
});

test("HealthServer unknown path returns 404", async () => {
  const relayer = makeRelayer();
  const port = await freePort();
  const server = new HealthServer(relayer, port, silent, { stalenessThresholdMs: 60_000, maxLagBlocks: 500 });
  await server.start();

  try {
    const res = await httpGet(port, "/unknown");
    assert.equal(res.status, 404);
  } finally {
    server.stop();
  }
});
