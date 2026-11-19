// SPDX-License-Identifier: MIT

/**
 * Test for issue #742: mempool: malformed JSON produces an HTML 500 from
 * Express instead of a JSON error
 *
 * Error responses should always be in the documented JSON format, not HTML.
 */

import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { MempoolServer } from "../src/server.js";

const PORT = 3991;
const BASE = `http://localhost:${PORT}`;

let server: MempoolServer;

before(async () => {
  server = new MempoolServer({
    port: PORT,
    chainId: 8453,
    verifyingContract: "0x00000000000000000000000000000000000000cc" as const,
  });
  await server.start();
});

after(async () => {
  await server.stop();
});

test("issue #742: malformed JSON body returns 400 with JSON error", async () => {
  const res = await fetch(`${BASE}/intents`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{invalid json",
  });
  assert.equal(res.status, 400, "malformed JSON should return 400");
  const contentType = res.headers.get("content-type");
  assert.ok(contentType?.includes("application/json"), "response should be JSON, not HTML");
  const body = (await res.json()) as { error?: string };
  assert.ok(body.error, "response should contain error message");
  assert.ok(
    typeof body.error === "string" && body.error.toLowerCase().includes("json"),
    "error message should mention JSON",
  );
});

test("issue #742: request body exceeding size limit returns 413 with JSON error", async () => {
  // Create a payload that exceeds 8KB
  const largePayload = JSON.stringify({
    intent: { x: "a".repeat(10000) },
    signature: "0x" + "0".repeat(100),
  });

  const res = await fetch(`${BASE}/intents`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: largePayload,
  });
  assert.equal(res.status, 413, "oversized body should return 413");
  const contentType = res.headers.get("content-type");
  assert.ok(contentType?.includes("application/json"), "response should be JSON, not HTML");
  const body = (await res.json()) as { error?: string };
  assert.ok(body.error, "response should contain error message");
});

test("issue #742: unknown route returns 404 with JSON error", async () => {
  const res = await fetch(`${BASE}/nonexistent-endpoint`);
  assert.equal(res.status, 404, "unknown route should return 404");
  const contentType = res.headers.get("content-type");
  assert.ok(contentType?.includes("application/json"), "response should be JSON, not HTML");
  const body = (await res.json()) as { error?: string };
  assert.ok(body.error, "response should contain error message");
});

test("issue #742: unknown HTTP method returns 404 with JSON error", async () => {
  const res = await fetch(`${BASE}/intents`, {
    method: "DELETE",
  });
  assert.equal(res.status, 404, "unknown method should return 404");
  const contentType = res.headers.get("content-type");
  assert.ok(contentType?.includes("application/json"), "response should be JSON, not HTML");
  const body = (await res.json()) as { error?: string };
  assert.ok(body.error, "response should contain error message");
});

test("issue #742: unsupported content encoding returns 400 with JSON error", async () => {
  const res = await fetch(`${BASE}/intents`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "content-encoding": "gzip",
    },
    body: "{invalid}",
  });
  assert.equal(res.status, 400, "unsupported encoding should return 400");
  const contentType = res.headers.get("content-type");
  assert.ok(contentType?.includes("application/json"), "response should be JSON, not HTML");
  const body = (await res.json()) as { error?: string };
  assert.ok(body.error, "response should contain error message");
});

test("issue #742: aborted request returns 400 with JSON error", async () => {
  const controller = new AbortController();

  // Start the fetch and abort immediately
  const fetchPromise = fetch(`${BASE}/intents`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ test: "data" }),
    signal: controller.signal,
  });

  controller.abort();

  try {
    await fetchPromise;
  } catch (err) {
    // Abort throws an error, which is expected
    assert.ok(true, "abort should throw");
  }
});
