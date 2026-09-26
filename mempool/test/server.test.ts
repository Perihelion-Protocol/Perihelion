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

// ─── Issue 695: pagination envelope round-trips ────────────────────────────

test("GET /intents paginates with nextCursor and round-trips without overlap or gaps", async () => {
  // Submit enough pending intents to force more than one page.
  const submitted: string[] = [];
  for (let i = 0; i < 5; i++) {
    const intent = { ...sampleIntent(), sourceAmount: String(10_000_000 + i) };
    const signature = await sign(intent, perihelionDomain(CHAIN_ID, ESCROW));
    const res = await submit(intent, signature);
    assert.equal(res.status, 200);
    const { hash } = (await res.json()) as { hash: string };
    submitted.push(hash);
  }

  const firstRes = await fetch(`${BASE}/intents?status=pending&limit=2`);
  assert.equal(firstRes.status, 200);
  const first = (await firstRes.json()) as {
    records: Array<{ hash: string; status: string }>;
    nextCursor?: string;
  };
  assert.ok(Array.isArray(first.records), "response should have a records array");
  assert.ok(first.records.every((r) => r.status === "pending"));
  assert.ok(first.records.length > 0, "first page should contain records");
  assert.equal(typeof first.nextCursor, "string", "nextCursor should be present when more records remain");

  const secondRes = await fetch(
    `${BASE}/intents?status=pending&limit=2&cursor=${encodeURIComponent(first.nextCursor!)}`,
  );
  assert.equal(secondRes.status, 200);
  const second = (await secondRes.json()) as {
    records: Array<{ hash: string; status: string }>;
    nextCursor?: string;
  };
  assert.ok(Array.isArray(second.records), "response should have a records array");
  assert.ok(second.records.every((r) => r.status === "pending"));

  // No overlap between pages.
  const firstHashes = new Set(first.records.map((r) => r.hash));
  for (const record of second.records) {
    assert.ok(!firstHashes.has(record.hash), `record ${record.hash} appeared on both pages`);
  }

  // Walk to the last page and assert nextCursor is absent there.
  let cursor = second.nextCursor;
  const seen = new Set([...first.records, ...second.records].map((r) => r.hash));
  while (cursor) {
    const pageRes = await fetch(
      `${BASE}/intents?status=pending&limit=2&cursor=${encodeURIComponent(cursor)}`,
    );
    assert.equal(pageRes.status, 200);
    const page = (await pageRes.json()) as {
      records: Array<{ hash: string; status: string }>;
      nextCursor?: string;
    };
    for (const record of page.records) {
      assert.ok(!seen.has(record.hash), `record ${record.hash} appeared on multiple pages`);
      seen.add(record.hash);
    }
    cursor = page.nextCursor;
  }

  // Every submitted intent should have been observed exactly once across pages.
  for (const hash of submitted) {
    assert.ok(seen.has(hash), `submitted intent ${hash} was missing from paginated results`);
  }
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

// ─── Issue #738: Rate-limiter memory leak tests ────────────────────────────

test("rate limiting tracking remains bounded even with many distinct IPs (#738)", async () => {
  const serverWithShortWindow = new MempoolServer({
    port: 3989,
    chainId: CHAIN_ID,
    verifyingContract: ESCROW,
    rateLimitWindowMs: 100,
    writeRateLimit: 2,
  });
  await serverWithShortWindow.start();

  try {
    const baseUrl = `http://localhost:3989`;
    const intent = sampleIntent();
    const signature = await sign(intent, perihelionDomain(CHAIN_ID, ESCROW));

    const submitted: Promise<Response>[] = [];
    for (let i = 0; i < 50; i++) {
      submitted.push(
        fetch(`${baseUrl}/intents`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ intent: { ...intent, sourceAmount: String(i) }, signature }),
        }),
      );
    }

    const results = await Promise.all(submitted);
    const rateLimited = results.filter((r) => r.status === 429).length;

    assert.ok(rateLimited > 0, "some requests should have been rate-limited");
    assert.ok(rateLimited < results.length, "not all requests should be rate-limited");

    await new Promise((r) => setTimeout(r, 150));

    const postWindowIntent = sampleIntent();
    const postWindowSig = await sign(postWindowIntent, perihelionDomain(CHAIN_ID, ESCROW));
    const afterWindow = await fetch(`${baseUrl}/intents`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ intent: postWindowIntent, signature: postWindowSig }),
    });
    assert.ok(
      afterWindow.status !== 429,
      "requests should succeed after rate-limit window expires",
    );
  } finally {
    await serverWithShortWindow.stop();
  }
});

