// SPDX-License-Identifier: MIT

/**
 * Tests for the mempool server's EIP-712 domain binding. The server verifies
 * intent signatures against a domain built from its configured chainId and
 * escrow (verifyingContract) address; a signature produced under a different
 * domain must be rejected.
 */

import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import {
  buildIntent,
  perihelionDomain,
  PerihelionClient,
  INTENT_TYPES,
  toMessage,
  hashIntent,
  type Address,
} from "@perihelion/sdk";
import { privateKeyToAccount } from "viem/accounts";
import { MempoolServer } from "../src/server.js";

const CHAIN_ID = 8453;
const ESCROW: Address = "0x00000000000000000000000000000000000000aa";
const PORT = 3987;
const BASE = `http://localhost:${PORT}`;
const STATUS_PORT = 3988;
const STATUS_TOKEN = "test-shared-token";

const account = privateKeyToAccount(("0x" + "11".repeat(32)) as `0x${string}`);

let server: MempoolServer;
let statusServer: MempoolServer;

before(async () => {
  server = new MempoolServer({ port: PORT, chainId: CHAIN_ID, verifyingContract: ESCROW });
  await server.start();
  statusServer = new MempoolServer({
    port: STATUS_PORT,
    chainId: CHAIN_ID,
    verifyingContract: ESCROW,
    statusToken: STATUS_TOKEN,
  });
  await statusServer.start();
});

after(async () => {
  await server.stop();
  await statusServer.stop();
});

function sampleIntent() {
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

function sign(intent: ReturnType<typeof buildIntent>, domain: ReturnType<typeof perihelionDomain>) {
  return account.signTypedData({
    domain,
    types: INTENT_TYPES,
    primaryType: "Intent",
    message: toMessage(intent),
  });
}

function submit(intent: unknown, signature: string) {
  return fetch(`${BASE}/intents`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ intent, signature }),
  });
}

test("accepts an intent signed with the server's configured domain", async () => {
  const intent = sampleIntent();
  const signature = await sign(intent, perihelionDomain(CHAIN_ID, ESCROW));

  const res = await submit(intent, signature);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { hash: string };
  assert.match(body.hash, /^0x[0-9a-f]{64}$/);
});

test("rejects an intent signed under a mismatched chainId", async () => {
  const intent = sampleIntent();
  // Same escrow, wrong chain — signature recovers a different signer.
  const signature = await sign(intent, perihelionDomain(999, ESCROW));

  const res = await submit(intent, signature);
  assert.equal(res.status, 400);
  const body = (await res.json()) as { error: string };
  assert.equal(body.error, "Invalid signature");
});

test("rejects an intent signed under a mismatched verifyingContract", async () => {
  const intent = sampleIntent();
  const otherEscrow: Address = "0x00000000000000000000000000000000000000bb";
  const signature = await sign(intent, perihelionDomain(CHAIN_ID, otherEscrow));

  const res = await submit(intent, signature);
  assert.equal(res.status, 400);
  const body = (await res.json()) as { error: string };
  assert.equal(body.error, "Invalid signature");
});

// ─── Issue 348: path/query parameter validation on GET /intents ────────────

test("GET /intents/:hash returns 400 for a malformed hash instead of 404", async () => {
  const res = await fetch(`${BASE}/intents/not-a-hash`);
  assert.equal(res.status, 400);
  const body = (await res.json()) as { error: string };
  assert.match(body.error, /hash/i);
});

test("GET /intents/:hash returns 400 for a hash of the wrong length", async () => {
  const res = await fetch(`${BASE}/intents/0x${"ab".repeat(10)}`);
  assert.equal(res.status, 400);
});

test("GET /intents/:hash returns 404 (not 400) for a well-formed but unknown hash", async () => {
  const res = await fetch(`${BASE}/intents/0x${"ab".repeat(32)}`);
  assert.equal(res.status, 404);
  const body = (await res.json()) as { error: string };
  assert.equal(body.error, "Intent not found");
});

test("GET /intents/:hash lookup is case-insensitive", async () => {
  const intent = sampleIntent();
  const signature = await sign(intent, perihelionDomain(CHAIN_ID, ESCROW));
  const submitRes = await submit(intent, signature);
  const { hash } = (await submitRes.json()) as { hash: string };

  const upperHashUrl = `${BASE}/intents/0x${hash.slice(2).toUpperCase()}`;
  const res = await fetch(upperHashUrl);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { hash: string };
  assert.equal(body.hash, hash);
});

test("GET /intents?status=<invalid> returns 400", async () => {
  const res = await fetch(`${BASE}/intents?status=not-a-real-status`);
  assert.equal(res.status, 400);
  const body = (await res.json()) as { error: string };
  assert.match(body.error, /status must be one of/);
});

