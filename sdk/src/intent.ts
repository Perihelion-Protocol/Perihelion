// SPDX-License-Identifier: MIT

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
import { isStellarAddress, isStellarAsset } from "./stellar.js";
import { PerihelionValidationError } from "./errors.js";


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
 * Validate all fields of intent parameters, throwing {@link PerihelionValidationError}
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
    throw new PerihelionValidationError(`must be a valid 20-byte EVM address (got '${params.user}')`, "user");
  }
  if (!STRKEY_RE.test(params.destination)) {
    throw new PerihelionValidationError(
      `must be a valid Stellar strkey starting with G or C, 56 chars of A-Z/2-7 (got '${params.destination}')`,
      "destination",
    );
  }
  // Enforce byte-length bounds as defence-in-depth, independent of regex.
  // Bounds are measured in UTF-8 bytes, matching the contract's bytes(intent.destination).length.
  const destBytes = new TextEncoder().encode(params.destination).length;
  if (destBytes > MAX_DESTINATION_LEN) {
    throw new PerihelionValidationError(
      `exceeds ${MAX_DESTINATION_LEN} bytes (got ${destBytes} bytes)`, "destination",
    );
  }
  if (!Number.isInteger(params.sourceChainId) || params.sourceChainId <= 0) {
    throw new PerihelionValidationError(
      `must be a positive integer chain ID (got ${params.sourceChainId})`, "sourceChainId",
    );
  }
  if (!isAddress(params.sourceAsset)) {
    throw new PerihelionValidationError(
      `must be a valid 20-byte EVM address (got '${params.sourceAsset}')`, "sourceAsset",
    );
  }
  if (!isPositiveIntString(params.sourceAmount)) {
    throw new PerihelionValidationError(
      `must be a positive integer string with no leading zeros (got '${params.sourceAmount}')`, "sourceAmount",
    );
  }
  try {
    const sourceAmountBig = BigInt(params.sourceAmount);
    if (sourceAmountBig > U128_MAX) {
      throw new PerihelionValidationError(
        `exceeds maximum bridgeable amount (${U128_MAX})`, "sourceAmount",
      );
    }
  } catch (err) {
    if (err instanceof PerihelionValidationError) throw err;
    throw new PerihelionValidationError(`is not a valid integer string`, "sourceAmount");
  }
  if (!DEST_ASSET_RE.test(params.destAsset)) {
    throw new PerihelionValidationError(
      `must be 'native' or '<CODE>:<G...ISSUER>' (got '${params.destAsset}')`, "destAsset",
    );
  }
  // Enforce byte-length bound on destAsset as defence-in-depth, independent of regex.
  const destAssetBytes = new TextEncoder().encode(params.destAsset).length;
  if (destAssetBytes > MAX_DEST_ASSET_LEN) {
    throw new PerihelionValidationError(
      `exceeds ${MAX_DEST_ASSET_LEN} bytes (got ${destAssetBytes} bytes)`, "destAsset",
    );
  }
  if (!isPositiveIntString(params.minDestAmount)) {
    throw new PerihelionValidationError(
      `must be a positive integer string with no leading zeros (got '${params.minDestAmount}')`, "minDestAmount",
    );
  }
  try {
    const minDestAmountBig = BigInt(params.minDestAmount);
    if (minDestAmountBig > I128_MAX) {
      throw new PerihelionValidationError(
        `exceeds maximum bridgeable amount (${I128_MAX})`, "minDestAmount",
      );
    }
  } catch (err) {
    if (err instanceof PerihelionValidationError) throw err;
    throw new PerihelionValidationError(`is not a valid integer string`, "minDestAmount");
  }
  if (!Number.isInteger(params.deadline) || params.deadline <= now) {
    throw new PerihelionValidationError(
      `must be a Unix timestamp strictly in the future (got ${params.deadline}, now is ${now})`, "deadline",
    );
  }
  if (params.nonce !== undefined) {
    if (!isNonNegIntString(params.nonce)) {
      throw new PerihelionValidationError(
        `must be a non-negative decimal integer string (got '${params.nonce}')`, "nonce",
      );
    }
    if (BigInt(params.nonce) > (1n << 256n) - 1n) {
      throw new PerihelionValidationError(
        `exceeds uint256 maximum (got ${params.nonce})`, "nonce",
      );
    }
  }
  if (params.preferredSolver !== undefined && !isAddress(params.preferredSolver)) {
    throw new PerihelionValidationError(
      `must be a valid 20-byte EVM address or zero address (got '${params.preferredSolver}')`, "preferredSolver",
    );
  }
}

/**
 * Maximum byte length of `Intent.destination`. A Stellar strkey (G.../C...) is
 * exactly 56 characters. Matches `PerihelionEscrow.MAX_DESTINATION_LEN`.
 */
export const MAX_DESTINATION_LEN = 56;

/**
 * Maximum byte length of `Intent.destAsset`. The longest valid form is
 * `<CODE>:<ISSUER>` (12 + 1 + 56 = 69 bytes); `"native"` is 6 bytes.
 * Matches `PerihelionEscrow.MAX_DEST_ASSET_LEN`.
 */
export const MAX_DEST_ASSET_LEN = 69;

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
 * See docs/intent-spec.md and docs/assets.md for the full boundary and
 * per-asset decimal tables.
 */
export const U128_MAX = 340282366920938463463374607431768211455n;
export const I128_MAX = 170141183460469231731687303715884105727n;

