// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MempoolResponseError,
  MempoolResponseTooLargeError,
  parseIntent,
  parseIntentRecord,
  parseIntentRecordArray,
  parseSignedIntent,
} from "../src/validate.js";

const VALID_ADDRESS = "0x1234567890123456789012345678901234567890";
const VALID_HASH = "0x" + "ab".repeat(32);
const VALID_SIG = "0x" + "cd".repeat(65);
const VALID_ISSUER = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";

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

test("parseIntentRecord rejects a non-positive or non-integer deadline", () => {
  for (const deadline of [-1, 0, 1.5, NaN]) {
    const record = validRecord();
    (record.intent as Record<string, unknown>).deadline = deadline;
    assert.throws(() => parseIntentRecord(record), MempoolResponseError);
  }
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

test("parseIntentRecord accepts a lowercase asset code (issue #524 consistency)", () => {
  // parseIntent uses isStellarAsset, which accepts mixed-case codes; validateIntent
  // now uses the same validator, so both paths must agree on a lowercase code.
  const record = parseIntentRecord(
    validRecord({ intent: { ...validRecord().intent, destAsset: `usdc:${VALID_ISSUER}` } })
  );
  assert.equal(record.intent.destAsset, `usdc:${VALID_ISSUER}`);
});

test("parseIntentRecord rejects an issuer strkey with a corrupted checksum", () => {
  const corruptIssuer = "GB5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
  assert.throws(
    () =>
      parseIntentRecord(
        validRecord({ intent: { ...validRecord().intent, destAsset: `USDC:${corruptIssuer}` } })
      ),
    MempoolResponseError
  );
});

test("parseIntentRecordArray validates every element", () => {
  const records = parseIntentRecordArray([validRecord(), validRecord({ status: "settled" })]);
  assert.equal(records.length, 2);
  assert.throws(
    () => parseIntentRecordArray([validRecord(), { not: "valid" }]),
    MempoolResponseError,
  );
});

// ---------------------------------------------------------------------------
// Issue #530 — hash/signature length-aware validation
// ---------------------------------------------------------------------------

test("parseSignedIntent rejects a hash of the wrong byte length", () => {
  for (const hash of ["0x0", "0x" + "ab".repeat(31), "0x" + "ab".repeat(33)]) {
    assert.throws(
      () => parseSignedIntent({ intent: validRecord().intent, signature: VALID_SIG, hash }),
      MempoolResponseError,
    );
  }
});

test("parseSignedIntent rejects an odd-length hex hash", () => {
  assert.throws(
    () =>
      parseSignedIntent({
        intent: validRecord().intent,
        signature: VALID_SIG,
        hash: VALID_HASH.slice(0, -1), // drop one hex digit -> odd length
      }),
    MempoolResponseError,
  );
});

test("parseSignedIntent accepts an exactly 32-byte (66-char) hash", () => {
  const signed = parseSignedIntent({
    intent: validRecord().intent,
    signature: VALID_SIG,
    hash: VALID_HASH,
  });
  assert.equal(signed.hash, VALID_HASH);
});

test("parseSignedIntent rejects a signature of the wrong byte length", () => {
  for (const signature of ["0x0", "0x" + "cd".repeat(64), "0x" + "cd".repeat(66)]) {
    assert.throws(
      () => parseSignedIntent({ intent: validRecord().intent, signature, hash: VALID_HASH }),
      MempoolResponseError,
    );
  }
});

test("parseSignedIntent rejects an odd-length hex signature", () => {
  assert.throws(
    () =>
      parseSignedIntent({
        intent: validRecord().intent,
        signature: VALID_SIG.slice(0, -1), // drop one hex digit -> odd length
        hash: VALID_HASH,
      }),
    MempoolResponseError,
  );
});

test("parseSignedIntent accepts an exactly 65-byte (132-char) signature", () => {
  const signed = parseSignedIntent({
    intent: validRecord().intent,
    signature: VALID_SIG,
    hash: VALID_HASH,
  });
  assert.equal(signed.signature, VALID_SIG);
});

// ---------------------------------------------------------------------------
// Issue #531 — parseIntent harmonized with validateIntent on sourceChainId
// and amount fields.
// ---------------------------------------------------------------------------

test("parseIntent rejects a non-positive or non-integer sourceChainId", () => {
  for (const sourceChainId of [0, -1, 8453.5, NaN]) {
    const intent = { ...validRecord().intent, sourceChainId };
    assert.throws(() => parseIntent(intent), MempoolResponseError);
  }
});

test("parseIntent rejects a zero or non-positive sourceAmount/minDestAmount", () => {
  for (const bad of ["0", "-1", "01", ""]) {
    assert.throws(
      () => parseIntent({ ...validRecord().intent, sourceAmount: bad }),
      MempoolResponseError,
    );
    assert.throws(
      () => parseIntent({ ...validRecord().intent, minDestAmount: bad }),
      MempoolResponseError,
    );
  }
});

test("parseIntent accepts a valid positive sourceChainId and amounts", () => {
  const intent = parseIntent(validRecord().intent);
  assert.equal(intent.sourceChainId, 8453);
  assert.equal(intent.sourceAmount, "1000000");
  assert.equal(intent.minDestAmount, "900000");
});

// ---------------------------------------------------------------------------
// Issue #532 — bounded array parsing and truncated error strings
// ---------------------------------------------------------------------------

test("parseIntentRecordArray throws MempoolResponseTooLargeError beyond the default limit", () => {
  const oversized = Array.from({ length: 5001 }, () => validRecord());
  assert.throws(() => parseIntentRecordArray(oversized), MempoolResponseTooLargeError);
});

test("parseIntentRecordArray accepts an array at exactly the default limit", () => {
  const atLimit = Array.from({ length: 5000 }, () => validRecord());
  const records = parseIntentRecordArray(atLimit);
  assert.equal(records.length, 5000);
});

test("parseIntentRecordArray respects an explicit maxLimit override", () => {
  const records = [validRecord(), validRecord()];
  assert.throws(() => parseIntentRecordArray(records, 1), MempoolResponseTooLargeError);
  assert.equal(parseIntentRecordArray(records, 2).length, 2);
});

test("parseIntentRecordArray error messages are truncated for oversized offending values", () => {
  const huge = "x".repeat(10_000);
  try {
    parseIntentRecordArray(huge as unknown as unknown[]);
    assert.fail("expected parseIntentRecordArray to throw for a non-array payload");
  } catch (err) {
    assert.ok(err instanceof MempoolResponseError);
    assert.ok(
      (err as Error).message.length < huge.length,
      "error message must not embed the full 10,000-char offending value",
    );
  }
});
