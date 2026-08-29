// SPDX-License-Identifier: MIT

/**
 * Issue #522 — Unified SDK Error Hierarchy
 *
 * Every error type exported by the SDK must be an instance of PerihelionError
 * so integrators can catch all SDK errors with a single `instanceof` check.
 * These tests assert the complete hierarchy and confirm that MempoolResponseError
 * and IntentValidationError are properly parented.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  PerihelionError,
  PerihelionHttpError,
  PerihelionTimeoutError,
  PerihelionNetworkError,
  PerihelionValidationError,
  PerihelionHashMismatchError,
  IntentValidationError,
} from "../src/errors.js";
import { MempoolResponseError } from "../src/validate.js";

// ---------------------------------------------------------------------------
// PerihelionError — base class
// ---------------------------------------------------------------------------

test("PerihelionError is an instance of Error", () => {
  const e = new PerihelionError("base error");
  assert.ok(e instanceof Error);
  assert.ok(e instanceof PerihelionError);
  assert.equal(e.message, "base error");
  assert.equal(e.name, "PerihelionError");
});

// ---------------------------------------------------------------------------
// PerihelionHttpError
// ---------------------------------------------------------------------------

test("PerihelionHttpError instanceof PerihelionError and Error", () => {
  const e = new PerihelionHttpError("submitIntent", 400, "bad request");
  assert.ok(e instanceof Error);
  assert.ok(e instanceof PerihelionError);
  assert.ok(e instanceof PerihelionHttpError);
  assert.equal(e.status, 400);
  assert.equal(e.body, "bad request");
  assert.equal(e.operation, "submitIntent");
  assert.equal(e.name, "PerihelionHttpError");
});

test("PerihelionHttpError with 5xx status is still instanceof PerihelionError", () => {
  const e = new PerihelionHttpError("getStatus", 503, "service unavailable");
  assert.ok(e instanceof PerihelionError);
  assert.equal(e.status, 503);
});

// ---------------------------------------------------------------------------
// PerihelionTimeoutError
// ---------------------------------------------------------------------------

test("PerihelionTimeoutError instanceof PerihelionError and Error", () => {
  const e = new PerihelionTimeoutError("timed out", "0xabc", "pending");
  assert.ok(e instanceof Error);
  assert.ok(e instanceof PerihelionError);
  assert.ok(e instanceof PerihelionTimeoutError);
  assert.equal(e.intentHash, "0xabc");
  assert.equal(e.lastStatus, "pending");
  assert.equal(e.name, "PerihelionTimeoutError");
});

test("PerihelionTimeoutError without optional fields", () => {
  const e = new PerihelionTimeoutError("request timed out");
  assert.ok(e instanceof PerihelionError);
  assert.equal(e.intentHash, undefined);
  assert.equal(e.lastStatus, undefined);
});

// ---------------------------------------------------------------------------
// PerihelionNetworkError
// ---------------------------------------------------------------------------

test("PerihelionNetworkError instanceof PerihelionError and Error", () => {
  const e = new PerihelionNetworkError("connection refused", "submitIntent");
  assert.ok(e instanceof Error);
  assert.ok(e instanceof PerihelionError);
  assert.ok(e instanceof PerihelionNetworkError);
  assert.equal(e.operation, "submitIntent");
  assert.equal(e.name, "PerihelionNetworkError");
});

test("PerihelionNetworkError without operation", () => {
  const e = new PerihelionNetworkError("fetch failed");
  assert.ok(e instanceof PerihelionError);
  assert.equal(e.operation, undefined);
});

// ---------------------------------------------------------------------------
// PerihelionValidationError
// ---------------------------------------------------------------------------

test("PerihelionValidationError instanceof PerihelionError and Error", () => {
  const e = new PerihelionValidationError("invalid value", "sourceAmount");
  assert.ok(e instanceof Error);
  assert.ok(e instanceof PerihelionError);
  assert.ok(e instanceof PerihelionValidationError);
  assert.equal(e.field, "sourceAmount");
  assert.equal(e.name, "PerihelionValidationError");
});

test("PerihelionValidationError without field", () => {
  const e = new PerihelionValidationError("validation failed");
  assert.ok(e instanceof PerihelionError);
  assert.equal(e.field, undefined);
});

// ---------------------------------------------------------------------------
// PerihelionHashMismatchError
// ---------------------------------------------------------------------------

test("PerihelionHashMismatchError instanceof PerihelionError and Error", () => {
  const localHash = "0x" + "aa".repeat(32);
  const serverHash = "0x" + "bb".repeat(32);
  const e = new PerihelionHashMismatchError(localHash, serverHash);
  assert.ok(e instanceof Error);
  assert.ok(e instanceof PerihelionError);
  assert.ok(e instanceof PerihelionHashMismatchError);
  assert.equal(e.localHash, localHash);
  assert.equal(e.serverHash, serverHash);
  assert.equal(e.name, "PerihelionHashMismatchError");
  assert.ok(e.message.includes(localHash));
  assert.ok(e.message.includes(serverHash));
});

// ---------------------------------------------------------------------------
// IntentValidationError (#522)
// ---------------------------------------------------------------------------

test("IntentValidationError instanceof PerihelionValidationError, PerihelionError, and Error", () => {
  const e = new IntentValidationError("destination", "must be a valid Stellar strkey");
  assert.ok(e instanceof Error);
  assert.ok(e instanceof PerihelionError);
  assert.ok(e instanceof PerihelionValidationError);
  assert.ok(e instanceof IntentValidationError);
  assert.equal(e.field, "destination");
  assert.equal(e.message, "must be a valid Stellar strkey");
  assert.equal(e.name, "IntentValidationError");
});

test("IntentValidationError field is the first argument", () => {
  const e = new IntentValidationError("deadline", "must be in the future");
  assert.equal(e.field, "deadline");
  assert.equal(e.message, "must be in the future");
});

test("IntentValidationError can be caught as PerihelionError", () => {
  let caught: unknown;
  try {
    throw new IntentValidationError("user", "must be an EVM address");
  } catch (e) {
    caught = e;
  }
  assert.ok(caught instanceof PerihelionError, "should be catchable as PerihelionError");
  assert.ok(caught instanceof PerihelionValidationError, "should be catchable as PerihelionValidationError");
  assert.ok(caught instanceof IntentValidationError, "should be catchable as IntentValidationError");
});

// ---------------------------------------------------------------------------
// MempoolResponseError (#522)
// ---------------------------------------------------------------------------

test("MempoolResponseError instanceof PerihelionError and Error", () => {
  const e = new MempoolResponseError("missing field 'status'");
  assert.ok(e instanceof Error);
  assert.ok(e instanceof PerihelionError);
  assert.ok(e instanceof MempoolResponseError);
  assert.equal(e.name, "MempoolResponseError");
  assert.ok(e.message.includes("missing field 'status'"));
});

test("MempoolResponseError can be caught as PerihelionError", () => {
  let caught: unknown;
  try {
    throw new MempoolResponseError("invalid response shape");
  } catch (e) {
    caught = e;
  }
  assert.ok(caught instanceof PerihelionError, "should be catchable as PerihelionError");
  assert.ok(caught instanceof MempoolResponseError);
});

// ---------------------------------------------------------------------------
// Hierarchy completeness: every SDK error passes e instanceof PerihelionError
// ---------------------------------------------------------------------------

test("all SDK error types pass instanceof PerihelionError", () => {
  const errors: PerihelionError[] = [
    new PerihelionError("base"),
    new PerihelionHttpError("op", 400, "bad"),
    new PerihelionTimeoutError("timeout"),
    new PerihelionNetworkError("network"),
    new PerihelionValidationError("validation"),
    new PerihelionHashMismatchError("0x01", "0x02"),
    new IntentValidationError("field", "message"),
    new MempoolResponseError("mempool"),
  ];

  for (const e of errors) {
    assert.ok(
      e instanceof PerihelionError,
      `expected ${e.constructor.name} to be instanceof PerihelionError`,
    );
    assert.ok(
      e instanceof Error,
      `expected ${e.constructor.name} to be instanceof Error`,
    );
  }
});

// ---------------------------------------------------------------------------
// Error cause forwarding
// ---------------------------------------------------------------------------

test("PerihelionError forwards cause option", () => {
  const cause = new TypeError("original cause");
  const e = new PerihelionError("wrapped", { cause });
  assert.equal(e.cause, cause);
});

test("IntentValidationError forwards cause option", () => {
  const cause = new RangeError("out of range");
  const e = new IntentValidationError("deadline", "out of range", { cause });
  assert.equal(e.cause, cause);
});

test("MempoolResponseError forwards cause option", () => {
  const cause = new SyntaxError("bad json");
  const e = new MempoolResponseError("parse failure", { cause });
  assert.equal(e.cause, cause);
});
