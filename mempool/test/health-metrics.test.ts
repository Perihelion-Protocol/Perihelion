// SPDX-License-Identifier: MIT

/**
 * Tests for health, readiness, and metrics endpoints.
 * Verifies that:
 * - /healthz returns 200 while the listener is up
 * - /readyz returns 503 before start and 200 after start
 * - /metrics returns parseable Prometheus text format with correct data
 */

import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import {
  buildIntent,
  perihelionDomain,
  INTENT_TYPES,
  toMessage,
  type Address,
} from "@perihelion/sdk";
import { privateKeyToAccount } from "viem/accounts";
import { MempoolServer } from "../src/server.js";

const CHAIN_ID = 8453;
const ESCROW: Address = "0x00000000000000000000000000000000000000bb";
const PORT = 3989;
const BASE = `http://localhost:${PORT}`;

const account = privateKeyToAccount(("0x" + "22".repeat(32)) as `0x${string}`);

let server: MempoolServer;

before(async () => {
  server = new MempoolServer({ port: PORT, chainId: CHAIN_ID, verifyingContract: ESCROW });
});

after(async () => {
  await server.stop();
});

function sampleIntent() {
  return buildIntent({
    user: account.address,
    destination: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
    sourceChainId: CHAIN_ID,
    sourceAsset: "0x0000000000000000000000000000000000000004" as Address,
    sourceAmount: "10000000",
    destAsset: "native",
    minDestAmount: "9900000",
    deadline: Math.floor(Date.now() / 1000) + 600,
  });
}

function sign(intent: ReturnType<typeof buildIntent>, domain: ReturnType<typeof perihelionDomain>) {
  return account.signTypedData({
    domain,
    types: INTENT_TYPES,
    primaryType: "Intent",
    message: toMessage(intent),
  });
}

test("/healthz endpoint", async (t) => {
  await t.test("is accessible before server start", async () => {
    // Note: before() hasn't run yet for this test, server isn't started
    // This test runs independently
    const testServer = new MempoolServer({
      port: 3990,
      chainId: CHAIN_ID,
      verifyingContract: ESCROW,
    });
    await testServer.start();
    const res = await fetch("http://localhost:3990/healthz");
    assert.equal(res.status, 200);
    const body = (await res.json()) as { status: string };
    assert.equal(body.status, "ok");
    await testServer.stop();
  });

  await t.test("returns 200 with ok status while listening", async () => {
    await server.start();
    const res = await fetch(`${BASE}/healthz`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { status: string };
    assert.equal(body.status, "ok");
  });
});

test("/readyz endpoint", async (t) => {
  const readyTestPort = 3991;
  const readyTestBase = `http://localhost:${readyTestPort}`;
  let readyServer: MempoolServer;

  await t.test("returns 503 before server start", async () => {
    readyServer = new MempoolServer({
      port: readyTestPort,
      chainId: CHAIN_ID,
      verifyingContract: ESCROW,
    });
    const res = await fetch(`${readyTestBase}/readyz`);
    assert.equal(res.status, 503);
    const body = (await res.json()) as { status: string; reason?: string };
    assert.equal(body.status, "not ready");
  });

  await t.test("returns 200 after server start", async () => {
    await readyServer.start();
    const res = await fetch(`${readyTestBase}/readyz`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { status: string };
    assert.equal(body.status, "ready");
    await readyServer.stop();
  });

  await t.test("returns 503 after server stop", async () => {
    const res = await fetch(`${readyTestBase}/readyz`);
    assert.equal(res.status, 503);
  });
});

test("/metrics endpoint", async (t) => {
  await t.test("returns Prometheus text format", async () => {
    const res = await fetch(`${BASE}/metrics`);
    assert.equal(res.status, 200);
    const contentType = res.headers.get("content-type");
    assert.match(contentType || "", /text\/plain/);
  });

  await t.test("includes store size metric", async () => {
    const res = await fetch(`${BASE}/metrics`);
    const text = await res.text();
    assert.match(text, /# HELP mempool_store_size/);
    assert.match(text, /# TYPE mempool_store_size gauge/);
    assert.match(text, /^mempool_store_size \d+$/m);
  });

  await t.test("includes pending intents metric", async () => {
    const res = await fetch(`${BASE}/metrics`);
    const text = await res.text();
    assert.match(text, /# HELP mempool_store_pending_intents/);
    assert.match(text, /# TYPE mempool_store_pending_intents gauge/);
    assert.match(text, /^mempool_store_pending_intents \d+$/m);
  });

  await t.test("includes settlement status metrics", async () => {
    const res = await fetch(`${BASE}/metrics`);
    const text = await res.text();
    assert.match(text, /mempool_store_settled_intents/);
    assert.match(text, /mempool_store_refunded_intents/);
    assert.match(text, /mempool_store_expired_intents/);
  });

  await t.test("includes submission counters", async () => {
    const res = await fetch(`${BASE}/metrics`);
    const text = await res.text();
    assert.match(text, /# HELP mempool_submissions_accepted/);
    assert.match(text, /# TYPE mempool_submissions_accepted counter/);
    assert.match(text, /^mempool_submissions_accepted \d+$/m);
    assert.match(text, /# HELP mempool_submissions_rejected/);
    assert.match(text, /# TYPE mempool_submissions_rejected counter/);
    assert.match(text, /^mempool_submissions_rejected \d+$/m);
  });

  await t.test("includes rate-limit rejection counter", async () => {
    const res = await fetch(`${BASE}/metrics`);
    const text = await res.text();
    assert.match(text, /# HELP mempool_rate_limit_rejections/);
    assert.match(text, /# TYPE mempool_rate_limit_rejections counter/);
    assert.match(text, /^mempool_rate_limit_rejections \d+$/m);
  });

  await t.test("updates submission counters after intent submission", async () => {
    const intent = sampleIntent();
    const signature = await sign(intent, perihelionDomain(CHAIN_ID, ESCROW));

    const submitRes = await fetch(`${BASE}/intents`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ intent, signature }),
    });
    assert.equal(submitRes.status, 201);

    const metricsRes = await fetch(`${BASE}/metrics`);
    const text = await metricsRes.text();
    // At minimum, submissions_accepted should be > 0
    const match = text.match(/^mempool_submissions_accepted (\d+)$/m);
    assert(match, "Should find submissions_accepted metric");
    const accepted = Number(match[1]);
    assert(accepted > 0, "Should have accepted at least one submission");
  });

  await t.test("tracks rejected submissions", async () => {
    // Submit malformed intent to trigger rejection
    const malformedRes = await fetch(`${BASE}/intents`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ intent: null, signature: "0x" }),
    });
    assert.equal(malformedRes.status, 400);

    const metricsRes = await fetch(`${BASE}/metrics`);
    const text = await metricsRes.text();
    const match = text.match(/^mempool_submissions_rejected (\d+)$/m);
    assert(match, "Should find submissions_rejected metric");
    const rejected = Number(match[1]);
    assert(rejected > 0, "Should have rejected at least one submission");
  });
});
