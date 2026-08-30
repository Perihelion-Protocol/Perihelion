// SPDX-License-Identifier: MIT

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
    return new Response(JSON.stringify({ records: [makeRecord()], nextCursor: undefined }), {
      status: 200,
    });
  };
  const client = makeClient(fetchImpl as typeof fetch, "https://mempool.example.com/");
  await client.listPending();
  assert.equal(capturedUrl, "https://mempool.example.com/intents?status=pending&limit=100");
});

test("listPending returns validated IntentRecord array", async () => {
  const records = [makeRecord("pending"), makeRecord("pending")];
  const fetchImpl = async () =>
    new Response(JSON.stringify({ records, nextCursor: undefined }), { status: 200 });
  const client = makeClient(fetchImpl as typeof fetch);
  const result = await client.listPending();
  assert.equal(result.length, 2);
  assert.equal(result[0].status, "pending");
});

test("listPending accepts a non-default status", async () => {
  let capturedUrl = "";
  const fetchImpl = async (url: string | URL | Request) => {
    capturedUrl = url.toString();
    return new Response(JSON.stringify({ records: [makeRecord("settled")], nextCursor: undefined }), {
      status: 200,
    });
  };
  const client = makeClient(fetchImpl as typeof fetch);
  const result = await client.listPending("settled");
  assert.equal(capturedUrl, "https://mempool.example.com/intents?status=settled&limit=100");
  assert.equal(result[0].status, "settled");
});

test("listPending passes an explicit limit override in the query string", async () => {
  let capturedUrl = "";
  const fetchImpl = async (url: string | URL | Request) => {
    capturedUrl = url.toString();
    return new Response(JSON.stringify({ records: [makeRecord()], nextCursor: undefined }), {
      status: 200,
    });
  };
  const client = makeClient(fetchImpl as typeof fetch);
  await client.listPending("pending", 100, 25);
  assert.equal(capturedUrl, "https://mempool.example.com/intents?status=pending&limit=25");
});

test("listPending throws PerihelionHttpError on non-2xx response", async () => {
  const fetchImpl = async () => new Response("Internal Server Error", { status: 500 });
  const client = makeClient(fetchImpl as typeof fetch);
  await assert.rejects(() => client.listPending(), /500/);
});

test("listPending follows nextCursor to accumulate all pages", async () => {
  const page1Record = { ...makeRecord(), hash: "0x" + "01".repeat(32) };
  const page2Record = { ...makeRecord(), hash: "0x" + "02".repeat(32) };

  const calls: string[] = [];
  const fetchImpl = async (url: string | URL | Request) => {
    const u = url.toString();
    calls.push(u);
    if (u.includes("cursor=")) {
      // Second page: no more cursor
      return new Response(
        JSON.stringify({ records: [page2Record], nextCursor: undefined }),
        { status: 200 },
      );
    }
    // First page: has a cursor pointing to next page
    return new Response(
      JSON.stringify({ records: [page1Record], nextCursor: page1Record.hash }),
      { status: 200 },
    );
  };

  const client = makeClient(fetchImpl as typeof fetch);
  const result = await client.listPending();

  assert.equal(calls.length, 2, "should have made two requests (one per page)");
  assert.equal(result.length, 2, "should have accumulated records from both pages");
  assert.equal(result[0].hash, page1Record.hash);
  assert.equal(result[1].hash, page2Record.hash);
  // The second URL must include the cursor from the first page's nextCursor
  assert.ok(calls[1].includes("cursor="), "second request must include cursor param");
});

test("listPending returns all records when server returns more than 100 (pagination regression)", async () => {
  // Simulate a mempool with 150 records — two pages of 100 and 50.
  const allRecords = Array.from({ length: 150 }, (_, i) => ({
    ...makeRecord(),
    hash: ("0x" + i.toString().padStart(64, "0")) as `0x${string}`,
    intent: { ...makeRecord().intent, nonce: String(i) },
  }));

  const PAGE_SIZE = 100;
  let fetchCount = 0;

  const fetchImpl = async (url: string | URL | Request) => {
    fetchCount++;
    const u = new URL(url.toString());
    const cursorParam = u.searchParams.get("cursor");
    const startIndex = cursorParam
      ? allRecords.findIndex((r) => r.hash === cursorParam) + 1
      : 0;
    const page = allRecords.slice(startIndex, startIndex + PAGE_SIZE);
    const nextIndex = startIndex + PAGE_SIZE;
    const nextCursor = nextIndex < allRecords.length ? allRecords[nextIndex - 1].hash : undefined;

    return new Response(JSON.stringify({ records: page, nextCursor }), { status: 200 });
  };

  const client = makeClient(fetchImpl as typeof fetch);
  const result = await client.listPending();

  assert.equal(result.length, 150, "must return all 150 records, not just the first 100");
  assert.equal(fetchCount, 2, "should have made exactly 2 page requests");
});
