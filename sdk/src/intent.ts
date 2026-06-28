/**
 * Intent construction, EIP-712 typing, hashing, and signature verification.
 *
 * The intent hash is the protocol's universal identifier: it is the commitment
 * the EVM escrow locks funds against, the message the LayerZero relayer carries,
 * and the value the Soroban settlement contract verifies before releasing funds.
 */

import {
  bytesToBigInt,
  hashTypedData,
  isAddress,
  recoverTypedDataAddress,
  zeroAddress,
  type TypedDataDomain,
} from "viem";
import type { Address, Hex, Intent } from "./types.js";

/**
 * Build the EIP-712 domain for a specific Perihelion escrow deployment.
 *
 * Both `chainId` and `verifyingContract` are required: the on-chain domain
 * separator includes them (EIP-712 §4), so omitting either would cause
 * signature mismatches — and, more critically, would allow cross-chain or
 * cross-contract signature replay (Perihelion security issue #34).
 *
 * @param chainId          Chain ID of the EVM network the escrow is deployed on.
 * @param verifyingContract Address of the PerihelionEscrow contract.
 */
export function perihelionDomain(chainId: number, verifyingContract: Address): TypedDataDomain {
  return { name: "Perihelion", version: "1", chainId, verifyingContract };
}

/** EIP-712 type definition for an {@link Intent}. */
export const INTENT_TYPES = {
  Intent: [
    { name: "user", type: "address" },
    { name: "destination", type: "string" },
    { name: "sourceChainId", type: "uint256" },
    { name: "sourceAsset", type: "address" },
    { name: "sourceAmount", type: "uint256" },
    { name: "destAsset", type: "string" },
    { name: "minDestAmount", type: "uint256" },
    { name: "deadline", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "preferredSolver", type: "address" },
  ],
} as const;

/** Fields a caller must supply; the rest are defaulted by {@link buildIntent}. */
export type IntentParams = Omit<Intent, "nonce" | "preferredSolver"> &
  Partial<Pick<Intent, "nonce" | "preferredSolver">>;

/** Thrown by {@link validateIntent} and {@link buildIntent} when a field is malformed. */
export class IntentValidationError extends Error {
  readonly field: string;
  constructor(field: string, message: string) {
    super(`[Perihelion] Invalid '${field}': ${message}`);
    this.name = "IntentValidationError";
    this.field = field;
  }
}

// Stellar strkey: G (account) or C (contract), followed by 55 base32 chars (A-Z, 2-7).
const STRKEY_RE = /^[GC][A-Z2-7]{55}$/;

// destAsset: "native" (XLM) or "<CODE>:<ISSUER>" where issuer is a G... account strkey.
const DEST_ASSET_RE = /^(?:native|[A-Z0-9]{1,12}:G[A-Z2-7]{55})$/;

function isPositiveIntString(s: string): boolean {
  return /^[1-9][0-9]*$/.test(s);
}

function isNonNegIntString(s: string): boolean {
  return /^(?:0|[1-9][0-9]*)$/.test(s);
}

/**
 * Validate all fields of intent parameters, throwing {@link IntentValidationError}
 * on the first failure. Called automatically by {@link buildIntent}; can also be
 * called independently before signing.
 *
 * @param params - Intent parameters to validate.
 * @param now    - Current Unix timestamp in seconds (defaults to `Date.now()`).
 */
export function validateIntent(
  params: IntentParams,
  now = Math.floor(Date.now() / 1000),
): void {
  if (!isAddress(params.user)) {
    throw new IntentValidationError("user", `must be a valid 20-byte EVM address (got '${params.user}')`);
  }
  if (!STRKEY_RE.test(params.destination)) {
    throw new IntentValidationError(
      "destination",
      `must be a valid Stellar strkey starting with G or C, 56 chars of A-Z/2-7 (got '${params.destination}')`,
    );
  }
  if (!Number.isInteger(params.sourceChainId) || params.sourceChainId <= 0) {
    throw new IntentValidationError(
      "sourceChainId",
      `must be a positive integer chain ID (got ${params.sourceChainId})`,
    );
  }
  if (!isAddress(params.sourceAsset)) {
    throw new IntentValidationError(
      "sourceAsset",
      `must be a valid 20-byte EVM address (got '${params.sourceAsset}')`,
    );
  }
  if (!isPositiveIntString(params.sourceAmount)) {
    throw new IntentValidationError(
      "sourceAmount",
      `must be a positive integer string with no leading zeros (got '${params.sourceAmount}')`,
    );
  }
  if (!DEST_ASSET_RE.test(params.destAsset)) {
    throw new IntentValidationError(
      "destAsset",
      `must be 'native' or '<CODE>:<G...ISSUER>' (got '${params.destAsset}')`,
    );
  }
  if (!isNonNegIntString(params.minDestAmount)) {
    throw new IntentValidationError(
      "minDestAmount",
      `must be a non-negative integer string with no leading zeros (got '${params.minDestAmount}')`,
    );
  }
  if (!Number.isInteger(params.deadline) || params.deadline <= now) {
    throw new IntentValidationError(
      "deadline",
      `must be a Unix timestamp strictly in the future (got ${params.deadline}, now is ${now})`,
    );
  }
}

