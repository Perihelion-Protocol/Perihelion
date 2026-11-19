// SPDX-License-Identifier: MIT

/**
 * Contract test for `docs/api/mempool-api.yaml`.
 *
 * Starts a real `MempoolServer`, exercises the documented operations over
 * HTTP, and validates the actual response bodies against the JSON Schemas
 * extracted from the parsed OpenAPI document with Ajv. This is the
 * regression test for issue #351 ("mempool-api.yaml is not validated
 * against the implementation or checked in CI") — it fails the moment the
 * spec and the server's real wire format drift apart again.
 */

import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import yaml from "js-yaml";
import { Ajv } from "ajv";
import {
  buildIntent,
  perihelionDomain,
  INTENT_TYPES,
  toMessage,
  type Address,
} from "@perihelion/sdk";
import { privateKeyToAccount } from "viem/accounts";
import { MempoolServer } from "../src/server.js";

const CHAIN_ID = 8453;
const ESCROW: Address = "0x00000000000000000000000000000000000000cc";
const PORT = 3988;
const BASE = `http://localhost:${PORT}`;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SPEC_PATH = path.resolve(__dirname, "../../docs/api/mempool-api.yaml");

const account = privateKeyToAccount(("0x" + "22".repeat(32)) as `0x${string}`);

let server: MempoolServer;

// The OpenAPI document, parsed once for the whole test file.
const spec = yaml.load(readFileSync(SPEC_PATH, "utf8")) as Record<string, unknown>;

// A single Ajv instance, seeded with every schema under `components.schemas`
// so `$ref: '#/components/schemas/...'` resolves across schemas exactly as
// it does in the OpenAPI document itself.
const ajv = new Ajv({ strict: false });
const schemas = (spec.components as { schemas: Record<string, unknown> }).schemas;
for (const [name, schema] of Object.entries(schemas)) {
  ajv.addSchema(schema as object, `#/components/schemas/${name}`);
}

/** Resolve `responses.<status>.content.application/json.schema` for a given path+method. */
function responseSchema(pathKey: string, method: string, status: string): object {
  const paths = spec.paths as Record<string, Record<string, any>>;
  const op = paths[pathKey]?.[method];
  if (!op) throw new Error(`spec has no ${method.toUpperCase()} ${pathKey} operation`);
  const schema = op.responses[status]?.content?.["application/json"]?.schema;
  if (!schema) throw new Error(`spec has no ${status} JSON response documented for ${method.toUpperCase()} ${pathKey}`);
  return schema;
}

/** Validate `data` against a schema object pulled from the spec, throwing with Ajv's errors on failure. */
function assertMatchesSchema(schema: object, data: unknown, label: string): void {
  const validate = ajv.compile(schema as object);
  const valid = validate(data);
  if (!valid) {
    assert.fail(
      `${label} does not match its documented schema:\n${JSON.stringify(validate.errors, null, 2)}\n\nResponse body:\n${JSON.stringify(data, null, 2)}`,
    );
  }
}

before(async () => {
  server = new MempoolServer({ port: PORT, chainId: CHAIN_ID, verifyingContract: ESCROW });
  await server.start();
});

after(async () => {
  await server.stop();
});

function sampleIntent(overrides: Partial<Parameters<typeof buildIntent>[0]> = {}) {
  return buildIntent({
    user: account.address,
    destination: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
    sourceChainId: CHAIN_ID,
    sourceAsset: "0x0000000000000000000000000000000000000004" as Address,
    sourceAmount: "10000000",
    destAsset: "native",
    minDestAmount: "9900000",
    deadline: Math.floor(Date.now() / 1000) + 600,
    ...overrides,
  });
}

async function submitSignedIntent(overrides: Partial<Parameters<typeof buildIntent>[0]> = {}) {
  const domain = perihelionDomain(CHAIN_ID, ESCROW);
  const intent = sampleIntent(overrides);
  const signature = await account.signTypedData({
    domain,
    types: INTENT_TYPES,
    primaryType: "Intent",
    message: toMessage(intent),
  });
  const res = await fetch(`${BASE}/intents`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ intent, signature }),
  });
  return res;
}

test("spec has the expected paths and schemas (sanity check on the fixture itself)", () => {
  const paths = spec.paths as Record<string, unknown>;
  assert.ok(paths["/intents"], "spec must document /intents");
  assert.ok(paths["/intents/{hash}"], "spec must document /intents/{hash}");
  assert.ok(paths["/info"], "spec must document /info");
  assert.ok(schemas.IntentRecord, "spec must define IntentRecord");
});

