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

test("POST /intents 200 response matches the documented SubmitIntentResponse schema", async () => {
  const res = await submitSignedIntent();
  assert.equal(res.status, 200);
  const body = await res.json();
  assertMatchesSchema(
    responseSchema("/intents", "post", "200"),
    body,
    "POST /intents 200 body",
  );
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

test("GET /info matches the documented MempoolInfo schema and reflects the configured domain", async () => {
  const res = await fetch(`${BASE}/info`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assertMatchesSchema(responseSchema("/info", "get", "200"), body, "GET /info 200 body");
  assert.deepEqual(body, {
    name: "Perihelion",
    version: "1",
    chainId: CHAIN_ID,
    verifyingContract: ESCROW,
  });
});
