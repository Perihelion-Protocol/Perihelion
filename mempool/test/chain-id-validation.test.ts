// SPDX-License-Identifier: MIT

/**
 * Test for issue #741: mempool: the `chainId` list filter is unvalidated and
 * silently matches nothing on bad input
 *
 * The chainId filter should be validated and return 400 for non-numeric,
 * repeated, or fractional values.
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
const PORT = 3990;
const BASE = `http://localhost:${PORT}`;

const account = privateKeyToAccount(("0x" + "44".repeat(32)) as `0x${string}`);

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

test("issue #741: non-numeric chainId returns 400", async () => {
  const res = await fetch(`${BASE}/intents?chainId=base`);
  assert.equal(res.status, 400, "non-numeric chainId should return 400");
  const body = (await res.json()) as { error?: string };
  assert.ok(body.error, "response should contain error message");
});

test("issue #741: repeated chainId parameter returns 400", async () => {
  const res = await fetch(`${BASE}/intents?chainId=8453&chainId=1`);
  assert.equal(res.status, 400, "repeated chainId parameter should return 400");
  const body = (await res.json()) as { error?: string };
  assert.ok(body.error, "response should contain error message");
});

test("issue #741: fractional chainId returns 400", async () => {
  const res = await fetch(`${BASE}/intents?chainId=8453.5`);
  assert.equal(res.status, 400, "fractional chainId should return 400");
  const body = (await res.json()) as { error?: string };
  assert.ok(body.error, "response should contain error message");
});

test("issue #741: valid chainId filters correctly", async () => {
  await submitSignedIntent();

  const res = await fetch(`${BASE}/intents?chainId=${CHAIN_ID}`);
  assert.equal(res.status, 200, "valid chainId should return 200");
  const body = (await res.json()) as { records: unknown[] };
  assert.ok(Array.isArray(body.records), "response should contain records array");
  assert.ok(body.records.length > 0, "should return records for matching chainId");
});

test("issue #741: non-matching chainId returns empty list", async () => {
  const res = await fetch(`${BASE}/intents?chainId=999999`);
  assert.equal(res.status, 200, "non-matching chainId should return 200 with empty list");
  const body = (await res.json()) as { records: unknown[] };
  assert.ok(Array.isArray(body.records), "response should contain records array");
  assert.equal(body.records.length, 0, "should return empty list for non-matching chainId");
});

test("issue #741: negative chainId returns 400", async () => {
  const res = await fetch(`${BASE}/intents?chainId=-1`);
  assert.equal(res.status, 400, "negative chainId should return 400");
  const body = (await res.json()) as { error?: string };
  assert.ok(body.error, "response should contain error message");
});

test("issue #741: zero chainId returns 400", async () => {
  const res = await fetch(`${BASE}/intents?chainId=0`);
  assert.equal(res.status, 400, "zero chainId should return 400");
  const body = (await res.json()) as { error?: string };
  assert.ok(body.error, "response should contain error message");
});

test("issue #741: empty string chainId returns 400", async () => {
  const res = await fetch(`${BASE}/intents?chainId=`);
  assert.equal(res.status, 400, "empty string chainId should return 400");
  const body = (await res.json()) as { error?: string };
  assert.ok(body.error, "response should contain error message");
});
