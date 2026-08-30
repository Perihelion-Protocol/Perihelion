// SPDX-License-Identifier: MIT

/**
 * Runtime validation for `IntentRecord`/`SignedIntent` JSON received from the
 * mempool. A TypeScript `as` cast is compile-time only — the mempool is an
 * external service the SDK does not control, so its responses must be
 * validated at the boundary rather than trusted blindly.
 */

import { isAddress } from "viem";
import { isStellarAddress, isStellarAsset } from "./stellar.js";
import { isPositiveIntString } from "./intent.js";
import { PerihelionError } from "./errors.js";
import type {
  Address,
  Hex,
  Intent,
  IntentRecord,
  IntentStatus,
  MempoolIntentStatus,
  SignedIntent,
} from "./types.js";

/** Thrown when a mempool response does not conform to the expected shape. */
export class MempoolResponseError extends PerihelionError {
  constructor(message: string, options?: ErrorOptions) {
    super(`[Perihelion] invalid mempool response: ${message}`, options);
    this.name = "MempoolResponseError";
  }
}

/**
 * Thrown by {@link parseIntentRecordArray} when the input array exceeds the
 * configured `maxLimit`. Kept as a distinct, narrowly-catchable subclass of
 * {@link MempoolResponseError} so callers can tell "too many records" apart
 * from an ordinary shape-validation failure (issue #532).
 */
export class MempoolResponseTooLargeError extends MempoolResponseError {
  readonly length: number;
  readonly maxLimit: number;
  constructor(length: number, maxLimit: number, options?: ErrorOptions) {
    super(
      `expected an array of intent records with at most ${maxLimit} entries (got ${length})`,
      options,
    );
    this.name = "MempoolResponseTooLargeError";
    this.length = length;
    this.maxLimit = maxLimit;
  }
}

/**
 * A 32-byte `0x`-prefixed hash: exactly 66 characters (`0x` + 64 hex digits).
 * Rejects the short/long/odd-length hex strings that the previous general
 * `/^0x[0-9a-fA-F]+$/` pattern let through (issue #530).
 */
const HASH_RE = /^0x[0-9a-fA-F]{64}$/;

/**
 * A canonical 65-byte `(r, s, v)` `0x`-prefixed signature: exactly 132
 * characters (`0x` + 130 hex digits). See {@link HASH_RE} (issue #530).
 */
const SIGNATURE_RE = /^0x[0-9a-fA-F]{130}$/;

const MEMPOOL_STATUSES: ReadonlySet<MempoolIntentStatus> = new Set([
  "pending",
  "settled",
  "refunded",
  "expired",
]);

/** Max length of a serialized value embedded in an error message. */
const MAX_ERROR_VALUE_LEN = 200;

/**
 * Safely render `value` for inclusion in an error message, truncating the
 * serialized form so a single oversized/malicious mempool response can't
 * blow up an error message (issue #532).
 */
function describe(value: unknown): string {
  let s: string;
  try {
    s = JSON.stringify(value) ?? String(value);
  } catch {
    s = String(value);
  }
  return s.length > MAX_ERROR_VALUE_LEN
    ? `${s.slice(0, MAX_ERROR_VALUE_LEN)}… (truncated, ${s.length} chars total)`
    : s;
}

function isAddr(value: unknown): value is Address {
  return typeof value === "string" && isAddress(value);
}

function asObject(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new MempoolResponseError(`${what} must be an object (got ${describe(value)})`);
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new MempoolResponseError(`'${field}' must be a string (got ${describe(value)})`);
  }
  return value;
}

function asFiniteNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new MempoolResponseError(`'${field}' must be a finite number (got ${describe(value)})`);
  }
  return value;
}

function asTimestampInSeconds(value: unknown, field: string): number {
  const n = asFiniteNumber(value, field);
  if (!Number.isInteger(n) || n < 0 || n >= 100_000_000_000) {
    throw new MempoolResponseError(
      `'${field}' must be a Unix timestamp in seconds (got ${describe(value)})`,
    );
  }
  return n;
}

function asPositiveInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new MempoolResponseError(
      `'${field}' must be a positive integer (got ${describe(value)})`,
    );
  }
  return value;
}

function asAddress(value: unknown, field: string): Address {
  if (!isAddr(value)) {
    throw new MempoolResponseError(`'${field}' must be a valid address (got ${describe(value)})`);
  }
  return value;
}

function isHash(value: unknown): value is Hex {
  return typeof value === "string" && HASH_RE.test(value);
}

function isSignature(value: unknown): value is Hex {
  return typeof value === "string" && SIGNATURE_RE.test(value);
}

/** Validate a 32-byte hash: exactly `0x` + 64 hex chars (issue #530). */
function asHash(value: unknown, field: string): Hex {
  if (!isHash(value)) {
    throw new MempoolResponseError(
      `'${field}' must be a 0x-prefixed 32-byte hex string (66 chars, got ${describe(value)})`,
    );
  }
  return value;
}

/** Validate a canonical 65-byte signature: exactly `0x` + 130 hex chars (issue #530). */
function asSignature(value: unknown, field: string): Hex {
  if (!isSignature(value)) {
    throw new MempoolResponseError(
      `'${field}' must be a 0x-prefixed 65-byte (r,s,v) signature (132 chars, got ${describe(value)})`,
    );
  }
  return value;
}