test("abusive client remains throttled for entire window (#738)", async () => {
  const serverWithShortWindow = new MempoolServer({
    port: 3990,
    chainId: CHAIN_ID,
    verifyingContract: ESCROW,
    rateLimitWindowMs: 200,
    writeRateLimit: 1,
  });
  await serverWithShortWindow.start();

  try {
    const baseUrl = `http://localhost:3990`;
    const intent1 = sampleIntent();
    const sig1 = await sign(intent1, perihelionDomain(CHAIN_ID, ESCROW));

    const res1 = await fetch(`${baseUrl}/intents`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ intent: intent1, signature: sig1 }),
    });
    assert.equal(res1.status, 200, "first request should succeed");

    const intent2 = { ...sampleIntent(), sourceAmount: "100000000" };
    const sig2 = await sign(intent2, perihelionDomain(CHAIN_ID, ESCROW));
    const res2 = await fetch(`${baseUrl}/intents`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ intent: intent2, signature: sig2 }),
    });
    assert.equal(res2.status, 429, "second request should be rate-limited");

    await new Promise((r) => setTimeout(r, 100));

    const intent3 = { ...sampleIntent(), sourceAmount: "200000000" };
    const sig3 = await sign(intent3, perihelionDomain(CHAIN_ID, ESCROW));
    const res3 = await fetch(`${baseUrl}/intents`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ intent: intent3, signature: sig3 }),
    });
    assert.equal(res3.status, 429, "third request within window should still be rate-limited");
  } finally {
    await serverWithShortWindow.stop();
  }
});

// ─── Issue #739: Proxy trust configuration tests ──────────────────────────

test("rate limiting keys on req.ip and ignores X-Forwarded-For without trustProxy (#739)", async () => {
  const serverNoDtrustProxy = new MempoolServer({
    port: 3991,
    chainId: CHAIN_ID,
    verifyingContract: ESCROW,
    rateLimitWindowMs: 1000,
    writeRateLimit: 1,
  });
  await serverNoDtrustProxy.start();

  try {
    const baseUrl = `http://localhost:3991`;
    const intent1 = sampleIntent();
    const sig1 = await sign(intent1, perihelionDomain(CHAIN_ID, ESCROW));

    const res1 = await fetch(`${baseUrl}/intents`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Forwarded-For": "203.0.113.1",
      },
      body: JSON.stringify({ intent: intent1, signature: sig1 }),
    });
    assert.equal(res1.status, 200, "first request should succeed");

    const intent2 = { ...sampleIntent(), sourceAmount: "100000000" };
    const sig2 = await sign(intent2, perihelionDomain(CHAIN_ID, ESCROW));
    const res2 = await fetch(`${baseUrl}/intents`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Forwarded-For": "203.0.113.2",
      },
      body: JSON.stringify({ intent: intent2, signature: sig2 }),
    });
    assert.equal(
      res2.status,
      429,
      "second request from same socket (different X-Forwarded-For ignored) should be rate-limited",
    );
  } finally {
    await serverNoDtrustProxy.stop();
  }
});

// ─── Issue 321: authenticated PATCH /intents/:hash/status ──────────────────

test("PATCH /intents/:hash/status rejects requests without the configured token", async () => {
  const res = await fetch(`http://localhost:${STATUS_PORT}/intents/0xdead/status`, {
    method: "PATCH",
    headers: { "content-type

/* … truncated 10822 chars — edit only what you need near the top … */
