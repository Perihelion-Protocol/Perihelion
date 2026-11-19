// SPDX-License-Identifier: MIT

/**
 * Regression test for #888. `verifyIntent` is async; the submit handler once
 * tested its unawaited Promise with `!`, which is always false, so a signature
 * from the wrong key was accepted. A forged submission must be rejected.
 */

import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import {
  buildIntent,
  hashIntent,
  perihelionDomain,
  INTENT_TYPES,
  toMessage,
  type Address,
} from "@perihelion/sdk";
import { privateKeyToAccount } from "viem/accounts";
import { MempoolServer } from "../src/server.js";
import type { PublicClient } from "viem";

const CHAIN_ID = 8453;
const ESCROW: Address = "0x00000000000000000000000000000000000000aa";
const PORT = 3989;
const BASE = `http://localhost:${PORT}`;

const owner = privateKeyToAccount(("0x" + "11".repeat(32)) as `0x${string}`);
const forger = privateKeyToAccount(("0x" + "22".repeat(32)) as `0x${string}`);

let server: MempoolServer;

before(async () => {
  server = new MempoolServer({ port: PORT, chainId: CHAIN_ID, verifyingContract: ESCROW });
  await server.start();
});

after(async () => {
  await server.stop();
});

function sampleIntent() {
  return buildIntent({
    user: owner.address,
    destination: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
    sourceChainId: CHAIN_ID,
    sourceAsset: "0x0000000000000000000000000000000000000004" as Address,
    sourceAmount: "10000000",
    destAsset: "native",
    minDestAmount: "9900000",
    deadline: Math.floor(Date.now() / 1000) + 600,
  });
}

function submit(intent: unknown, signature: string) {
  return fetch(`${BASE}/intents`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ intent, signature }),
  });
}

test("rejects an intent signed by a key other than intent.user under the correct domain", async () => {
  const intent = sampleIntent();
  const signature = await forger.signTypedData({
    domain: perihelionDomain(CHAIN_ID, ESCROW),
    types: INTENT_TYPES,
    primaryType: "Intent",
    message: toMessage(intent),
  });

  const res = await submit(intent, signature);
  assert.equal(res.status, 400);
  const body = (await res.json()) as { error: string };
  assert.equal(body.error, "Signature verification failed");

  // The forged record must not have been stored.
  const hash = hashIntent(intent, perihelionDomain(CHAIN_ID, ESCROW));
  const lookup = await fetch(`${BASE}/intents/${hash}`);
  assert.equal(lookup.status, 404);
});

test("accepts an intent signed by intent.user under the correct domain", async () => {
  const intent = sampleIntent();
  const signature = await owner.signTypedData({
    domain: perihelionDomain(CHAIN_ID, ESCROW),
    types: INTENT_TYPES,
    primaryType: "Intent",
    message: toMessage(intent),
  });

  const res = await submit(intent, signature);
  assert.equal(res.status, 201);
});

test("rejects a malformed signature with 400 instead of crashing the handler", async () => {
  const res = await submit(sampleIntent(), "0xdeadbeef");
  assert.equal(res.status, 400);
});

// --- ERC-1271 contract wallets (#932) -------------------------------------

const CONTRACT_USER: Address = "0x00000000000000000000000000000000000000cc";
const ERC1271_MAGIC = "0x1626ba7e";

/**
 * Minimal stub of the viem PublicClient surface used by the mempool for
 * ERC-1271 verification: `getCode` to detect a contract account and
 * `readContract` to call `isValidSignature(bytes32,bytes)`.
 */
function stubClient(opts: { isContract: boolean; valid: boolean }): PublicClient {
  return {
    getCode: async ({ address }: { address: Address }) =>
      opts.isContract && address.toLowerCase() === CONTRACT_USER.toLowerCase()
        ? "0x600160005260206000f3"
        : undefined,
    readContract: async () => (opts.valid ? ERC1271_MAGIC : "0xffffffff"),
  } as unknown as PublicClient;
}

function contractIntent() {
  return buildIntent({
    user: CONTRACT_USER,
    destination: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
    sourceChainId: CHAIN_ID,
    sourceAsset: "0x0000000000000000000000000000000000000004" as Address,
    sourceAmount: "10000000",
    destAsset: "native",
    minDestAmount: "9900000",
    deadline: Math.floor(Date.now() / 1000) + 600,
  });
}

test("accepts an intent from an ERC-1271 contract wallet with a valid signature", async () => {
  const srv = new MempoolServer({
    port: PORT + 1,
    chainId: CHAIN_ID,
    verifyingContract: ESCROW,
    client: stubClient({ isContract: true, valid: true }),
  });
  await srv.start();
  try {
    const res = await fetch(`http://localhost:${PORT + 1}/intents`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ intent: contractIntent(), signature: "0xdeadbeef" }),
    });
    assert.equal(res.status, 201);
  } finally {
    await srv.stop();
  }
});

test("rejects an intent from an ERC-1271 contract wallet with an invalid signature", async () => {
  const srv = new MempoolServer({
    port: PORT + 2,
    chainId: CHAIN_ID,
    verifyingContract: ESCROW,
    client: stubClient({ isContract: true, valid: false }),
  });
  await srv.start();
  try {
    const res = await fetch(`http://localhost:${PORT + 2}/intents`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ intent: contractIntent(), signature: "0xdeadbeef" }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, "Signature verification failed");
  } finally {
    await srv.stop();
  }
});