/**
 * Minimum economical intent size in USD. Below this threshold, the fixed LayerZero
 * messaging fee makes the intent unprofitable to fill. Override via {@link BuildOptions.minNotional}.
 * Default: $10 USD equivalent.
 */
export const DEFAULT_V_MIN = "10000000"; // 10 USD in 6-decimal units

/** Options for {@link buildIntent}. */
export interface BuildOptions {
  /** Minimum notional (in source-asset smallest units) below which a warning is emitted. */
  vMin?: string;
  /** If true, suppress the warning even if below vMin. */
  suppressWarning?: boolean;
}

/**
 * Build a fully-formed {@link Intent}, filling in an open solver and a random
 * nonce when not provided. Validates all caller-supplied fields and throws
 * {@link IntentValidationError} if any are malformed. Emits a non-fatal warning
 * if the intent's source amount is below the economical threshold (V_min).
 */
export function buildIntent(params: IntentParams, options?: BuildOptions): Intent {
  validateIntent(params);

  const vMin = options?.vMin ?? DEFAULT_V_MIN;
  const suppressWarning = options?.suppressWarning ?? false;

  const intent: Intent = {
    ...params,
    preferredSolver: params.preferredSolver ?? zeroAddress,
    nonce: params.nonce ?? randomNonce(),
  };

  // Warn if below minimum economical size
  if (!suppressWarning && BigInt(intent.sourceAmount) < BigInt(vMin)) {
    console.warn(
      `[Perihelion] Intent source amount (${intent.sourceAmount}) is below the ` +
        `economical minimum V_min (${vMin}). The fixed LayerZero messaging fee may ` +
        `make this intent unprofitable to fill. Override via buildIntent(..., { vMin, suppressWarning }).`
    );
  }

  return intent;
}

/**
 * Compute the EIP-712 hash that uniquely identifies an intent.
 *
 * @param domain  Must be built with {@link perihelionDomain} — i.e. it must
 *                include `chainId` and `verifyingContract` so the hash is
 *                bound to a specific chain and escrow deployment.
 */
export function hashIntent(intent: Intent, domain: TypedDataDomain): Hex {
  return hashTypedData({
    domain,
    types: INTENT_TYPES,
    primaryType: "Intent",
    message: toMessage(intent),
  });
}

/**
 * Recover the signer of an intent and check it matches `intent.user`.
 *
 * @param domain  Must be built with {@link perihelionDomain}.
 */
export async function verifyIntent(
  intent: Intent,
  signature: Hex,
  domain: TypedDataDomain,
): Promise<boolean> {
  const recovered = await recoverTypedDataAddress({
    domain,
    types: INTENT_TYPES,
    primaryType: "Intent",
    message: toMessage(intent),
    signature,
  });
  return recovered.toLowerCase() === intent.user.toLowerCase();
}

/** True if the intent's deadline is in the past relative to `now` (unix seconds). */
export function isExpired(intent: Intent, now = Math.floor(Date.now() / 1000)): boolean {
  return intent.deadline <= now;
}

/**
 * Generate a 256-bit random nonce as a decimal string.
 *
 * Returns a value in [0, 2^256) suitable for use as a uint256 nonce in
 * EIP-712 typed data. The decimal string form round-trips through BigInt
 * without loss: `BigInt(randomNonce())` is always stable.
 */
export function randomNonce(): string {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return bytesToBigInt(bytes).toString();
}

/** Coerce string amounts to bigint for viem's typed-data encoder. */
function toMessage(intent: Intent) {
  return {
    user: intent.user,
    destination: intent.destination,
    sourceChainId: BigInt(intent.sourceChainId),
    sourceAsset: intent.sourceAsset,
    sourceAmount: BigInt(intent.sourceAmount),
    destAsset: intent.destAsset,
    minDestAmount: BigInt(intent.minDestAmount),
    deadline: BigInt(intent.deadline),
    nonce: BigInt(intent.nonce),
    preferredSolver: intent.preferredSolver as Address,
  };
}
