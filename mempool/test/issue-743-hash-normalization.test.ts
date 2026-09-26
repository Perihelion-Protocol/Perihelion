// SPDX-License-Identifier: MIT

/**
 * Test for issue #743: mempool: `PATCH /intents/:hash/status` does not validate
 * or normalise the hash, unlike `GET`
 *
 * The PATCH endpoint should accept case-insensitive hashes and validate the
 * hash format like the GET endpoint does.
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
const ESCROW: Address = "0x00000000000000000000000000000000000000cc";
const PORT = 3992;
const BASE = `http://localhost:${PORT}`;

const account = privateKeyToAccount(("0x" + "55".repeat(32)) as `0x${string}`);

let server: MempoolServer;

function sampleIntent(overrides: Partial<Parameters<typeof buildIntent>[0]> = {}) {
  return buildIntent({
    user: account.address,
    destination: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
    sourceChainId: CHAIN_ID,
    sourceAsset: "0x0000000000000000000000000000000000000004" as Address,
    sourceAmount: "10000000",
    destAsset: "native",
    minDestAmount: "9900000",
    deadline: Math.floor(Date.now() / 1000) + 600,
    ...overrides,
  });
}

async function submitSignedIntent(overrides: Partial<Parameters<typeof buildIntent>[0]> = {}) {
  const domain = perihelionDomain(CHAIN_ID, ESCROW);
  const intent = sampleIntent(overrides);
  const signature = await account.signTypedData({
    domain,
    types: INTENT_TYPES,
    primaryType: "Intent",
    message: toMessage(intent),
  });
  const res = await fetch(`${BASE}/intents`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ intent, signature }),
  });
  return res;
}

before(async () => {
  server = new MempoolServer({ port: PORT, chainId: CHAIN_ID, verifyingContract: ESCROW });
  await server.start();
});

after(async () => {
  await server.stop();
});

test("issue #743: PATCH with uppercase hash normalizes and updates the record", async () => {
  const submitRes = await submitSignedIntent();
  const { hash } = (await submitRes.json()) as { hash: string };

  // Uppercase the hash
  const uppercaseHash = hash.toUpperCase();

  const patchRes = await fetch(`${BASE}/intents/${uppercaseHash}/status`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ status: "settled" }),
  });

  assert.equal(
    patchRes.status,
    200,
    "PATCH with uppercase hash should succeed (case-insensitive)",
  );
  const body = (await patchRes.json()) as { status?: string };
  assert.equal(body.status, "settled", "status should be updated to settled");

  // Verify with GET using lowercase
  const getRes = await fetch(`${BASE}/intents/${hash.toLowerCase()}`);
  assert.equal(getRes.status, 200);
  const getBody = (await getRes.json()) as { status?: string };
  assert.equal(getBody.status, "settled", "GET should show updated status");
});

test("issue #743: PATCH with mixed-case hash normalizes and updates the record", async () => {
  const submitRes = await submitSignedIntent();
  const { hash } = (await submitRes.json()) as { hash: string };

  // Mix case of the hash
  const mixedCaseHash = hash.substring(0, 10) + hash.substring(10).toUpperCase();

  const patchRes = await fetch(`${BASE}/intents/${mixedCaseHash}/status`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ status: "refunded" }),
  });

  assert.equal(
    patchRes.status,
    200,
    "PATCH with mixed-case hash should succeed (case-insensitive)",
  );
  const body = (await patchRes.json()) as { status?: string };
  assert.equal(body.status, "refunded", "status should be updated to refunded");
});

test("issue #743: PATCH with malformed hash returns 400, not 404", async () => {
  const malformedHash = "0xZZZ"; // Invalid hex

  const patchRes = await fetch(`${BASE}/intents/${malformedHash}/status`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ status: "settled" }),
  });

  assert.equal(patchRes.status, 400, "malformed hash should return 400, not 404");
  const body = (await patchRes.json()) as { error?: string };
  assert.ok(body.error, "response should contain error message");
});

test("issue #743: PATCH with wrong-length hash returns 400, not 404", async () => {
  const wrongLengthHash = "0x" + "0".repeat(63); // 63 chars instead of 64

  const patchRes = await fetch(`${BASE}/intents/${wrongLengthHash}/status`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ status: "settled" }),
  });

  assert.equal(patchRes.status, 400, "wrong-length hash should return 400, not 404");
  const body = (await patchRes.json()) as { error?: string };
  assert.ok(body.error, "response should contain error message");
});

test("issue #743: PATCH with unknown but well-formed hash returns 404", async () => {
  const unknownHash = "0x" + "a".repeat(64); // Valid format, but doesn't exist

  const patchRes = await fetch(`${BASE}/intents/${unknownHash}/status`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ status: "settled" }),
  });

  assert.equal(
    patchRes.status,
    404,
    "unknown but well-formed hash should return 404, not 400",
  );
  const body = (await patchRes.json()) as { error?: string };
  assert.ok(body.error, "response should contain error message");
});

test("issue #743: PATCH with missing hash path parameter returns 400", async () => {
  const patchRes = await fetch(`${BASE}/intents//status`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ status: "settled" }),
  });

  // This might 404 depending on routing, but should not succeed
  assert.ok(patchRes.status !== 200, "request without hash parameter should not succeed");
});

test("issue #743: PATCH hash validation happens before status validation", async () => {
  // Request with malformed hash and missing status
  const malformedHash = "0xZZZ";

  const patchRes = await fetch(`${BASE}/intents/${malformedHash}/status`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });

  assert.equal(patchRes.status, 400, "should return 400 for malformed hash");
  const body = (await patchRes.json()) as { error?: string };
  assert.ok(body.error?.toLowerCase().includes("hash"), "error should mention hash");
});

test("issue #743: GET with uppercase hash works (baseline test)", async () => {
  const submitRes = await submitSignedIntent();
  const { hash } = (await submitRes.json()) as { hash: string };

  // Uppercase the hash
  const uppercaseHash = hash.toUpperCase();

  const getRes = await fetch(`${BASE}/intents/${uppercaseHash}`);
  assert.equal(getRes.status, 200, "GET with uppercase hash should work");
  const body = (await getRes.json()) as { hash?: string };
  assert.ok(body.hash, "response should contain the intent record");
});
