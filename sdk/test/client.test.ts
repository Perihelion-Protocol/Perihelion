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

// ─── constructor: URL validation ──────────────────────────────────────────────

test("constructor accepts a valid https:// URL", () => {
  assert.doesNotThrow(() => makeClient((() => {}) as unknown as typeof fetch, "https://mempool.perihelion.xyz"));
});

test("constructor accepts a valid http://localhost URL (loopback, no warning)", () => {
  assert.doesNotThrow(() => makeClient((() => {}) as unknown as typeof fetch, "http://localhost:3000"));
});

test("constructor accepts http://127.0.0.1 (loopback, no warning)", () => {
  assert.doesNotThrow(() => makeClient((() => {}) as unknown as typeof fetch, "http://127.0.0.1:3000"));
});

test("constructor accepts http://[::1] (IPv6 loopback, no warning)", () => {
  assert.doesNotThrow(() => makeClient((() => {}) as unknown as typeof fetch, "http://[::1]:3000"));
});

test("constructor throws PerihelionValidationError for a bare hostname (no scheme)", () => {
  assert.throws(
    () => makeClient((() => {}) as unknown as typeof fetch, "mempool.perihelion.xyz"),
    /mempoolUrl must be a valid URL/,
  );
});

test("constructor throws PerihelionValidationError for an empty string", () => {
  assert.throws(
    () => makeClient((() => {}) as unknown as typeof fetch, ""),
    /mempoolUrl must be a valid URL/,
  );
});

test("constructor throws PerihelionValidationError for a completely invalid string", () => {
  assert.throws(
    () => makeClient((() => {}) as unknown as typeof fetch, "not a url at all"),
    /mempoolUrl must be a valid URL/,
  );
});

test("constructor normalises a URL with multiple trailing slashes (no double-slash in requests)", async () => {
  let capturedUrl = "";
  const fetchImpl = async (url: string | URL | Request) => {
    capturedUrl = url.toString();
    return new Response(JSON.stringify({ records: [], nextCursor: undefined }), { status: 200 });
  };
  const client = new PerihelionClient({ mempoolUrl: "https://mempool.example.com//", fetch: fetchImpl as typeof fetch });
  await client.listPending();
  assert.ok(!capturedUrl.includes("//intents"), `URL must not have double-slash: ${capturedUrl}`);
});

test("constructor warns on non-loopback http:// URL", () => {
  const warnings: string[] = [];
  const origWarn = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(args.join(" "));
  try {
    makeClient((() => {}) as unknown as typeof fetch, "http://remote.example.com/api");
  } finally {
    console.warn = origWarn;
  }
  assert.equal(warnings.length, 1, "expected exactly one warning");
  assert.ok(warnings[0].includes("http://"), `warning should mention http://: ${warnings[0]}`);
  assert.ok(warnings[0].includes("bearer"), `warning should mention bearer tokens: ${warnings[0]}`);
});

test("constructor does NOT warn for https:// on a remote host", () => {
  const warnings: string[] = [];
  const origWarn = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(args.join(" "));
  try {
    makeClient((() => {}) as unknown as typeof fetch, "https://remote.example.com/api");
  } finally {
    console.warn = origWarn;
  }
  assert.equal(warnings.length, 0, "no warning expected for https://");
});

test("constructor does NOT warn for http://localhost", () => {
  const warnings: string[] = [];
  const origWarn = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(args.join(" "));
  try {
    makeClient((() => {}) as unknown as typeof fetch, "http://localhost:3000");
  } finally {
    console.warn = origWarn;
  }
  assert.equal(warnings.length, 0, "no warning expected for loopback http://");
});

test("constructor does NOT warn for http://127.0.0.1", () => {
  const warnings: string[] = [];
  const origWarn = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(args.join(" "));
  try {
    makeClient((() => {}) as unknown as typeof fetch, "http://127.0.0.1:3000");
  } finally {
    console.warn = origWarn;
  }
  assert.equal(warnings.length, 0, "no warning expected for 127.0.0.1 http://");
});

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

test("listPending rejects a response missing the records envelope", async () => {
  const fetchImpl = async () =>
    new Response(JSON.stringify({ nextCursor: undefined }), { status: 200 });
  const client = makeClient(fetchImpl as typeof fetch);
  await assert.rejects(() => client.listPending(), /expected an array of intent records/);
});

test("listPending rejects a response whose records is not an array", async () => {
  const fetchImpl = async () =>
    new Response(JSON.stringify({ records: { not: "an array" }, nextCursor: undefined }), {
      status: 200,
    });
  const client = makeClient(fetchImpl as typeof fetch);
  await assert.rejects(() => client.listPending(), /expected an array of intent records/);
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
      JSON.stringify({ records: [page1Record], nextCursor: "page2" }),
      { status: 200 },
    );
  };
  const client = makeClient(fetchImpl as typeof fetch);
  const result = await client.listPending();
  assert.equal(result.length, 2);
  assert.equal(result[0].hash, page1Record.hash);
  assert.equal(result[1].hash, page2Record.hash);
  assert.equal(calls.length, 2);
  assert.ok(calls[1].includes("cursor=page2"), `second call should include cursor: ${calls[1]}`);
});
