import assert from "node:assert/strict";
import { test } from "node:test";
import { PerihelionClient } from "../src/client.js";

const VALID_ADDRESS = "0x1234567890123456789012345678901234567890";
const VALID_HASH = "0x" + "ab".repeat(32);
const VALID_SIG = "0x" + "cd".repeat(65);

function makeRecord(status = "pending") {
  return {
    intent: {
      user: VALID_ADDRESS,
      destination: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
      sourceChainId: 8453,
      sourceAsset: VALID_ADDRESS,
      sourceAmount: "1000000",
      destAsset: "native",
      minDestAmount: "900000",
      deadline: 4102444800,
      nonce: "1",
      preferredSolver: VALID_ADDRESS,
    },
    signature: VALID_SIG,
    hash: VALID_HASH,
    status,
    createdAt: 1700000000,
  };
}

function makeClient(fetchImpl: typeof fetch, mempoolUrl = "https://mempool.example.com/") {
  return new PerihelionClient({ mempoolUrl, fetch: fetchImpl });
}

test("listPending uses the client base URL (strips trailing slash)", async () => {
  let capturedUrl = "";
  const fetchImpl = async (url: string | URL | Request) => {
    capturedUrl = url.toString();
    return new Response(JSON.stringify([makeRecord()]), { status: 200 });
  };
  const client = makeClient(fetchImpl as typeof fetch, "https://mempool.example.com/");
  await client.listPending();
  assert.equal(capturedUrl, "https://mempool.example.com/intents?status=pending");
});

test("listPending returns validated IntentRecord array", async () => {
  const records = [makeRecord("pending"), makeRecord("pending")];
  const fetchImpl = async () =>
    new Response(JSON.stringify(records), { status: 200 });
  const client = makeClient(fetchImpl as typeof fetch);
  const result = await client.listPending();
  assert.equal(result.length, 2);
  assert.equal(result[0].status, "pending");
});

test("listPending accepts a non-default status", async () => {
  let capturedUrl = "";
  const fetchImpl = async (url: string | URL | Request) => {
    capturedUrl = url.toString();
    return new Response(JSON.stringify([makeRecord("settled")]), { status: 200 });
  };
  const client = makeClient(fetchImpl as typeof fetch);
  const result = await client.listPending("settled");
  assert.equal(capturedUrl, "https://mempool.example.com/intents?status=settled");
  assert.equal(result[0].status, "settled");
});

test("listPending throws PerihelionHttpError on non-2xx response", async () => {
  const fetchImpl = async () => new Response("Internal Server Error", { status: 500 });
  const client = makeClient(fetchImpl as typeof fetch);
  await assert.rejects(() => client.listPending(), /500/);
});
