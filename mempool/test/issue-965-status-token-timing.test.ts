// SPDX-License-Identifier: MIT

/**
 * Tests for issue #965: the status bearer token must be compared in constant
 * time, and failed status-token attempts must be rate-limited separately.
 */

import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { bearerTokenMatches, MempoolServer } from "../src/server.js";
import type { Address } from "@perihelion/sdk";

const CHAIN_ID = 8453;
const ESCROW: Address = "0x00000000000000000000000000000000000000cc";
const PORT = 3965;
const BASE = `http://localhost:${PORT}`;
const TOKEN = "relayer-and-solver-shared-token";
const HASH = `0x${"ab".repeat(32)}`;

let server: MempoolServer;

before(async () => {
  server = new MempoolServer({
    port: PORT,
    chainId: CHAIN_ID,
    verifyingContract: ESCROW,
    statusToken: TOKEN,
    // Keep the write budget out of the way; the auth budget is what is under test.
    writeRateLimit: 1000,
  });
  await server.start();
});

after(async () => {
  await server.stop();
});

function patch(authorization?: string) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (authorization !== undefined) headers.authorization = authorization;
  return fetch(`${BASE}/intents/${HASH}/status`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ status: "filled" }),
  });
}

test("bearerTokenMatches accepts only the exact Bearer token", () => {
  assert.equal(bearerTokenMatches(`Bearer ${TOKEN}`, TOKEN), true);
  assert.equal(bearerTokenMatches(undefined, TOKEN), false);
  assert.equal(bearerTokenMatches("", TOKEN), false);
  assert.equal(bearerTokenMatches(TOKEN, TOKEN), false, "scheme prefix is required");
});

test("bearerTokenMatches rejects a same-length wrong token", () => {
  const wrong = "x".repeat(TOKEN.length);
  assert.equal(bearerTokenMatches(`Bearer ${wrong}`, TOKEN), false);
});

test("bearerTokenMatches rejects differently sized tokens without throwing", () => {
  assert.equal(bearerTokenMatches("Bearer short", TOKEN), false);
  assert.equal(bearerTokenMatches(`Bearer ${TOKEN}-and-more`, TOKEN), false);
});

test("bearerTokenMatches rejects a correct prefix of the token", () => {
  assert.equal(bearerTokenMatches(`Bearer ${TOKEN.slice(0, -1)}`, TOKEN), false);
});

test("PATCH status returns 401 for a missing, wrong, short, long or prefix token", async () => {
  const cases = [
    undefined,
    `Bearer ${"y".repeat(TOKEN.length)}`,
    "Bearer nope",
    `Bearer ${TOKEN}extra`,
    `Bearer ${TOKEN.slice(0, 5)}`,
  ];
  for (const auth of cases) {
    const res = await patch(auth);
    assert.equal(res.status, 401, `expected 401 for authorization=${JSON.stringify(auth)}`);
  }
});

test("PATCH status does not reject the correct token as unauthorized", async () => {
  const res = await patch(`Bearer ${TOKEN}`);
  // The intent does not exist, so a correctly authenticated request gets 404.
  assert.equal(res.status, 404);
});

test("failed status-token attempts are rate-limited separately from the write budget", async () => {
  // Earlier cases already consumed some failures; keep sending wrong tokens
  // until the per-client auth budget is exhausted.
  let limited: Response | undefined;
  for (let i = 0; i < 20; i++) {
    const res = await patch("Bearer wrong-token");
    if (res.status === 429) {
      limited = res;
      break;
    }
    assert.equal(res.status, 401);
  }
  assert.ok(limited, "expected a 429 once the failure budget is spent");
  assert.deepEqual(await limited.json(), { error: "Too many failed authentication attempts" });

  // Even the correct token is refused while the client is locked out of auth.
  const correct = await patch(`Bearer ${TOKEN}`);
  assert.equal(correct.status, 429);
});
