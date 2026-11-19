// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { test } from "node:test";
import { PerihelionClient } from "../src/client.js";
import { PerihelionPaginationError, PerihelionValidationError } from "../src/errors.js";

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

function makeClient(
  fetchImpl: typeof fetch,
  mempoolUrl = "https://mempool.example.com/",
  logger?: { warn(message: string): void },
) {
  return new PerihelionClient({ mempoolUrl, fetch: fetchImpl, logger });
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
  makeClient((() => {}) as unknown as typeof fetch, "http://remote.example.com/api", { warn: (message: string) => warnings.push(message) });
  assert.equal(warnings.length, 1, "expected exactly one warning");
  assert.ok(warnings[0].includes("http://"), `warning should mention http://: ${warnings[0]}`);
  assert.ok(warnings[0].includes("bearer"), `warning should mention bearer tokens: ${warnings[0]}`);
});

test("constructor does NOT warn for https:// on a remote host", () => {
  const warnings: string[] = [];
  makeClient((() => {}) as unknown as typeof fetch, "https://remote.example.com/api", { warn: (message: string) => warnings.push(message) });
  assert.equal(warnings.length, 0, "no warning expected for https://");
});

test("constructor does NOT warn for http://localhost", () => {
  const warnings: string[] = [];
  makeClient((() => {}) as unknown as typeof fetch, "http://localhost:3000", { warn: (message: string) => warnings.push(message) });
  assert.equal(warnings.length, 0, "no warning expected for loopback http://");
});

test("constructor does NOT warn for http://127.0.0.1", () => {
  const warnings: string[] = [];
  makeClient((() => {}) as unknown as typeof fetch, "http://127.0.0.1:3000", { warn: (message: string) => warnings.push(message) });
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

// ─── getIntent / reportStatus: hash validation ────────────────────────────────

const BAD_HASHES: unknown[] = [
  "../admin",
  "x?y=",
  VALID_HASH + "/../../admin",
  VALID_HASH + "?x=1",
  "0x" + "ab".repeat(31), // 31 bytes
  "0x" + "ab".repeat(33), // 33 bytes
  "ab".repeat(32), // missing 0x
  "0x" + "zz".repeat(32),
  "",
  undefined,
  42,
];

for (const bad of BAD_HASHES) {
  test(`getIntent rejects ${JSON.stringify(bad)} without making a request`, async () => {
    let calls = 0;
    const client = makeClient((async () => {
      calls++;
      return new Response("{}");
    }) as unknown as typeof fetch);
    await assert.rejects(client.getIntent(bad as `0x${string}`), PerihelionValidationError);
    assert.equal(calls, 0);
  });

  test(`reportStatus rejects ${JSON.stringify(bad)} without sending the token`, async () => {
    let calls = 0;
    const client = makeClient((async () => {
      calls++;
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch);
    await assert.rejects(
      client.reportStatus(bad as `0x${string}`, "filled", "secret-token"),
      PerihelionValidationError,
    );
    assert.equal(calls, 0);
  });
}

test("getIntent and reportStatus lower-case the hash in the request URL", async () => {
  const urls: string[] = [];
  const client = makeClient((async (url: string | URL) => {
    urls.push(String(url));
    return urls.length === 1
      ? new Response(JSON.stringify(makeRecord()), { status: 200 })
      : new Response(null, { status: 204 });
  }) as unknown as typeof fetch);
  const mixed = ("0x" + "AB".repeat(32)) as `0x${string}`;
  await client.getIntent(mixed);
  await client.reportStatus(mixed, "filled", "secret-token");
  assert.deepEqual(urls, [
    `https://mempool.example.com/intents/${VALID_HASH}`,
    `https://mempool.example.com/intents/${VALID_HASH}/status`,
  ]);
});

// ─── listPending: truncation is never silent ──────────────────────────────────

/** A server that always has another page: page N returns cursor "cN". */
function endlessServer(calls: string[], cursorFor: (n: number) => string) {
  return (async (url: string | URL | Request) => {
    calls.push(url.toString());
    const n = calls.length;
    const record = { ...makeRecord(), hash: "0x" + n.toString(16).padStart(64, "0") };
    return new Response(JSON.stringify({ records: [record], nextCursor: cursorFor(n) }), { status: 200 });
  }) as unknown as typeof fetch;
}

test("listPending throws PerihelionPaginationError when maxPages is hit with more pages left", async () => {
  const calls: string[] = [];
  const client = makeClient(endlessServer(calls, (n) => `c${n}`));
  const err = await client.listPending("pending", 3).then(
    () => assert.fail("listPending must not return a truncated result"),
    (e: unknown) => e,
  );
  assert.ok(err instanceof PerihelionPaginationError, `got ${String(err)}`);
  assert.equal(err.reason, "max_pages");
  assert.equal(err.pages, 3);
  assert.equal(err.records.length, 3, "partial records are carried on the error");
  assert.equal(err.nextCursor, "c3", "the cursor to resume from");
  assert.equal(calls.length, 3);
});

test("listPending returns normally when the last page lands exactly on maxPages", async () => {
  const calls: string[] = [];
  const fetchImpl = (async (url: string | URL | Request) => {
    calls.push(url.toString());
    const nextCursor = calls.length < 2 ? `c${calls.length}` : undefined;
    return new Response(JSON.stringify({ records: [makeRecord()], nextCursor }), { status: 200 });
  }) as unknown as typeof fetch;
  const result = await makeClient(fetchImpl).listPending("pending", 2);
  assert.equal(result.length, 2);
});

test("listPending detects a server that repeats a cursor", async () => {
  const calls: string[] = [];
  // c1, c2, c1, ... — loops back to an earlier cursor.
  const client = makeClient(endlessServer(calls, (n) => (n % 2 === 1 ? "c1" : "c2")));
  const err = await client.listPending().then(
    () => assert.fail("must not return"),
    (e: unknown) => e,
  );
  assert.ok(err instanceof PerihelionPaginationError);
  assert.equal(err.reason, "repeated_cursor");
  assert.equal(err.nextCursor, "c1");
  assert.equal(calls.length, 3, "stops as soon as the cursor repeats, not at maxPages");
});

test("listPendingPages stops on a repeated cursor instead of looping forever", async () => {
  const calls: string[] = [];
  const client = makeClient(endlessServer(calls, () => "same"));
  let pages = 0;
  await assert.rejects(async () => {
    for await (const _page of client.listPendingPages()) pages++;
  }, PerihelionPaginationError);
  assert.equal(pages, 2);
});

test("constructor writes nothing to the console without a logger (#980)", () => {
  const seen: unknown[] = [];
  const origWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    seen.push(args);
  };
  try {
    makeClient((() => {}) as unknown as typeof fetch, "http://remote.example.com/api");
  } finally {
    console.warn = origWarn;
  }
  assert.equal(seen.length, 0, "the SDK must not write to the console by default");
});
