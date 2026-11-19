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

/** Report a status transition over HTTP. The shared `server` has no statusToken, so no auth header is needed. */
function patchStatus(target: MempoolServer, hash: string, status: string) {
  const port = target === server ? PORT : STATUS_PORT;
  return fetch(`http://localhost:${port}/intents/${hash}/status`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ status }),
  });
}

test("accepts an intent signed with the server's configured domain", async () => {
  const intent = sampleIntent();
  const signature = await sign(intent, perihelionDomain(CHAIN_ID, ESCROW));

  const res = await submit(intent, signature);
  assert.equal(res.status, 201);
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
  assert.equal(body.error, "Signature verification failed");
});

test("rejects an intent signed under a mismatched verifyingContract", async () => {
  const intent = sampleIntent();
  const otherEscrow: Address = "0x00000000000000000000000000000000000000bb";
  const signature = await sign(intent, perihelionDomain(CHAIN_ID, otherEscrow));

  const res = await submit(intent, signature);
  assert.equal(res.status, 400);
  const body = (await res.json()) as { error: string };
  assert.equal(body.error, "Signature verification failed");
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
  assert.match(body.error, /Invalid status filter/);
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
    assert.equal(res.status, 201);
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
  assert.equal(body.error, "Intent has expired");
});

// Duplicate submissions are documented as last-write-wins returning 201, not a
// 409 (see docs/api/mempool-api.yaml and the closed #320). Pinned here so the
// behaviour cannot drift silently.
test("duplicate submission returns 201 and overwrites the stored record, as documented", async () => {
  const intent = sampleIntent();
  const signature = await sign(intent, perihelionDomain(CHAIN_ID, ESCROW));

  const first = await submit(intent, signature);
  assert.equal(first.status, 201);
  const { hash } = (await first.json()) as { hash: `0x${string}` };

  await patchStatus(server, hash, "filled");

  const dup = await submit(intent, signature);
  assert.equal(dup.status, 201);
  assert.equal(((await dup.json()) as { hash: string }).hash, hash);

  const record = (await (await fetch(`${BASE}/intents/${hash}`)).json()) as { status: string };
  assert.equal(record.status, "pending", "a resubmission resets the stored record");
});

test("terminal statuses are final: a settled intent cannot move backwards", async () => {
  const intent = sampleIntent();
  const signature = await sign(intent, perihelionDomain(CHAIN_ID, ESCROW));

  const res = await submit(intent, signature);
  const { hash } = (await res.json()) as { hash: `0x${string}` };

  assert.equal((await patchStatus(server, hash, "settled")).status, 200);
  assert.equal((await patchStatus(server, hash, "pending")).status, 404);

  const record = (await (await fetch(`${BASE}/intents/${hash}`)).json()) as { status: string };
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
    assert.equal(res1.status, 201, "first request should succeed");

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
    assert.equal(res1.status, 201, "first request should succeed");

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

test("multiple forged X-Forwarded-For entries do not bypass rate limiting (#739)", async () => {
  const serverNoTrustProxy = new MempoolServer({
    port: 3992,
    chainId: CHAIN_ID,
    verifyingContract: ESCROW,
    rateLimitWindowMs: 1000,
    writeRateLimit: 1,
  });
  await serverNoTrustProxy.start();

  try {
    const baseUrl = `http://localhost:3992`;
    const intent1 = sampleIntent();
    const sig1 = await sign(intent1, perihelionDomain(CHAIN_ID, ESCROW));

    const res1 = await fetch(`${baseUrl}/intents`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Forwarded-For": "203.0.113.1, 203.0.113.2, 203.0.113.3",
      },
      body: JSON.stringify({ intent: intent1, signature: sig1 }),
    });
    assert.equal(res1.status, 201, "first request should succeed");

    const intent2 = { ...sampleIntent(), sourceAmount: "100000000" };
    const sig2 = await sign(intent2, perihelionDomain(CHAIN_ID, ESCROW));
    const res2 = await fetch(`${baseUrl}/intents`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Forwarded-For": "203.0.113.10, 203.0.113.20, 203.0.113.30",
      },
      body: JSON.stringify({ intent: intent2, signature: sig2 }),
    });
    assert.equal(
      res2.status,
      429,
      "second request with forged multi-entry X-Forwarded-For should still be rate-limited",
    );
  } finally {
    await serverNoTrustProxy.stop();
  }
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
  assert.ok(body.nextCursor === undefined || typeof body.nextCursor === "string", "nextCursor is absent on the last page or a string");
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

