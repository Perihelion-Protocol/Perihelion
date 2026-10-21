// SPDX-License-Identifier: MIT

/**
 * Contract test between the SDK and `docs/api/mempool-api.yaml`.
 *
 * The SDK's doc-comments describe the mempool's status codes, status
 * vocabulary and page bounds, and integrators write error handling against
 * them. These tests pin those claims to the OpenAPI spec; the mempool's own
 * contract test (mempool/test/contract.test.ts) pins the spec to the server.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import yaml from "js-yaml";
import { PerihelionClient } from "../src/client.js";
import type { MempoolIntentStatus } from "../src/types.js";

interface Operation {
  responses: Record<string, unknown>;
  parameters?: Array<{ name: string; schema?: { minimum?: number; maximum?: number; default?: number } }>;
}

const spec = yaml.load(
  readFileSync(new URL("../../docs/api/mempool-api.yaml", import.meta.url), "utf8"),
) as {
  paths: Record<string, Record<string, Operation>>;
  components: { schemas: { IntentStatus: { enum: string[] } } };
};

const submitOp = spec.paths["/intents"].post;
const listOp = spec.paths["/intents"].get;
const statusOp = spec.paths["/intents/{hash}/status"].patch;

// Exhaustive at compile time: adding or removing a MempoolIntentStatus member
// without updating this record is a type error, so the runtime list below
// always mirrors the type.
const MEMPOOL_STATUSES: Record<MempoolIntentStatus, true> = {
  pending: true,
  filled: true,
  settled: true,
  refunded: true,
  expired: true,
};

test("MempoolIntentStatus matches the spec's IntentStatus vocabulary", () => {
  assert.deepEqual(
    Object.keys(MEMPOOL_STATUSES).sort(),
    [...spec.components.schemas.IntentStatus.enum].sort(),
  );
});

test("submitIntent: the spec documents 201 on success and 409 for duplicates", () => {
  assert.ok("201" in submitOp.responses);
  assert.ok("409" in submitOp.responses);
});

test("reportStatus: the spec documents 400/401/404 and no 409", () => {
  for (const code of ["400", "401", "404"]) assert.ok(code in statusOp.responses, code);
  assert.ok(!("409" in statusOp.responses));
});

test("listPending requests a limit within the spec's documented range", async () => {
  const limitSchema = listOp.parameters?.find((p) => p.name === "limit")?.schema;
  assert.ok(limitSchema?.minimum !== undefined && limitSchema.maximum !== undefined);

  const sent: number[] = [];
  const fetchImpl = async (url: string | URL | Request) => {
    sent.push(Number(new URL(url.toString()).searchParams.get("limit")));
    return new Response(JSON.stringify({ records: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const client = new PerihelionClient({ mempoolUrl: "https://mempool.example.com", fetch: fetchImpl });
  await client.listPending();

  assert.equal(sent.length, 1);
  assert.equal(sent[0], limitSchema.default, "SDK default should match the server's default page size");
  assert.ok(sent[0] >= limitSchema.minimum && sent[0] <= limitSchema.maximum);
});