test("GET /intents?status=<repeated> returns 400 instead of silently comparing an array", async () => {
  const res = await fetch(`${BASE}/intents?status=pending&status=settled`);
  assert.equal(res.status, 400);
});

test("GET /intents?status=pending returns only matching records", async () => {
  const res = await fetch(`${BASE}/intents?status=pending`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { records: Array<{ status: string }>; nextCursor?: string };
  assert.ok(Array.isArray(body.records), "response should have a records array");
  assert.ok(body.records.every((r) => r.status === "pending"));
});

// ─── Issue 320: duplicate and expired submissions ──────────────────────────

test("rejects an intent whose deadline has already passed", async () => {
  const intent = { ...sampleIntent(), deadline: Math.floor(Date.now() / 1000) - 60 };
  const signature = await sign(intent, perihelionDomain(CHAIN_ID, ESCROW));

  const res = await submit(intent, signature);
  assert.equal(res.status, 400);
  const body = (await res.json()) as { error: string };
  assert.equal(body.error, "Intent deadline has passed");
});

test("duplicate submission is rejected with 409 and does not reset a settled intent's status", async () => {
  const intent = sampleIntent();
  const signature = await sign(intent, perihelionDomain(CHAIN_ID, ESCROW));

  const first = await submit(intent, signature);
  assert.equal(first.status, 200);
  const { hash } = (await first.json()) as { hash: `0x${string}` };

  assert.equal(server.updateStatus(hash, "settled"), true);

  const dup = await submit(intent, signature);
  assert.equal(dup.status, 409);
  const dupBody = (await dup.json()) as { status: string };
  assert.equal(dupBody.status, "settled");

  const record = await (await fetch(`${BASE}/intents/${hash}`)).json();
  assert.equal(record.status, "settled");
});

test("terminal statuses are final: updateStatus cannot move a settled intent backwards", async () => {
  const intent = sampleIntent();
  const signature = await sign(intent, perihelionDomain(CHAIN_ID, ESCROW));

  const res = await submit(intent, signature);
  const { hash } = (await res.json()) as { hash: `0x${string}` };

  assert.equal(server.updateStatus(hash, "settled"), true);
  assert.equal(server.updateStatus(hash, "pending"), false);

  const record = await (await fetch(`${BASE}/intents/${hash}`)).json();
  assert.equal(record.status, "settled");
});

// ─── Issue 321: authenticated PATCH /intents/:hash/status ──────────────────

test("PATCH /intents/:hash/status rejects requests without the configured token", async () => {
  const res = await fetch(`http://localhost:${STATUS_PORT}/intents/0xdead/status`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ status: "settled" }),
  });
  assert.equal(res.status, 401);
});

test("submit -> report settled over HTTP -> waitForSettlement resolves promptly", async () => {
  const client = new PerihelionClient({
    mempoolUrl: `http://localhost:${STATUS_PORT}`,
    chainId: CHAIN_ID,
    verifyingContract: ESCROW,
    fetch,
  });

  const intent = sampleIntent();
  const domain = perihelionDomain(CHAIN_ID, ESCROW);
  const signature = await sign(intent, domain);
  const hash = await client.submitIntent({ intent, signature, hash: hashIntent(intent, domain) });

  await client.reportStatus(hash, "settled", STATUS_TOKEN);

  const result = await client.waitForSettlement(hash, { intervalMs: 20, timeoutMs: 2_000 });
  assert.equal(result.status, "settled");
});

// ─── Issue 473: pagination envelope tests ──────────────────────────────────

