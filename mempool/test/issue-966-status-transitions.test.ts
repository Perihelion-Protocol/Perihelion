// SPDX-License-Identifier: MIT

/**
 * Tests for issue #966: status updates must follow an explicit transition graph,
 * `expired` is only valid after the deadline, and invalid transitions return 409.
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
import { MempoolServer, transitionRejection } from "../src/server.js";
import type { MempoolIntentRecord } from "../src/types.js";

const CHAIN_ID = 8453;
const ESCROW: Address = "0x00000000000000000000000000000000000000cc";
const PORT = 3966;
const BASE = `http://localhost:${PORT}`;
const TOKEN = "status-token-966";

const account = privateKeyToAccount(("0x" + "55".repeat(32)) as `0x${string}`);

let server: MempoolServer;

before(async () => {
  server = new MempoolServer({
    port: PORT,
    chainId: CHAIN_ID,
    verifyingContract: ESCROW,
    statusToken: TOKEN,
  });
  await server.start();
});

after(async () => {
  await server.stop();
});

function record(status: MempoolIntentRecord["status"], deadline: number): MempoolIntentRecord {
  const intent = buildIntent({
    user: account.address,
    destination: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
    sourceChainId: CHAIN_ID,
    sourceAsset: "0x0000000000000000000000000000000000000004" as Address,
    sourceAmount: "10000000",
    destAsset: "native",
    minDestAmount: "9900000",
    deadline: Math.floor(Date.now() / 1000) + 600,
  });
  return {
    hash: `0x${"cd".repeat(32)}`,
    intent: { ...intent, deadline },
    signature: "0x00",
    status,
    createdAt: 0,
  } as unknown as MempoolIntentRecord;
}

const FUTURE = Math.floor(Date.now() / 1000) + 3600;
const PAST = Math.floor(Date.now() / 1000) - 60;

test("pending may move to filled, settled, refunded, or expired after the deadline", () => {
  assert.equal(transitionRejection(record("pending", FUTURE), "filled"), undefined);
  assert.equal(transitionRejection(record("pending", FUTURE), "settled"), undefined);
  assert.equal(transitionRejection(record("pending", FUTURE), "refunded"), undefined);
  assert.equal(transitionRejection(record("pending", PAST), "expired"), undefined);
});

test("expired is rejected before the deadline (#966)", () => {
  const reason = transitionRejection(record("pending", FUTURE), "expired");
  assert.match(reason ?? "", /before its deadline/);
});

test("filled may move only to settled or refunded", () => {
  assert.equal(transitionRejection(record("filled", FUTURE), "settled"), undefined);
  assert.equal(transitionRejection(record("filled", FUTURE), "refunded"), undefined);
  assert.notEqual(transitionRejection(record("filled", FUTURE), "pending"), undefined);
  assert.notEqual(transitionRejection(record("filled", PAST), "expired"), undefined);
});

test("terminal statuses have no outgoing transitions", () => {
  for (const from of ["settled", "refunded", "expired"] as const) {
    for (const to of ["pending", "filled", "settled", "refunded", "expired"] as const) {
      if (to === from) continue; // re-sending the same status is a no-op (see above)
      assert.notEqual(
        transitionRejection(record(from, PAST), to),
        undefined,
        `${from} -> ${to} must be rejected`,
      );
    }
  }
});

test("re-sending the current status is an idempotent no-op", () => {
  assert.equal(transitionRejection(record("pending", FUTURE), "pending"), undefined);
  assert.equal(transitionRejection(record("settled", PAST), "settled"), undefined);
});

async function submitSigned(): Promise<string> {
  const domain = perihelionDomain(CHAIN_ID, ESCROW);
  const intent = buildIntent({
    user: account.address,
    destination: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
    sourceChainId: CHAIN_ID,
    sourceAsset: "0x0000000000000000000000000000000000000004" as Address,
    sourceAmount: "10000000",
    destAsset: "native",
    minDestAmount: "9900000",
    deadline: Math.floor(Date.now() / 1000) + 3600,
  });
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
  assert.equal(res.status, 201, "submission should succeed");
  return ((await res.json()) as { hash: string }).hash;
}

function setStatus(hash: string, status: string) {
  return fetch(`${BASE}/intents/${hash}/status`, {
    method: "PATCH",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ status }),
  });
}

test("HTTP: pending -> filled succeeds and returns the updated record", async () => {
  const hash = await submitSigned();
  const res = await setStatus(hash, "filled");
  assert.equal(res.status, 200);
  const body = (await res.json()) as { hash: string; status: string };
  assert.equal(body.hash, hash);
  assert.equal(body.status, "filled");
});

test("HTTP: pending -> expired before the deadline returns 409 and leaves the record unchanged", async () => {
  const hash = await submitSigned();
  const res = await setStatus(hash, "expired");
  assert.equal(res.status, 409);
  const current = await fetch(`${BASE}/intents/${hash}`);
  assert.equal(((await current.json()) as { status: string }).status, "pending");
});

test("HTTP: filled -> pending returns 409", async () => {
  const hash = await submitSigned();
  assert.equal((await setStatus(hash, "filled")).status, 200);
  assert.equal((await setStatus(hash, "pending")).status, 409);
});

test("HTTP: a terminal settled intent cannot be changed and returns 409", async () => {
  const hash = await submitSigned();
  assert.equal((await setStatus(hash, "settled")).status, 200);
  assert.equal((await setStatus(hash, "pending")).status, 409);
});

test("HTTP: unknown intent still returns 404", async () => {
  const res = await setStatus(`0x${"ee".repeat(32)}`, "filled");
  assert.equal(res.status, 404);
});