test("POST /intents 201 response matches the documented SubmitIntentResponse schema", async () => {
  const res = await submitSignedIntent();
  assert.equal(res.status, 201);
  const body = await res.json();
  assertMatchesSchema(
    responseSchema("/intents", "post", "201"),
    body,
    "POST /intents 201 body",
  );
});

test("POST /intents: a duplicate submission returns 201 and overwrites, as documented (no 409)", async () => {
  const responses = (spec.paths as Record<string, any>)["/intents"].post.responses;
  assert.ok(!("409" in responses), "spec must not document a 409 the server never sends");

  // Pin every field that varies per call so both submissions hash identically.
  const fixed = { nonce: "123456789", deadline: Math.floor(Date.now() / 1000) + 600 };
  const first = await submitSignedIntent(fixed);
  assert.equal(first.status, 201);
  const { hash } = (await first.json()) as { hash: string };

  const patched = await fetch(`${BASE}/intents/${hash}/status`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ status: "filled" }),
  });
  assert.equal(patched.status, 200);

  const second = await submitSignedIntent(fixed);
  assert.equal(second.status, 201);
  assert.equal(((await second.json()) as { hash: string }).hash, hash);

  const record = (await (await fetch(`${BASE}/intents/${hash}`)).json()) as { status: string };
  assert.equal(record.status, "pending", "a resubmission resets the stored record");
});

test("PATCH /intents/:hash/status accepts exactly the documented IntentStatus vocabulary", async () => {
  const documented = (schemas.IntentStatus as { enum: string[] }).enum;
  // Terminal statuses freeze a record, so each transition gets a fresh intent.
  const patchFresh = async (status: string) => {
    const { hash } = (await (await submitSignedIntent()).json()) as { hash: string };
    return fetch(`${BASE}/intents/${hash}/status`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status }),
    });
  };

  for (const status of documented) {
    const res = await patchFresh(status);
    assert.equal(res.status, 200, `documented status "${status}" must be accepted`);
  }
  // Lifecycle states the SDK's broader IntentStatus has but the mempool rejects.
  for (const status of ["claimed", "settling", "cancelling"]) {
    assert.ok(!documented.includes(status), `spec must not document "${status}"`);
    const res = await patchFresh(status);
    assert.equal(res.status, 400, `undocumented status "${status}" must be rejected`);
    assertMatchesSchema(
      responseSchema("/intents/{hash}/status", "patch", "400"),
      await res.json(),
      `PATCH status=${status} 400 body`,
    );
  }
});

test("POST /intents 400 (invalid signature) response matches the documented ErrorResponse schema", async () => {
  const domain = perihelionDomain(999, ESCROW); // wrong chain -> signature won't verify
  const intent = sampleIntent();
  const signature = await account.signTypedData({
    domain,
    types: INTENT_TYPES,
    primaryType: "Intent",
    message: toMessage(intent),
  });
  const res = await fetch(`${BASE}/intents`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ intent, signature }),
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assertMatchesSchema(
    responseSchema("/intents", "post", "400"),
    body,
    "POST /intents 400 body",
  );
});