/**
 * Validate that a decimal-string amount is within the representable range for its
 * role in the protocol:
 * - `sourceAmount`: must be in [1, u128::MAX] (wire-safe for EVM uint256 encoding)
 * - `minDestAmount`: must be in [1, i128::MAX] (wire-safe for Soroban i128 storage)
 *
 * Throws a {@link PerihelionValidationError} with a descriptive message on violation.
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
    throw new PerihelionValidationError(`is not a valid integer string`, field);
  }
  if (n <= 0n) {
    throw new PerihelionValidationError(`must be > 0 (got ${value})`, field);
  }
  if (n > max) {
    throw new PerihelionValidationError(
      `exceeds maximum bridgeable amount (${max})`, field
    );
  }
}

/** Options for {@link buildIntent}. */
export interface BuildOptions {
  /** Minimum notional (in source-asset smallest units) below which a warning is emitted. */
  vMin?: string;
  /** Decimal places of the source asset (e.g. 6 for USDC, 18 for WETH). Required to validate vMin. */
  sourceDecimals?: number;
  /** If true, suppress the warning even if below vMin. */
  suppressWarning?: boolean;
}

/**
 * Build a fully-formed {@link Intent}, filling in an open solver and a random
 * nonce when not provided. Validates all caller-supplied fields and throws
 * {@link PerihelionValidationError} if any are malformed. Emits a non-fatal warning
 * if the intent's source amount is below the economical threshold (V_min).
 */
export function buildIntent(params: IntentParams, options?: BuildOptions): Intent {
  validateIntent(params);

  const vMin = options?.vMin ?? DEFAULT_V_MIN;
  const suppressWarning = options?.suppressWarning ?? false;

  if (!isStellarAddress(params.destination)) {
    throw new PerihelionValidationError(
      `buildIntent: invalid destination "${params.destination}" — must be a G... or C... Stellar strkey`,
      "destination"
    );
  }
  if (!isStellarAsset(params.destAsset)) {
    throw new PerihelionValidationError(
      `buildIntent: invalid destAsset "${params.destAsset}" — must be "native" or "CODE:ISSUER"`,
      "destAsset"
    );
  }

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

  // Warn if below minimum economical size.
  // The vMin check requires knowing the source asset's decimal places to make
  // a meaningful comparison across different token precisions. Without sourceDecimals,
  // we skip the check to avoid spurious or missing warnings for mismatched decimals.
  if (!suppressWarning && options?.sourceDecimals !== undefined) {
    const vMinBig = BigInt(vMin);
    const sourceAmountBig = BigInt(intent.sourceAmount);
    if (sourceAmountBig < vMinBig) {
      console.warn(
      `[Perihelion] Intent source amount (${intent.sourceAmount}) is below the ` +
      `economical minimum V_min (${vMin}). The fixed LayerZero messaging fee may ` +
      `make this intent unprofitable to fill. Override via buildIntent(..., { vMin, suppressWarning }).`
      );
    }
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
 * Half of the secp256k1 curve order (n / 2). Per EIP-2, a canonical signature
 * must have `s <= n/2`; the high-s counterpart (n - s) recovers the same signer
 * and is therefore malleable. We reject it so each intent has exactly one valid
 * signature — otherwise replay/dedup keyed on the signature could be bypassed.
 */
const SECP256K1_HALF_N =
  0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;

/**
 * Recover the signer of an intent and check it matches `intent.user`.
 *
 * Rejects EIP-2 non-canonical (high-s) signatures to prevent malleability.
 * Malformed-length signatures fall through to `recoverTypedDataAddress`, which
 * rejects them.
 *
 * @param domain  Must be built with {@link perihelionDomain}.
 */
export async function verifyIntent(
  intent: Intent,
  signature: Hex,
  domain: TypedDataDomain,
): Promise<boolean> {
  // EIP-2 low-s enforcement for canonical 65-byte signatures
  // ("0x" + r[32] + s[32] + v[1] = 132 hex chars).
  if (signature.length === 132) {
    const s = BigInt(`0x${signature.slice(66, 130)}`);
    if (s > SECP256K1_HALF_N) return false;
  }

  const recovered = await recoverTypedDataAddress({
    domain,
    types: INTENT_TYPES,
    primaryType: "Intent",
    message: toMessage(intent),
    signature,
  });
  return recovered.toLowerCase() === intent.user.toLowerCase();
}

/**
 * True if the intent's deadline is considered expired.
 *
 * The check is: `deadline <= now - clockSkew`.
 *
 * @param now       Unix seconds to use as "current time" (defaults to `Date.now()/1000`).
 *                  Pass chain time here when available to avoid client-clock disagreements.
 * @param clockSkew Seconds subtracted from `now` before comparing.
 *                  - **Positive** (e.g. `+30`): acts as if the clock is 30 s slower — the
 *                    intent is considered expired only after `now` exceeds `deadline + skew`.
 *                    Use this in the **solver fill path** to avoid claiming an intent that
 *                    the chain will reject as just-expired.
 *                  - **Negative** (e.g. `-30`): acts as if the clock is 30 s faster — the
 *                    intent is considered expired once `now >= deadline - |skew|`.
 *                    Use this for **submission guards** to avoid sending something that
 *                    will land just after its deadline.
 *                  - Default: `0` (no adjustment). Recommended: `+30` for solver fills.
 */
export function isExpired(
  intent: Intent,
  now = Math.floor(Date.now() / 1000),
  clockSkew = 0,
): boolean {
  return intent.deadline <= now - clockSkew;
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
  return bytesToBigInt(bytes).toString();
}

/**
 * Coerce string amounts to bigint for viem's typed-data encoder.
 * This is the single source of truth for the EIP-712 message shape; used by
 * {@link hashIntent}, {@link verifyIntent}, and `PerihelionClient.signIntent`.
 */
export function toMessage(intent: Intent) {
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
