import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MempoolResponseError,
  parseIntentRecord,
  parseIntentRecordArray,
} from "../src/validate.js";

const VALID_ADDRESS = "0x1234567890123456789012345678901234567890";
const VALID_HASH = "0x" + "ab".repeat(32);
const VALID_SIG = "0x" + "cd".repeat(65);

function validRecord(overrides: Record<string, unknown> = {}) {
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
    status: "pending",
    createdAt: 1700000000,
    ...overrides,
  };
}

test("parseIntentRecord accepts a well-formed record", () => {
  const record = parseIntentRecord(validRecord());
  assert.equal(record.status, "pending");
  assert.equal(record.intent.sourceChainId, 8453);
});

test("parseIntentRecord rejects a non-object payload", () => {
  assert.throws(() => parseIntentRecord("not an object"), MempoolResponseError);
  assert.throws(() => parseIntentRecord(null), MempoolResponseError);
});

test("parseIntentRecord rejects missing intent fields", () => {
  const malformed = validRecord();
  delete (malformed.intent as Record<string, unknown>).sourceAmount;
  assert.throws(() => parseIntentRecord(malformed), MempoolResponseError);
});

test("parseIntentRecord rejects a non-address solver field", () => {
  assert.throws(
    () => parseIntentRecord(validRecord({ solver: "not-an-address" })),
    MempoolResponseError,
  );
});

test("parseIntentRecord rejects an unknown status", () => {
  assert.throws(
    () => parseIntentRecord(validRecord({ status: "vibing" })),
    MempoolResponseError,
  );
});

test("parseIntentRecord rejects a malformed signature", () => {
  assert.throws(
    () => parseIntentRecord(validRecord({ signature: "deadbeef" })),
    MempoolResponseError,
  );
});

test("parseIntentRecord rejects a non-numeric createdAt", () => {
  assert.throws(
    () => parseIntentRecord(validRecord({ createdAt: "1700000000" })),
    MempoolResponseError,
  );
});

test("parseIntentRecordArray rejects a non-array payload", () => {
  assert.throws(() => parseIntentRecordArray(validRecord()), MempoolResponseError);
});

test("parseIntentRecordArray validates every element", () => {
  const records = parseIntentRecordArray([validRecord(), validRecord({ status: "settled" })]);
  assert.equal(records.length, 2);
  assert.throws(
    () => parseIntentRecordArray([validRecord(), { not: "valid" }]),
    MempoolResponseError,
  );
});
