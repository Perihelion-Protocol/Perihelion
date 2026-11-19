// SPDX-License-Identifier: MIT

/**
 * Tests for issue #967: the mempool must reject, at intake, intents whose
 * `sourceChainId` is not its own chain or whose deadline is beyond the SDK's
 * seven-day horizon.
 */

import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import {
  buildIntent,
  perihelionDomain,
  INTENT_TYPES,
  MAX_DEADLINE_HORIZON_SEC,
  toMessage,
  type Address,
  type Intent,
} from "@perihelion/sdk";
import { privateKeyToAccount } from "viem/accounts";
import { MempoolServer } from "../src/server.js";

const CHAIN_ID = 8453;
const ESCROW: Address = "0x00000000000000000000000000000000000000dd";
const PORT = 3967;
const BASE = `http://localhost:${PORT}`;

const account = privateKeyToAccount(("0x" + "66".repeat(32)) as `0x${string}`);

let server: MempoolServer;

before(async () => {
  server = new MempoolServer({
    port: PORT,
    chainId: CHAIN_ID,
    verifyingContract: ESCROW,
    statusToken: "t967",
  });
  await server.start();
});

after(async () => {
  await server.stop();
});

function validIntent(): Intent {
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

/** Sign the intent as provided, even when it is one `buildIntent` would refuse. */
async function submit(intent: Intent): Promise<Response> {
  const domain = perihelionDomain(CHAIN_ID, ESCROW);
  const signature = await account.signTypedData({
    domain,
    types: INTENT_TYPES,
    primaryType: "Intent",
    message: toMessage(intent),
  });
  return fetch(`${BASE}/intents`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ intent, signature }),
  });
}

test("accepts an intent for the mempool's own chain within the horizon", async () => {
  const res = await submit(validIntent());
  assert.equal(res.status, 201);
});

test("rejects an intent whose sourceChainId is another chain, naming the field", async () => {
  const intent = { ...validIntent(), sourceChainId: CHAIN_ID + 1 };
  const res = await submit(intent);
  assert.equal(res.status, 400);
  const body = (await res.json()) as { error: string };
  assert.match(body.error, /sourceChainId/);
});

test("rejects a deadline beyond the seven-day horizon, naming the field", async () => {
  const intent = {
    ...validIntent(),
    deadline: Math.floor(Date.now() / 1000) + MAX_DEADLINE_HORIZON_SEC + 3600,
  };
  const res = await submit(intent);
  assert.equal(res.status, 400);
  const body = (await res.json()) as { error: string };
  assert.match(body.error, /deadline/);
});

test("accepts a deadline just inside the horizon", async () => {
  const intent = {
    ...validIntent(),
    deadline: Math.floor(Date.now() / 1000) + MAX_DEADLINE_HORIZON_SEC - 600,
  };
  const res = await submit(intent);
  assert.equal(res.status, 201);
});