function asStellarAddress(value: unknown, field: string): string {
  const s = asString(value, field);
  if (!isStellarAddress(s)) {
    throw new MempoolResponseError(
      `'${field}' must be a valid Stellar strkey (got ${describe(s)})`
    );
  }
  return s;
}

function asStellarAsset(value: unknown, field: string): string {
  const s = asString(value, field);
  if (!isStellarAsset(s)) {
    throw new MempoolResponseError(
      `'${field}' must be a valid Stellar asset identifier (got ${describe(s)})`
    );
  }
  return s;
}

function asIntegerString(value: unknown, field: string): string {
  const s = asString(value, field);
  if (!/^(?:0|[1-9][0-9]*)$/.test(s)) {
    throw new MempoolResponseError(
      `'${field}' must be a valid non-negative integer string (got ${describe(s)})`
    );
  }
  return s;
}

/**
 * Strictly-positive integer string (no `"0"`, no leading zeros, no sign).
 * Reuses {@link isPositiveIntString} from `intent.ts` so `parseIntent` and
 * `validateIntent` agree on the exact same amount grammar (issue #531).
 */
function asPositiveIntegerString(value: unknown, field: string): string {
  const s = asString(value, field);
  if (!isPositiveIntString(s)) {
    throw new MempoolResponseError(
      `'${field}' must be a strictly positive integer string with no leading zeros (got ${describe(s)})`
    );
  }
  return s;
}

/**
 * Validate and narrow an unknown value into an {@link Intent}.
 *
 * `sourceChainId` and the two amount fields use the exact same constraints as
 * {@link validateIntent} — positive integer chain ID, strictly positive
 * integer amount strings — so a record round-tripped through the mempool and
 * a locally-built intent are held to identical rules (issue #531).
 */
export function parseIntent(value: unknown): Intent {
  const v = asObject(value, "'intent'");
  return {
    user: asAddress(v.user, "intent.user"),
    destination: asStellarAddress(v.destination, "intent.destination"),
    sourceChainId: asPositiveInteger(v.sourceChainId, "intent.sourceChainId"),
    sourceAsset: asAddress(v.sourceAsset, "intent.sourceAsset"),
    sourceAmount: asPositiveIntegerString(v.sourceAmount, "intent.sourceAmount"),
    destAsset: asStellarAsset(v.destAsset, "intent.destAsset"),
    minDestAmount: asPositiveIntegerString(v.minDestAmount, "intent.minDestAmount"),
    deadline: asPositiveInteger(v.deadline, "intent.deadline"),
    nonce: asIntegerString(v.nonce, "intent.nonce"),
    preferredSolver: asAddress(v.preferredSolver, "intent.preferredSolver"),
  };
}

/** Validate and narrow an unknown value into a {@link SignedIntent}. */
export function parseSignedIntent(value: unknown): SignedIntent {
  const v = asObject(value, "signed intent");
  return {
    intent: parseIntent(v.intent),
    signature: asSignature(v.signature, "signature"),
    hash: asHash(v.hash, "hash"),
  };
}

/** Validate and narrow an unknown value into an {@link IntentRecord}. */
export function parseIntentRecord(value: unknown): IntentRecord {
  const v = asObject(value, "intent record");
  const signed = parseSignedIntent(v);

  if (typeof v.status !== "string" || !MEMPOOL_STATUSES.has(v.status as MempoolIntentStatus)) {
    throw new MempoolResponseError(
      `'status' must be one of ${[...MEMPOOL_STATUSES].join(", ")} (got ${describe(v.status)})`,
    );
  }
  if (v.solver !== undefined) asAddress(v.solver, "solver");
  if (v.settlementTx !== undefined) asString(v.settlementTx, "settlementTx");

  return {
    ...signed,
    status: v.status as IntentStatus,
    solver: v.solver as Address | undefined,
    settlementTx: v.settlementTx as string | undefined,
    createdAt: asTimestampInSeconds(v.createdAt, "createdAt"),
  };
}

/** Default cap on the number of records {@link parseIntentRecordArray} will process in one call. */
const DEFAULT_MAX_INTENT_RECORDS = 5000;

/**
 * Validate and narrow an unknown value into an array of {@link IntentRecord}.
 *
 * @param maxLimit Upper bound on `value.length`. A misbehaving or malicious
 *                 mempool server returning an arbitrarily large array would
 *                 otherwise force this synchronous `.map` to walk the whole
 *                 thing and stall the event loop; exceeding the bound throws
 *                 {@link MempoolResponseTooLargeError} instead. Defaults to
 *                 {@link DEFAULT_MAX_INTENT_RECORDS} (issue #532).
 */
export function parseIntentRecordArray(
  value: unknown,
  maxLimit: number = DEFAULT_MAX_INTENT_RECORDS,
): IntentRecord[] {
  if (!Array.isArray(value)) {
    throw new MempoolResponseError(`expected an array of intent records (got ${describe(value)})`);
  }
  if (value.length > maxLimit) {
    throw new MempoolResponseTooLargeError(value.length, maxLimit);
  }
  return value.map(parseIntentRecord);
}
