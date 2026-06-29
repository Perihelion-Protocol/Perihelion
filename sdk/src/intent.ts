/**
 * Intent construction, EIP-712 typing, hashing, and signature verification.
 *
 * The intent hash is the protocol's universal identifier: it is the commitment
 * the EVM escrow locks funds against, the message the LayerZero relayer carries,
 * and the value the Soroban settlement contract verifies before releasing funds.
 */

import {
  hashTypedData,
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

/**
 * Minimum economical intent size in USD. Below this threshold, the fixed LayerZero
 * messaging fee makes the intent unprofitable to fill. Override via {@link BuildOptions.minNotional}.
 * Default: $10 USD equivalent.
 */
export const DEFAULT_V_MIN = "10000000"; // 10 USD in 6-decimal units

/**
 * Maximum bridgeable amount: u128::MAX (2^128 − 1 = 340282366920938463463374607431768211455).
 *
 * This ceiling comes from the 16-byte big-endian wire field in `FillConfirmed` and
 * `FillInstruction` (architecture spec §3.3). A `uint256` source amount that exceeds
 * this value cannot be encoded in the wire format and will be rejected by the Soroban
 * decoder, which stores amounts as `i128` (signed 128-bit). Any amount in the range
 * (i128::MAX, u128::MAX] is valid on the wire but will overflow to a negative `i128`
 * on the Soroban side — the Soroban contract rejects `fill_amount <= 0` and
 * `min_dest_amount <= 0`, so the transaction fails safely rather than silently.
 *
 * To avoid that failure the SDK enforces the stricter i128::MAX ceiling for all
 * destination amounts (`minDestAmount`). Source amounts may reach u128::MAX because
 * the EVM escrow stores them as `uint256` and the wire field is never read by the
 * EVM side for release sizing (it releases `l.amount` — the measured-delta locked
 * amount). The safe ceiling for end-to-end round-tripping is i128::MAX.
 *
 * See docs/intent-spec.md §Amount Field Specification for the full boundary table.
 */
export const U128_MAX = 340282366920938463463374607431768211455n;
export const I128_MAX = 170141183460469231731687303715884105727n;

/**
 * Validate that a decimal-string amount is within the representable range for its
 * role in the protocol:
 * - `sourceAmount`: must be in [1, u128::MAX] (wire-safe for EVM uint256 encoding)
 * - `minDestAmount`: must be in [1, i128::MAX] (wire-safe for Soroban i128 storage)
 *
 * Throws a `RangeError` with a descriptive message on violation.
 *
 * @param value  Decimal string amount.
 * @param field  Field name for the error message.
 * @param max    Maximum allowed value (inclusive). Defaults to `I128_MAX`.
 */
export function validateAmount(value: string, field: string, max = I128_MAX): void {
  let n: bigint;
  try {
    n = BigInt(value);
  } catch {
    throw new RangeError(`[Perihelion] ${field} "${value}" is not a valid integer string`);
  }
  if (n <= 0n) {
    throw new RangeError(
      `[Perihelion] ${field} must be > 0 (got ${value})`
    );
  }
  if (n > max) {
    throw new RangeError(
      `[Perihelion] ${field} ${value} exceeds the maximum bridgeable amount ` +
        `(${max}). Values above this cannot be encoded in the 16-byte wire field ` +
        `or stored as i128 on Soroban.`
    );
  }
}

/** Options for {@link buildIntent}. */
export interface BuildOptions {
  /** Minimum notional (in source-asset smallest units) below which a warning is emitted. */
  vMin?: string;
  /** If true, suppress the warning even if below vMin. */
  suppressWarning?: boolean;
}

/**
 * Build a fully-formed {@link Intent}, filling in an open solver and a random
 * nonce when not provided. Emits a non-fatal warning if the intent's source amount
 * is below the economical threshold (V_min).
 */
export function buildIntent(params: IntentParams, options?: BuildOptions): Intent {
  const vMin = options?.vMin ?? DEFAULT_V_MIN;
  const suppressWarning = options?.suppressWarning ?? false;

  const intent: Intent = {
    ...params,
    preferredSolver: params.preferredSolver ?? zeroAddress,
    nonce: params.nonce ?? randomNonce(),
  };

  // Validate amount ranges before any further processing.
  // sourceAmount may reach u128::MAX (it is stored as uint256 on EVM and only encoded
  // in the informational wire field, not used to size the EVM release).
  // minDestAmount must fit in i128::MAX (Soroban stores it as i128 and rejects negatives).
  validateAmount(intent.sourceAmount, "sourceAmount", U128_MAX);
  validateAmount(intent.minDestAmount, "minDestAmount", I128_MAX);

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
 * This is the **intent nonce** — its sole purpose is collision prevention.
 * Two intents that are otherwise identical (same user, asset, amount, deadline)
 * will hash to different `intent_hash` values because their nonces differ.
 *
 * The intent nonce does NOT provide replay protection by itself. Replay
 * protection is the responsibility of:
 *   1. The LayerZero transport nonce (per-eid monotonic counter), enforced in
 *      `PerihelionEscrow.lzReceive` and `accept_nonce` in the Soroban contract.
 *   2. The `locks` mapping / `Settled` / `Cancelled` idempotency markers on
 *      each chain, which prevent the same intent from being locked, settled, or
 *      cancelled more than once.
 *
 * See docs/TECHNICAL-ARCHITECTURE.md §11 for the full anti-replay story.
 */
export function randomNonce(): string {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  return n.toString();
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