test("GET /intents limit parameter: values above MAX_LIST_LIMIT are rejected, not clamped", async () => {
  // The spec documents limit as 1..1000 and out-of-range values as 400.
  const res = await fetch(`${BASE}/intents?status=pending&limit=1001`);
  assert.equal(res.status, 400);
  assert.match(((await res.json()) as { error: string }).error, /limit/);

  const ok = await fetch(`${BASE}/intents?status=pending&limit=1000`);
  assert.equal(ok.status, 200);
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
  assert.ok(body.nextCursor === undefined || typeof body.nextCursor === "string", "nextCursor is absent on the last page or a string");
  assert.ok(!Array.isArray(body), "response must NOT be a bare array");
});

// ─── Issue 566: strict validation of every list query parameter ────────────

test("GET /intents?limit=<non-numeric> returns 400 naming the parameter", async () => {
  const res = await fetch(`${BASE}/intents?limit=abc`);
  assert.equal(res.status, 400);
  const body = (await res.json()) as { error: string };
  assert.match(body.error, /limit/);
});

test("GET /intents?limit=0 and negative/fractional values return 400", async () => {
  for (const bad of ["0", "-5", "1.5", "12e3"]) {
    const res = await fetch(`${BASE}/intents?limit=${encodeURIComponent(bad)}`);
    assert.equal(res.status, 400, `limit=${bad} should be rejected`);
  }
});

test("GET /intents?limit=<repeated> returns 400 rather than substituting the default", async () => {
  const res = await fetch(`${BASE}/intents?limit=10&limit=20`);
  assert.equal(res.status, 400);
});

test("GET /intents?chainId=<non-numeric> returns 400, not an empty 200 page", async () => {
  const res = await fetch(`${BASE}/intents?chainId=abc`);
  assert.equal(res.status, 400);
  const body = (await res.json()) as { error: string };
  assert.match(body.error, /chainId/);
});

test("GET /intents?chainId=<repeated> returns 400 instead of filtering on NaN", async () => {
  const res = await fetch(`${BASE}/intents?chainId=1&chainId=2`);
  assert.equal(res.status, 400);
});

test("GET /intents?chainId=<valid-but-unknown> still returns an empty 200 page", async () => {
  const res = await fetch(`${BASE}/intents?chainId=999999`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { records: unknown[] };
  assert.equal(body.records.length, 0);
});

test("GET /intents?cursor=<repeated> returns 400", async () => {
  const res = await fetch(`${BASE}/intents?cursor=0xaa&cursor=0xbb`);
  assert.equal(res.status, 400);
});

// ─── Issue 569: framework errors are JSON, never HTML, never a stack trace ──

test("POST /intents with a body over the 8kb limit returns 413 JSON naming the limit", async () => {
  const res = await fetch(`${BASE}/intents`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ intent: { blob: "x".repeat(9000) }, signature: "0x00" }),
  });
  assert.equal(res.status, 413);
  assert.match(res.headers.get("content-type") ?? "", /application\/json/);
  const body = (await res.json()) as { error: string };
  assert.match(body.error, /8kb/i);
});

test("POST /intents with malformed JSON returns 400 JSON, not an HTML error page", async () => {
  const res = await fetch(`${BASE}/intents`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{ not valid json",
  });
  assert.equal(res.status, 400);
  assert.match(res.headers.get("content-type") ?? "", /application\/json/);
  const body = (await res.json()) as { error: string };
  assert.equal(typeof body.error, "string");
  assert.doesNotMatch(body.error, /at .*\(.*:\d+:\d+\)/, "message must not contain a stack frame");
});

test("an unknown route returns 404 JSON in the standard error shape", async () => {
  const res = await fetch(`${BASE}/no-such-route`);
  assert.equal(res.status, 404);
  assert.match(res.headers.get("content-type") ?? "", /application\/json/);
  const body = (await res.json()) as { error: string };
  assert.equal(typeof body.error, "string");
});

// ─── Issue 564: every route is rate limited, with separate read/write budgets ─

test("read and write routes enforce independent, configurable rate-limit budgets", async () => {
  const port = 3990;
  const limited = new MempoolServer({
    port,
    chainId: CHAIN_ID,
    verifyingContract: ESCROW,
    readRateLimit: 3,
    writeRateLimit: 1,
    rateLimitWindowMs: 60_000,
  });
  await limited.start();
  try {
    const base = `http://localhost:${port}`;

    // Reads: the 4th GET within the window is rejected.
    for (let i = 0; i < 3; i++) {
      assert.equal((await fetch(`${base}/info`)).status, 200, `read ${i + 1} should pass`);
    }
    assert.equal((await fetch(`${base}/info`)).status, 429, "read 4 should be limited");

    // Writes draw on a separate budget that the read burst did not touch.
    const first = await fetch(`${base}/intents`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.notEqual(first.status, 429, "first write should not be pre-limited by reads");
    const second = await fetch(`${base}/intents`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(second.status, 429, "second write should be limited");
  } finally {
    await limited.stop();
  }
});
