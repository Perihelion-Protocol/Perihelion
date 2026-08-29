// SPDX-License-Identifier: MIT

/**
 * Runtime validation for `IntentRecord`/`SignedIntent` JSON received from the
 * mempool. A TypeScript `as` cast is compile-time only — the mempool is an
 * external service the SDK does not control, so its responses must be
 * validated at the boundary rather than trusted blindly.
 */

import { isAddress } from "viem";
import { isStellarAddress, isStellarAsset } from "./stellar.js";
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

const HEX_RE = /^0x[0-9a-fA-F]+$/;
const MEMPOOL_STATUSES: ReadonlySet<MempoolIntentStatus> = new Set([
  "pending",
  "settled",
  "refunded",
  "expired",
]);

function isHex(value: unknown): value is Hex {
  return typeof value === "string" && HEX_RE.test(value);
}

function isAddr(value: unknown): value is Address {
  return typeof value === "string" && isAddress(value);
}

function asObject(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new MempoolResponseError(`${what} must be an object (got ${JSON.stringify(value)})`);
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new MempoolResponseError(`'${field}' must be a string (got ${JSON.stringify(value)})`);
  }
  return value;
}

function asFiniteNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new MempoolResponseError(`'${field}' must be a finite number (got ${JSON.stringify(value)})`);
  }
  return value;
}

function asTimestampInSeconds(value: unknown, field: string): number {
  const n = asFiniteNumber(value, field);
  if (!Number.isInteger(n) || n < 0 || n >= 100_000_000_000) {
    throw new MempoolResponseError(
      `'${field}' must be a Unix timestamp in seconds (got ${JSON.stringify(value)})`,
    );
  }
  return n;
}

function asPositiveInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new MempoolResponseError(
      `'${field}' must be a positive integer (got ${JSON.stringify(value)})`,
    );
  }
  return value;
}

function asAddress(value: unknown, field: string): Address {
  if (!isAddr(value)) {
    throw new MempoolResponseError(`'${field}' must be a valid address (got ${JSON.stringify(value)})`);
  }
  return value;
}

function asHex(value: unknown, field: string): Hex {
  if (!isHex(value)) {
    throw new MempoolResponseError(`'${field}' must be a hex string (got ${JSON.stringify(value)})`);
  }
  return value;
}

function asStellarAddress(value: unknown, field: string): string {
  const s = asString(value, field);
  if (!isStellarAddress(s)) {
    throw new MempoolResponseError(
      `'${field}' must be a valid Stellar strkey (got ${JSON.stringify(s)})`
    );
  }
  return s;
}

function asStellarAsset(value: unknown, field: string): string {
  const s = asString(value, field);
  if (!isStellarAsset(s)) {
    throw new MempoolResponseError(
      `'${field}' must be a valid Stellar asset identifier (got ${JSON.stringify(s)})`
    );
  }
  return s;
}

function asIntegerString(value: unknown, field: string): string {
  const s = asString(value, field);
  if (!/^(?:0|[1-9][0-9]*)$/.test(s)) {
    throw new MempoolResponseError(
      `'${field}' must be a valid non-negative integer string (got ${JSON.stringify(s)})`
    );
  }
  return s;
}

/** Validate and narrow an unknown value into an {@link Intent}. */
export function parseIntent(value: unknown): Intent {
  const v = asObject(value, "'intent'");
  return {
    user: asAddress(v.user, "intent.user"),
    destination: asStellarAddress(v.destination, "intent.destination"),
    sourceChainId: asFiniteNumber(v.sourceChainId, "intent.sourceChainId"),
    sourceAsset: asAddress(v.sourceAsset, "intent.sourceAsset"),
    sourceAmount: asIntegerString(v.sourceAmount, "intent.sourceAmount"),
    destAsset: asStellarAsset(v.destAsset, "intent.destAsset"),
    minDestAmount: asIntegerString(v.minDestAmount, "intent.minDestAmount"),
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
    signature: asHex(v.signature, "signature"),
    hash: asHex(v.hash, "hash"),
  };
}

/** Validate and narrow an unknown value into an {@link IntentRecord}. */
export function parseIntentRecord(value: unknown): IntentRecord {
  const v = asObject(value, "intent record");
  const signed = parseSignedIntent(v);

  if (typeof v.status !== "string" || !MEMPOOL_STATUSES.has(v.status as MempoolIntentStatus)) {
    throw new MempoolResponseError(
      `'status' must be one of ${[...MEMPOOL_STATUSES].join(", ")} (got ${JSON.stringify(v.status)})`,
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

/** Validate and narrow an unknown value into an array of {@link IntentRecord}. */
export function parseIntentRecordArray(value: unknown): IntentRecord[] {
  if (!Array.isArray(value)) {
    throw new MempoolResponseError(`expected an array of intent records (got ${JSON.stringify(value)})`);
  }
  return value.map(parseIntentRecord);
}