test("GET /intents 200 response matches the documented IntentRecord[] schema, including submittedAt", async () => {
  await submitSignedIntent();

  const res = await fetch(`${BASE}/intents`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { records: Array<Record<string, unknown>>; nextCursor?: string };
  assert.ok(body.records && body.records.length > 0);

  assertMatchesSchema(responseSchema("/intents", "get", "200"), body, "GET /intents 200 body");

  // Verify the record includes the expected timestamp field.
  const record = body.records[0];
  assert.equal(typeof record.createdAt, "number");
});

test("GET /intents?status=<invalid> returns the documented 400", async () => {
  const res = await fetch(`${BASE}/intents?status=bogus`);
  assert.equal(res.status, 400);
  const body = await res.json();
  assertMatchesSchema(
    responseSchema("/intents", "get", "400"),
    body,
    "GET /intents?status=bogus 400 body",
  );
});

test("GET /intents supports limit/offset pagination", async () => {
  // Submit a couple more intents (distinct nonces -> distinct hashes).
  await submitSignedIntent();
  await submitSignedIntent();

  const full = (await (await fetch(`${BASE}/intents`)).json()) as { records: unknown[]; nextCursor?: string };
  assert.ok(full.records.length >= 3);

  const page = (await (await fetch(`${BASE}/intents?limit=1&cursor=${(full.records[0] as Record<string, unknown>).hash}`)).json()) as { records: unknown[]; nextCursor?: string };
  assert.equal(page.records.length, 1);
  assertMatchesSchema(responseSchema("/intents", "get", "200"), page, "GET /intents paginated body");
});

test("GET /intents?chainId=<other> filters out non-matching intents", async () => {
  const res = await fetch(`${BASE}/intents?chainId=999999`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { records: unknown[]; nextCursor?: string };
  assert.equal(body.records.length, 0);
});

test("GET /intents/:hash 200 response matches the documented IntentRecord schema", async () => {
  const submitRes = await submitSignedIntent();
  const { hash } = (await submitRes.json()) as { hash: string };

  const res = await fetch(`${BASE}/intents/${hash}`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assertMatchesSchema(
    responseSchema("/intents/{hash}", "get", "200"),
    body,
    "GET /intents/:hash 200 body",
  );
});

test("GET /intents/:hash 404 response matches the documented ErrorResponse schema", async () => {
  // Use a well-formed hash that doesn't exist (not a malformed one).
  // Malformed hashes return 400 (see server.test.ts "returns 400 for a malformed hash").
  const res = await fetch(`${BASE}/intents/0x${"00".repeat(32)}`);
  assert.equal(res.status, 404);
  const body = await res.json();
  assertMatchesSchema(
    responseSchema("/intents/{hash}", "get", "404"),
    body,
    "GET /intents/:hash 404 body",
  );
});

test("POST /intents 413 (oversized body) matches the documented ErrorResponse schema", async () => {
  const res = await fetch(`${BASE}/intents`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ intent: { blob: "x".repeat(9000) }, signature: "0x00" }),
  });
  assert.equal(res.status, 413);
  assert.match(res.headers.get("content-type") ?? "", /application\/json/);
  const body = await res.json();
  assertMatchesSchema(
    responseSchema("/intents", "post", "413"),
    body,
    "POST /intents 413 body",
  );
});

test("POST /intents 400 (malformed JSON) matches the documented ErrorResponse schema", async () => {
  const res = await fetch(`${BASE}/intents`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{ not json",
  });
  assert.equal(res.status, 400);
  assert.match(res.headers.get("content-type") ?? "", /application\/json/);
  const body = await res.json();
  assertMatchesSchema(
    responseSchema("/intents", "post", "400"),
    body,
    "POST /intents 400 (malformed JSON) body",
  );
});

test("an unknown route returns 404 in the documented ErrorResponse shape", async () => {
  const res = await fetch(`${BASE}/does-not-exist`);
  assert.equal(res.status, 404);
  assert.match(res.headers.get("content-type") ?? "", /application\/json/);
  const body = await res.json();
  assertMatchesSchema(
    { $ref: "#/components/schemas/ErrorResponse" },
    body,
    "404 catch-all body",
  );
});

test("GET /intents enforces the documented limit bounds", async () => {
  const params = (spec.paths as Record<string, any>)["/intents"].get.parameters as Array<{
    name: string;
    schema: { minimum: number; maximum: number };
  }>;
  const { minimum, maximum } = params.find((p) => p.name === "limit")!.schema;
  for (const limit of [minimum, maximum]) {
    const res = await fetch(`${BASE}/intents?limit=${limit}`);
    assert.equal(res.status, 200, `limit=${limit} is documented as valid`);
  }
  for (const limit of [minimum - 1, maximum + 1]) {
    const res = await fetch(`${BASE}/intents?limit=${limit}`);
    assert.equal(res.status, 400, `limit=${limit} is outside the documented range`);
  }
});

test("GET /intents?limit=<invalid> returns the documented 400", async () => {
  const res = await fetch(`${BASE}/intents?limit=abc`);
  assert.equal(res.status, 400);
  const body = await res.json();
  assertMatchesSchema(
    responseSchema("/intents", "get", "400"),
    body,
    "GET /intents?limit=abc 400 body",
  );
});

test("GET /intents?chainId=<invalid> returns the documented 400", async () => {
  const res = await fetch(`${BASE}/intents?chainId=abc`);
  assert.equal(res.status, 400);
  const body = await res.json();
  assertMatchesSchema(
    responseSchema("/intents", "get", "400"),
    body,
    "GET /intents?chainId=abc 400 body",
  );
});

