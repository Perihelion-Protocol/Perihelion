// SPDX-License-Identifier: MIT

/**
 * Test for issue #740: mempool: an unknown pagination cursor silently returns
 * the first page instead of an error
 *
 * An unknown cursor should return 400 instead of silently returning page one.
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
const PORT = 3989;
const BASE = `http://localhost:${PORT}`;

const account = privateKeyToAccount(("0x" + "33".repeat(32)) as `0x${string}`);

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

test("issue #740: unknown cursor returns 400 instead of page one", async () => {
  await submitSignedIntent();

  const res = await fetch(`${BASE}/intents?cursor=0x${"0".repeat(64)}`);
  assert.equal(res.status, 400, "unknown cursor should return 400, not 200");
  const body = (await res.json()) as { error?: string };
  assert.ok(body.error, "response should contain error message");
});

test("issue #740: invalid limit (negative) returns 400", async () => {
  const res = await fetch(`${BASE}/intents?limit=-5`);
  assert.equal(res.status, 400, "negative limit should return 400");
  const body = (await res.json()) as { error?: string };
  assert.ok(body.error, "response should contain error message");
});

test("issue #740: invalid limit (non-numeric) returns 400", async () => {
  const res = await fetch(`${BASE}/intents?limit=abc`);
  assert.equal(res.status, 400, "non-numeric limit should return 400");
  const body = (await res.json()) as { error?: string };
  assert.ok(body.error, "response should contain error message");
});

test("issue #740: invalid limit (exceeds maximum) returns 400", async () => {
  const res = await fetch(`${BASE}/intents?limit=99999`);
  assert.equal(res.status, 400, "limit exceeding MAX_LIST_LIMIT should return 400");
  const body = (await res.json()) as { error?: string };
  assert.ok(body.error, "response should contain error message");
});

test("issue #740: invalid limit (zero) returns 400", async () => {
  const res = await fetch(`${BASE}/intents?limit=0`);
  assert.equal(res.status, 400, "zero limit should return 400");
  const body = (await res.json()) as { error?: string };
  assert.ok(body.error, "response should contain error message");
});

test("issue #740: valid cursor from previous page works", async () => {
  // Submit multiple intents to paginate through
  for (let i = 0; i < 3; i++) {
    await submitSignedIntent({ deadline: Math.floor(Date.now() / 1000) + 600 + i });
  }

  // Get first page
  const firstRes = await fetch(`${BASE}/intents?limit=1`);
  assert.equal(firstRes.status, 200);
  const firstPage = (await firstRes.json()) as { records: Array<{ hash: string }>; nextCursor?: string };

  assert.ok(firstPage.nextCursor, "first page should have nextCursor when more records exist");

  // Use cursor to get next page
  const secondRes = await fetch(`${BASE}/intents?limit=1&cursor=${firstPage.nextCursor}`);
  assert.equal(secondRes.status, 200, "valid cursor should return 200");
  const secondPage = (await secondRes.json()) as { records: unknown[] };
  assert.ok(secondPage.records.length > 0, "second page should have records");
});
