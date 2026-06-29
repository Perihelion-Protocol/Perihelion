/**
 * Runtime validation for `IntentRecord`/`SignedIntent` JSON received from the
 * mempool. A TypeScript `as` cast is compile-time only — the mempool is an
 * external service the SDK does not control, so its responses must be
 * validated at the boundary rather than trusted blindly.
 */

import { isAddress } from "viem";
import type {
  Address,
  Hex,
  Intent,
  IntentRecord,
  IntentStatus,
  SignedIntent,
} from "./types.js";

/** Thrown when a mempool response does not conform to the expected shape. */
export class MempoolResponseError extends Error {
  constructor(message: string) {
    super(`[Perihelion] invalid mempool response: ${message}`);
    this.name = "MempoolResponseError";
  }
}

const HEX_RE = /^0x[0-9a-fA-F]+$/;
const INTENT_STATUSES: ReadonlySet<IntentStatus> = new Set([
  "pending",
  "claimed",
  "settling",
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

/** Validate and narrow an unknown value into an {@link Intent}. */
export function parseIntent(value: unknown): Intent {
  const v = asObject(value, "'intent'");
  return {
    user: asAddress(v.user, "intent.user"),
    destination: asString(v.destination, "intent.destination"),
    sourceChainId: asFiniteNumber(v.sourceChainId, "intent.sourceChainId"),
    sourceAsset: asAddress(v.sourceAsset, "intent.sourceAsset"),
    sourceAmount: asString(v.sourceAmount, "intent.sourceAmount"),
    destAsset: asString(v.destAsset, "intent.destAsset"),
    minDestAmount: asString(v.minDestAmount, "intent.minDestAmount"),
    deadline: asFiniteNumber(v.deadline, "intent.deadline"),
    nonce: asString(v.nonce, "intent.nonce"),
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

  if (typeof v.status !== "string" || !INTENT_STATUSES.has(v.status as IntentStatus)) {
    throw new MempoolResponseError(
      `'status' must be one of ${[...INTENT_STATUSES].join(", ")} (got ${JSON.stringify(v.status)})`,
    );
  }
  if (v.solver !== undefined) asAddress(v.solver, "solver");
  if (v.settlementTx !== undefined) asString(v.settlementTx, "settlementTx");

  return {
    ...signed,
    status: v.status as IntentStatus,
    solver: v.solver as Address | undefined,
    settlementTx: v.settlementTx as string | undefined,
    createdAt: asFiniteNumber(v.createdAt, "createdAt"),
  };
}

/** Validate and narrow an unknown value into an array of {@link IntentRecord}. */
export function parseIntentRecordArray(value: unknown): IntentRecord[] {
  if (!Array.isArray(value)) {
    throw new MempoolResponseError(`expected an array of intent records (got ${JSON.stringify(value)})`);
  }
  return value.map(parseIntentRecord);
}