test("GET /info matches the documented InfoResponse schema and reflects the configured domain", async () => {
  const res = await fetch(`${BASE}/info`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assertMatchesSchema(responseSchema("/info", "get", "200"), body, "GET /info 200 body");
  assert.deepEqual(body, {
    chainId: CHAIN_ID,
    verifyingContract: ESCROW,
    domain: perihelionDomain(CHAIN_ID, ESCROW),
  });
});

test("PATCH /intents/:hash/status 200 response is the updated IntentRecord", async () => {
  const { hash } = (await (await submitSignedIntent()).json()) as { hash: string };
  const res = await fetch(`${BASE}/intents/${hash}/status`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ status: "filled" }),
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { hash: string; status: string };
  assertMatchesSchema(
    responseSchema("/intents/{hash}/status", "patch", "200"),
    body,
    "PATCH status 200 body",
  );
  assert.equal(body.hash, hash);
  assert.equal(body.status, "filled");
});

test("an unresolvable cursor returns the documented 400 with code unresolvable_cursor", async () => {
  const res = await fetch(`${BASE}/intents?cursor=0x${"00".repeat(32)}`);
  assert.equal(res.status, 400);
  const body = await res.json();
  assertMatchesSchema(responseSchema("/intents", "get", "400"), body, "unresolvable cursor 400 body");
  assert.equal((body as { code?: string }).code, "unresolvable_cursor");
});

test("a malformed cursor returns 400 without a code", async () => {
  const res = await fetch(`${BASE}/intents?cursor=not-a-cursor`);
  assert.equal(res.status, 400);
  const body = (await res.json()) as { error: string; code?: string };
  assert.equal(typeof body.error, "string");
  assert.equal(body.code, undefined);
});

test("a cursor whose record left the status filter is unresolvable", async () => {
  await submitSignedIntent();
  await submitSignedIntent();
  // Pending records are listed one at a time, so the page-1 record becomes the cursor.
  const page1 = (await (await fetch(`${BASE}/intents?status=pending&limit=1`)).json()) as {
    records: Array<{ hash: string }>;
    nextCursor?: string;
  };
  assert.ok(page1.nextCursor, "a second pending record must exist to produce a cursor");

  // Move the cursor's record out of the pending set, then resume paging with it.
  const moved = await fetch(`${BASE}/intents/${page1.nextCursor}/status`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ status: "filled" }),
  });
  assert.equal(moved.status, 200);

  const res = await fetch(`${BASE}/intents?status=pending&limit=1&cursor=${page1.nextCursor}`);
  assert.equal(res.status, 400);
  assert.equal(((await res.json()) as { code?: string }).code, "unresolvable_cursor");
});

test("GET /healthz and GET /readyz match their documented schemas", async () => {
  const health = await fetch(`${BASE}/healthz`);
  assert.equal(health.status, 200);
  assertMatchesSchema(responseSchema("/healthz", "get", "200"), await health.json(), "GET /healthz 200 body");

  const ready = await fetch(`${BASE}/readyz`);
  assert.equal(ready.status, 200);
  assertMatchesSchema(responseSchema("/readyz", "get", "200"), await ready.json(), "GET /readyz 200 body");
});

test("GET /metrics is documented as Prometheus text and exposes the documented gauges", async () => {
  const res = await fetch(`${BASE}/metrics`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /text\/plain/);
  const text = await res.text();
  assert.match(text, /^mempool_store_size \d+$/m);
  assert.match(text, /^# TYPE mempool_submissions_accepted_total counter$/m);
});

test("GET /metrics with metricsToken configured returns the documented 401 and 200", async () => {
  const token = "contract-metrics-token";
  const secured = new MempoolServer({
    port: 3993,
    chainId: CHAIN_ID,
    verifyingContract: ESCROW,
    metricsToken: token,
  });
  await secured.start();
  try {
    const denied = await fetch("http://localhost:3993/metrics");
    assert.equal(denied.status, 401);
    assertMatchesSchema(responseSchema("/metrics", "get", "401"), await denied.json(), "GET /metrics 401 body");

    const allowed = await fetch("http://localhost:3993/metrics", {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(allowed.status, 200);
  } finally {
    await secured.stop();
  }
});

test("a rate-limited request returns the documented 429 ErrorResponse", async () => {
  const limited = new MempoolServer({
    port: 3994,
    chainId: CHAIN_ID,
    verifyingContract: ESCROW,
    readRateLimit: 1,
  });
  await limited.start();
  try {
    assert.equal((await fetch("http://localhost:3994/info")).status, 200);
    const res = await fetch("http://localhost:3994/info");
    assert.equal(res.status, 429);
    assertMatchesSchema({ $ref: "#/components/schemas/ErrorResponse" }, await res.json(), "429 body");
  } finally {
    await limited.stop();
  }
});