test("GET /intents returns pagination envelope with records and nextCursor", async () => {
  // Submit multiple intents
  const intents = [];
  for (let i = 0; i < 3; i++) {
    const intent = { ...sampleIntent(), nonce: String(i) };
    const signature = await sign(intent, perihelionDomain(CHAIN_ID, ESCROW));
    await submit(intent, signature);
    intents.push(intent);
  }

  const res = await fetch(`${BASE}/intents?status=pending`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { records: unknown[]; nextCursor?: string };
  
  assert.ok(Array.isArray(body.records), "response must have a records array");
  assert.ok(body.records.length >= 3, "should contain the submitted intents");
  assert.ok("nextCursor" in body, "response must have nextCursor field (even if undefined)");
});

test("GET /intents pagination: page smaller than result set returns nextCursor", async () => {
  // Submit multiple intents to ensure pagination
  const intents = [];
  for (let i = 0; i < 5; i++) {
    const intent = { ...sampleIntent(), nonce: String(100 + i) };
    const signature = await sign(intent, perihelionDomain(CHAIN_ID, ESCROW));
    await submit(intent, signature);
    intents.push(intent);
  }

  const res = await fetch(`${BASE}/intents?status=pending&limit=2`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { records: unknown[]; nextCursor?: string };
  
  assert.equal(body.records.length, 2, "should return exactly 2 records");
  assert.ok(body.nextCursor, "nextCursor should be present when more pages exist");
});

test("GET /intents pagination: following cursor returns next page", async () => {
  // Submit intents with distinct nonces
  for (let i = 0; i < 4; i++) {
    const intent = { ...sampleIntent(), nonce: String(200 + i) };
    const signature = await sign(intent, perihelionDomain(CHAIN_ID, ESCROW));
    await submit(intent, signature);
  }

  // Get first page
  const res1 = await fetch(`${BASE}/intents?status=pending&limit=2`);
  const page1 = (await res1.json()) as { records: Array<{ hash: string }>; nextCursor?: string };
  
  assert.equal(page1.records.length, 2);
  assert.ok(page1.nextCursor, "first page should have nextCursor");

  // Get second page
  const res2 = await fetch(`${BASE}/intents?status=pending&limit=2&cursor=${page1.nextCursor}`);
  const page2 = (await res2.json()) as { records: Array<{ hash: string }>; nextCursor?: string };
  
  assert.ok(page2.records.length > 0, "second page should have records");
  
  // Verify no overlap
  const page1Hashes = new Set(page1.records.map(r => r.hash));
  const page2Hashes = page2.records.map(r => r.hash);
  for (const hash of page2Hashes) {
    assert.ok(!page1Hashes.has(hash), "pages should not overlap");
  }
});

test("GET /intents pagination: final page returns nextCursor undefined", async () => {
  // Submit exactly 2 intents
  for (let i = 0; i < 2; i++) {
    const intent = { ...sampleIntent(), nonce: String(300 + i) };
    const signature = await sign(intent, perihelionDomain(CHAIN_ID, ESCROW));
    await submit(intent, signature);
  }

  const res = await fetch(`${BASE}/intents?status=pending&limit=100`);
  const body = (await res.json()) as { records: unknown[]; nextCursor?: string };
  
  assert.ok(body.records.length >= 2);
  assert.equal(body.nextCursor, undefined, "final page should have nextCursor: undefined");
});

test("GET /intents limit parameter: values above MAX_LIST_LIMIT are clamped", async () => {
  const res = await fetch(`${BASE}/intents?status=pending&limit=9999`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { records: unknown[] };
  
  // MAX_LIST_LIMIT is 1000 in the server
  assert.ok(body.records.length <= 1000, "result should be clamped to MAX_LIST_LIMIT");
});

test("GET /intents chainId filter: returns only matching chain intents", async () => {
  // Submit intent for the configured chain
  const intent8453 = { ...sampleIntent(), sourceChainId: CHAIN_ID };
  const sig8453 = await sign(intent8453, perihelionDomain(CHAIN_ID, ESCROW));
  await submit(intent8453, sig8453);

  // Query with chainId filter
  const res = await fetch(`${BASE}/intents?status=pending&chainId=${CHAIN_ID}`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { records: Array<{ intent: { sourceChainId: number } }> };
  
  assert.ok(body.records.length > 0, "should have at least one result");
  for (const record of body.records) {
    assert.equal(record.intent.sourceChainId, CHAIN_ID, "all results should match chainId filter");
  }
});

test("GET /intents rejects bare array response format (regression test)", async () => {
  // This test documents that the server returns an envelope, not a bare array
  const res = await fetch(`${BASE}/intents?status=pending`);
  assert.equal(res.status, 200);
  const body = await res.json();

  assert.ok(typeof body === "object" && body !== null, "response should be an object");
  assert.ok("records" in body, "response must have records field");
  assert.ok(Array.isArray(body.records), "records must be an array");
  assert.ok("nextCursor" in body, "response must have nextCursor field");
  assert.ok(!Array.isArray(body), "response must NOT be a bare array");
});

// ─── Issue 561: PATCH /intents/:hash/status validates and normalises the hash ──

function patchStatus(hash: string, status: string) {
  return fetch(`${BASE}/intents/${hash}/status`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ status }),
  });
}

test("#561 PATCH accepts a mixed-case hash, matching GET", async () => {
  const intent = { ...sampleIntent(), nonce: String(560_000) };
  const signature = await sign(intent, perihelionDomain(CHAIN_ID, ESCROW));
  const { hash } = (await (await submit(intent, signature)).json()) as { hash: string };

  const mixedCase = `0x${hash.slice(2).toUpperCase()}`;

  // GET already tolerates this; PATCH must now too.
  const getRes = await fetch(`${BASE}/intents/${mixedCase}`);
  assert.equal(getRes.status, 200);

  const patchRes = await patchStatus(mixedCase, "settled");
  assert.equal(patchRes.status, 200);
  const updated = (await patchRes.json()) as { hash: string; status: string };
  assert.equal(updated.hash, hash);
  assert.equal(updated.status, "settled");
});

test("#561 PATCH returns 400 (not 404) for a malformed hash", async () => {
  const res = await patchStatus("not-a-hash", "settled");
  assert.equal(res.status, 400);
  const body = (await res.json()) as { error: string };
  assert.match(body.error, /hash/i);
});

test("#561 PATCH still returns 404 for a well-formed but unknown hash", async () => {
  const res = await patchStatus(`0x${"cd".repeat(32)}`, "settled");
  assert.equal(res.status, 404);
});

// ─── Issue 562: unresolvable pagination cursor fails loudly ────────────────────

test("#562 an unresolvable cursor returns 400 rather than silently restarting", async () => {
  for (let i = 0; i < 3; i++) {
    const intent = { ...sampleIntent(), nonce: String(562_000 + i) };
    const signature = await sign(intent, perihelionDomain(CHAIN_ID, ESCROW));
    await submit(intent, signature);
  }

  // Page 1.
  const page1 = (await (await fetch(`${BASE}/intents?status=pending&limit=1`)).json()) as {
    records: Array<{ hash: string }>;
    nextCursor?: string;
  };
  assert.ok(page1.nextCursor, "expected a nextCursor while more records remain");

  // The cursor record settles (leaves the pending-filtered set) before page 2.
  assert.equal(server.updateStatus(page1.nextCursor as `0x${string}`, "settled"), true);

  const res = await fetch(
    `${BASE}/intents?status=pending&limit=1&cursor=${page1.nextCursor}`,
  );
  assert.equal(res.status, 400, "a vanished cursor must not silently return page one");
  const body = (await res.json()) as { error: string; code?: string };
  assert.equal(body.code, "unresolvable_cursor");
});

test("#562 paging a set that mutates between requests terminates instead of looping", async () => {
  const seen = new Set<string>();
  let cursor: string | undefined;
  let guard = 0;
  for (;;) {
    assert.ok(guard++ < 50, "pagination loop failed to terminate");
    const url = `${BASE}/intents?status=pending&limit=2${cursor ? `&cursor=${cursor}` : ""}`;
    const res = await fetch(url);
    if (res.status === 400) break; // cursor invalidated by a concurrent mutation — client restarts deliberately
    assert.equal(res.status, 200);
    const body = (await res.json()) as { records: Array<{ hash: string }>; nextCursor?: string };
    for (const r of body.records) seen.add(r.hash);
    if (!body.nextCursor) break;
    // Mutate the result set mid-scan: settle the record the next cursor names.
    server.updateStatus(body.nextCursor as `0x${string}`, "settled");
    cursor = body.nextCursor;
  }
  assert.ok(guard < 50, "loop terminated");
});

// ─── Issue 563: rate-limit map is bounded and entries expire ───────────────────

test("#563 rate-limit map is bounded when driven by many distinct source IPs", async () => {
  const proxied = new MempoolServer({
    port: 3990,
    chainId: CHAIN_ID,
    verifyingContract: ESCROW,
    trustProxy: true,
    rateLimitMaxIps: 10,
  });
  await proxied.start();
  try {
    for (let i = 0; i < 200; i++) {
      await fetch("http://localhost:3990/intents", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-forwarded-for": `203.0.113.${i & 0xff}, 198.51.100.${i}`,
        },
        body: JSON.stringify({}),
      });
    }
    assert.ok(
      proxied.rateLimitEntryCount() <= 10,
      `expected <= 10 tracked IPs, got ${proxied.rateLimitEntryCount()}`,
    );

    // A sweep dated past the window clears everything.
    proxied.sweep(Date.now() + 10 * 60_000);
    assert.equal(proxied.rateLimitEntryCount(), 0);
  } finally {
    await proxied.stop();
  }
});

test("#563 a request rejected with 429 is still recorded so the window keeps sliding", async () => {
  const proxied = new MempoolServer({
    port: 3991,
    chainId: CHAIN_ID,
    verifyingContract: ESCROW,
    trustProxy: true,
  });
  await proxied.start();
  try {
    const ip = "203.0.113.250";
    const hit = () =>
      fetch("http://localhost:3991/intents", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": ip },
        body: JSON.stringify({}),
      });

    let lastOk = 0;
    for (let i = 0; i < 60; i++) {
      const res = await hit();
      if (res.status !== 429) lastOk = i;
    }
    assert.equal(lastOk, 59, "first 60 requests in the window should be admitted");

    // Further requests are rejected — and keep being rejected, because each
    // rejected attempt is recorded, holding the window full rather than
    // letting it drain.
    for (let i = 0; i < 5; i++) {
      const res = await hit();
      assert.equal(res.status, 429);
    }
  } finally {
    await proxied.stop();
  }
});
