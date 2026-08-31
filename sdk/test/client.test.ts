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
  assert.equal(capturedUrl, "https://mempool.example.com/intents?status=pending");
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
  assert.equal(capturedUrl, "https://mempool.example.com/intents?status=settled");
  assert.equal(result[0].status, "settled");
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

// ─── isRefundable ────────────────────────────────────────────────────────────

// Shared grace period: 2 hours in ms (used throughout these tests).
const GRACE_MS = 2 * 60 * 60 * 1_000;

/**
 * Build a record whose deadline is either in the past or future relative to
 * the current time.
 *
 * @param status    - IntentStatus to set on the record.
 * @param expired   - true  → deadline is far in the past (well past grace too)
 *                    false → deadline is far in the future
 * @param graceMs   - The grace period used to place the deadline exactly at the
 *                    boundary (default GRACE_MS).
 */
function makeTimedRecord(
  status: string,
  expired: boolean,
  graceMs: number = GRACE_MS,
) {
  const nowSec = Math.floor(Date.now() / 1_000);
  // expired: deadline 1 day before now so that deadline+grace is also in the past
  // not expired: deadline 1 day in the future
  const deadline = expired
    ? nowSec - 24 * 60 * 60         // 24 h in the past
    : nowSec + 24 * 60 * 60;        // 24 h in the future
  return {
    intent: {
      user: VALID_ADDRESS,
      destination: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
      sourceChainId: 8453,
      sourceAsset: VALID_ADDRESS,
      sourceAmount: "1000000",
      destAsset: "native",
      minDestAmount: "900000",
      deadline,
      nonce: "1",
      preferredSolver: VALID_ADDRESS,
    },
    signature: VALID_SIG,
    hash: VALID_HASH,
    status,
    createdAt: 1700000000,
  };
}

// ── status gate: only 'pending' may ever be refundable ────────────────────────

test("isRefundable: 'pending' + past deadline + past grace → true", () => {
  const client = makeClient((() => {}) as unknown as typeof fetch);
  const record = makeTimedRecord("pending", true);
  assert.equal(client.isRefundable(record as Parameters<typeof client.isRefundable>[0], GRACE_MS), true);
});

test("isRefundable: 'pending' + future deadline → false", () => {
  const client = makeClient((() => {}) as unknown as typeof fetch);
  const record = makeTimedRecord("pending", false);
  assert.equal(client.isRefundable(record as Parameters<typeof client.isRefundable>[0], GRACE_MS), false);
});

test("isRefundable: 'claimed' + past deadline + past grace → false (not pending)", () => {
  const client = makeClient((() => {}) as unknown as typeof fetch);
  const record = makeTimedRecord("claimed", true);
  assert.equal(client.isRefundable(record as Parameters<typeof client.isRefundable>[0], GRACE_MS), false);
});

test("isRefundable: 'settling' + past deadline + past grace → false (message in flight)", () => {
  const client = makeClient((() => {}) as unknown as typeof fetch);
  const record = makeTimedRecord("settling", true);
  assert.equal(client.isRefundable(record as Parameters<typeof client.isRefundable>[0], GRACE_MS), false);
});

test("isRefundable: 'settled' + past deadline → false", () => {
  const client = makeClient((() => {}) as unknown as typeof fetch);
  const record = makeTimedRecord("settled", true);
  assert.equal(client.isRefundable(record as Parameters<typeof client.isRefundable>[0], GRACE_MS), false);
});

test("isRefundable: 'refunded' + past deadline → false (already refunded)", () => {
  const client = makeClient((() => {}) as unknown as typeof fetch);
  const record = makeTimedRecord("refunded", true);
  assert.equal(client.isRefundable(record as Parameters<typeof client.isRefundable>[0], GRACE_MS), false);
});

test("isRefundable: 'expired' + past deadline + past grace → false (not pending)", () => {
  const client = makeClient((() => {}) as unknown as typeof fetch);
  const record = makeTimedRecord("expired", true);
  assert.equal(client.isRefundable(record as Parameters<typeof client.isRefundable>[0], GRACE_MS), false);
});

// ── grace boundary: pending, deadline passed, but still inside grace ──────────

test("isRefundable: 'pending' + deadline passed, inside grace → false", () => {
  const client = makeClient((() => {}) as unknown as typeof fetch);
  const nowSec = Math.floor(Date.now() / 1_000);
  // Deadline was 1 minute ago; grace is 2 hours → still inside the window.
  const record = makeTimedRecord("pending", false);
  (record.intent as { deadline: number }).deadline = nowSec - 60;
  assert.equal(client.isRefundable(record as Parameters<typeof client.isRefundable>[0], GRACE_MS), false);
});

test("isRefundable: 'pending' + deadline passed, exactly at grace boundary → true", () => {
  const client = makeClient((() => {}) as unknown as typeof fetch);
  const nowSec = Math.floor(Date.now() / 1_000);
  const graceSec = Math.floor(GRACE_MS / 1_000);
  // deadline + grace === now (exactly on the boundary → refundable)
  const record = makeTimedRecord("pending", false);
  (record.intent as { deadline: number }).deadline = nowSec - graceSec;
  assert.equal(client.isRefundable(record as Parameters<typeof client.isRefundable>[0], GRACE_MS), true);
});

// ── grace period value is caller-supplied, not a baked-in constant ────────────

test("isRefundable: same record with a longer grace stays false", () => {
  const client = makeClient((() => {}) as unknown as typeof fetch);
  const nowSec = Math.floor(Date.now() / 1_000);
  // Deadline 30 minutes ago; a 1-hour grace still covers it → false.
  const record = makeTimedRecord("pending", false);
  (record.intent as { deadline: number }).deadline = nowSec - 30 * 60;
  assert.equal(
    client.isRefundable(record as Parameters<typeof client.isRefundable>[0], 60 * 60 * 1_000),
    false,
    "30 min past deadline with 1h grace should not be refundable",
  );
});

test("isRefundable: same record with a shorter grace becomes true", () => {
  const client = makeClient((() => {}) as unknown as typeof fetch);
  const nowSec = Math.floor(Date.now() / 1_000);
  // Deadline 30 minutes ago; a 15-minute grace has already elapsed → true.
  const record = makeTimedRecord("pending", false);
  (record.intent as { deadline: number }).deadline = nowSec - 30 * 60;
  assert.equal(
    client.isRefundable(record as Parameters<typeof client.isRefundable>[0], 15 * 60 * 1_000),
    true,
    "30 min past deadline with 15 min grace should be refundable",
  );
});
