// SPDX-License-Identifier: MIT

/**
 * Issue #968: `/metrics` must honour an optional bearer token
 * (`metricsToken`, `PERIHELION_METRICS_TOKEN`), sit behind the read rate limit,
 * and report counters that follow Prometheus `_total` naming.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { Address } from "@perihelion/sdk";
import { MempoolServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";

const CHAIN_ID = 8453;
const ESCROW: Address = "0x00000000000000000000000000000000000000cc";
const TOKEN = "metrics-secret";

test("/metrics without metricsToken stays open", async () => {
  const server = new MempoolServer({ port: 3960, chainId: CHAIN_ID, verifyingContract: ESCROW });
  await server.start();
  try {
    const res = await fetch("http://localhost:3960/metrics");
    assert.equal(res.status, 200);
  } finally {
    await server.stop();
  }
});

test("/metrics requires the bearer token when metricsToken is configured", async (t) => {
  const server = new MempoolServer({
    port: 3961,
    chainId: CHAIN_ID,
    verifyingContract: ESCROW,
    metricsToken: TOKEN,
  });
  await server.start();
  const url = "http://localhost:3961/metrics";
  try {
    await t.test("rejects a request with no authorization header", async () => {
      const res = await fetch(url);
      assert.equal(res.status, 401);
    });

    await t.test("rejects a wrong token", async () => {
      const res = await fetch(url, { headers: { authorization: "Bearer nope" } });
      assert.equal(res.status, 401);
    });

    await t.test("rejects a token that is a prefix of the real one", async () => {
      const res = await fetch(url, { headers: { authorization: `Bearer ${TOKEN}x` } });
      assert.equal(res.status, 401);
    });

    await t.test("accepts the correct bearer token", async () => {
      const res = await fetch(url, { headers: { authorization: `Bearer ${TOKEN}` } });
      assert.equal(res.status, 200);
      assert.match(await res.text(), /^mempool_store_size \d+$/m);
    });
  } finally {
    await server.stop();
  }
});

test("/metrics is subject to the read rate limit", async () => {
  const server = new MempoolServer({
    port: 3962,
    chainId: CHAIN_ID,
    verifyingContract: ESCROW,
    readRateLimit: 2,
  });
  await server.start();
  try {
    const statuses: number[] = [];
    for (let i = 0; i < 3; i++) {
      statuses.push((await fetch("http://localhost:3962/metrics")).status);
    }
    assert.deepEqual(statuses, [200, 200, 429]);

    const health = await fetch("http://localhost:3962/healthz");
    assert.equal(health.status, 200, "health probes are not rate limited by the metrics budget");
  } finally {
    await server.stop();
  }
});

test("counters use the _total suffix and gauges are exposed", async () => {
  const server = new MempoolServer({ port: 3963, chainId: CHAIN_ID, verifyingContract: ESCROW });
  await server.start();
  try {
    const text = await (await fetch("http://localhost:3963/metrics")).text();
    assert.match(text, /^# TYPE mempool_submissions_accepted_total counter$/m);
    assert.match(text, /^# TYPE mempool_submissions_rejected_total counter$/m);
    assert.match(text, /^# TYPE mempool_rate_limit_rejections_total counter$/m);
    assert.doesNotMatch(text, /^mempool_submissions_accepted \d/m);
    assert.match(text, /^mempool_store_pending_intents 0$/m);
  } finally {
    await server.stop();
  }
});

test("loadConfig reads PERIHELION_METRICS_TOKEN", () => {
  const base = {
    PERIHELION_SOURCE_CHAIN_ID: "8453",
    PERIHELION_ESCROW_ADDRESS: ESCROW,
  };
  assert.equal(loadConfig({ ...base }).metricsToken, undefined);
  assert.equal(loadConfig({ ...base, PERIHELION_METRICS_TOKEN: TOKEN }).metricsToken, TOKEN);
  assert.equal(loadConfig({ ...base, PERIHELION_METRICS_TOKEN: "" }).metricsToken, undefined);
});
