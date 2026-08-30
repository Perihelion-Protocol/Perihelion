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
import { IntentValidationError, PerihelionValidationError } from "./errors.js";


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
 * Strictly-positive decimal integer string: no `"0"`, no leading zeros, no
 * sign. Exported so `validate.ts`'s `parseIntent` can enforce the exact same
 * amount grammar as {@link validateIntent} (issue #531).
 */
export function isPositiveIntString(s: string): boolean {
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
    throw new IntentValidationError("user", `must be a valid 20-byte EVM address (got '${params.user}')`);
  }
  if (!isStellarAddress(params.destination)) {
    throw new IntentValidationError(
      "destination",
      `must be a valid Stellar strkey starting with G or C, 56 chars of A-Z/2-7, with a valid checksum (got '${params.destination}')`,
    );
  }
  // Enforce byte-length bounds as defence-in-depth, independent of isStellarAddress.
  // Bounds are measured in UTF-8 bytes, matching the contract's bytes(intent.destination).length.
  const destBytes = new TextEncoder().encode(params.destination).length;
  if (destBytes > MAX_DESTINATION_LEN) {
    throw new IntentValidationError(
      "destination",
      `exceeds ${MAX_DESTINATION_LEN} bytes (got ${destBytes} bytes)`,
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
  try {
    const sourceAmountBig = BigInt(params.sourceAmount);
    if (sourceAmountBig > U128_MAX) {
      throw new IntentValidationError(
        "sourceAmount",
        `exceeds maximum bridgeable amount (${U128_MAX})`,
      );
    }
  } catch (err) {
    if (err instanceof PerihelionValidationError) throw err;
    throw new IntentValidationError("sourceAmount", `is not a valid integer string`);
  }
  if (!isStellarAsset(params.destAsset)) {
    throw new PerihelionValidationError(
      `must be 'native' or '<CODE>:<G...ISSUER>' with a valid issuer checksum (got '${params.destAsset}')`, "destAsset",
    );
  }
  // Enforce byte-length bound on destAsset as defence-in-depth, independent of isStellarAsset.
  const destAssetBytes = new TextEncoder().encode(params.destAsset).length;
  if (destAssetBytes > MAX_DEST_ASSET_LEN) {
    throw new IntentValidationError(
      "destAsset",
      `exceeds ${MAX_DEST_ASSET_LEN} bytes (got ${destAssetBytes} bytes)`,
    );
  }
  if (!isPositiveIntString(params.minDestAmount)) {
    throw new IntentValidationError(
      "minDestAmount",
      `must be a positive integer string with no leading zeros (got '${params.minDestAmount}')`,
    );
  }
  try {
    const minDestAmountBig = BigInt(params.minDestAmount);
    if (minDestAmountBig > I128_MAX) {
      throw new IntentValidationError(
        "minDestAmount",
        `exceeds maximum bridgeable amount (${I128_MAX})`,
      );
    }
  } catch (err) {
    if (err instanceof PerihelionValidationError) throw err;
    throw new IntentValidationError("minDestAmount", `is not a valid integer string`);
  }
  if (!Number.isInteger(params.deadline) || params.deadline <= now) {
    throw new IntentValidationError(
      "deadline",
      `must be a Unix timestamp strictly in the future (got ${params.deadline}, now is ${now})`,
    );
  }
  if (params.deadline > now + MAX_DEADLINE_HORIZON_SEC) {
    throw new IntentValidationError(
      "deadline",
      `must be at most ${MAX_DEADLINE_HORIZON_SEC}s in the future (= 7 days); ` +
        `got ${params.deadline}, now is ${now}; the Soroban settlement contract ` +
        `rejects FillInstructions with a deadline further out than this`,
    );
  }
  if (params.nonce !== undefined) {
    if (!isNonNegIntString(params.nonce)) {
      throw new IntentValidationError(
        "nonce",
        `must be a non-negative decimal integer string (got '${params.nonce}')`,
      );
    }
    if (BigInt(params.nonce) > (1n << 256n) - 1n) {
      throw new IntentValidationError(
        "nonce",
        `exceeds uint256 maximum (got ${params.nonce})`,
      );
    }
  }
  if (params.preferredSolver !== undefined && !isAddress(params.preferredSolver)) {
    throw new IntentValidationError(
      "preferredSolver",
      `must be a valid 20-byte EVM address or zero address (got '${params.preferredSolver}')`,
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
 * Maximum deadline horizon, in seconds from the current time, accepted for
 * `Intent.deadline`. Matches `settlement::MAX_DEADLINE_HORIZON` on the Soroban
 * side: a `FillInstruction` carrying a deadline further out than this is
 * rejected there to prevent trivially pinning an entry at MAX_TTL with a
 * far-future deadline. Enforcing the same ceiling here, before the intent is
 * ever signed or submitted to the EVM escrow, avoids a stuck state where
 * funds are locked and the LayerZero fee paid for an intent that the
 * destination chain will never register.
 * 7 days = 604_800 s.
 */
export const MAX_DEADLINE_HORIZON = 604_800;

/**
 * Alias for {@link MAX_DEADLINE_HORIZON}. Exported under the `_SEC` suffix so
 * it is unambiguous at call sites and consistent with the issue #523
 * requirement for an explicit unit suffix in the public API.
 */
export const MAX_DEADLINE_HORIZON_SEC = MAX_DEADLINE_HORIZON;

/**
 * Minimum economical intent size in USD. Below this threshold, the fixed LayerZero
 * messaging fee makes the intent unprofitable to fill. Override via {@link BuildOptions.vMin}.
 * Denominated in a fixed 6-decimal basis (1_000_000 = $1), independent of the
 * source asset's own decimal precision — see {@link BuildOptions.vMin} for how
 * this is reconciled with `sourceAmount` when the two differ.
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
  /**
   * Minimum notional below which a warning is emitted, denominated in a fixed
   * 6-decimal basis (1_000_000 = $1 USD-equivalent) — the same basis as
   * {@link DEFAULT_V_MIN} — regardless of the source asset's own decimal
   * precision. `buildIntent` normalizes `sourceAmount` (which is denominated in
   * `sourceDecimals`) into this 6-decimal basis before comparing, so a `vMin`
   * of `"10000000"` always means "$10" whether the source asset has 6, 7, or 18
   * decimals. Defaults to {@link DEFAULT_V_MIN}.
   */
  vMin?: string;
  /**
   * Decimal places of the source asset (e.g. 6 for USDC, 18 for WETH), used to
   * normalize `sourceAmount` onto `vMin`'s 6-decimal basis. Defaults to 6
   * (i.e. `sourceAmount` is assumed to already be in `vMin`'s basis) when omitted.
   */
  sourceDecimals?: number;
  /** If true, suppress the warning even if below vMin. */
  suppressWarning?: boolean;
}

/**
 * Build a fully-formed {@link Intent}, filling in an open solver and a random
 * nonce when not provided. Validates all caller-supplied fields and throws
 * {@link PerihelionValidationError} if any are malformed. Emits a non-fatal warning
 * if the intent's source amount is below the economical threshold (V_min).
 *
 * **V_min warning behavior:**
 * - `sourceAmount` (denominated in `sourceDecimals`) is normalized onto `vMin`'s
 *   fixed 6-decimal basis before comparing, so economically equivalent amounts
 *   warn identically regardless of the source asset's decimal precision — see
 *   {@link BuildOptions.vMin}.
 * - The warning is emitted when the normalized `sourceAmount < vMin` and
 *   `suppressWarning` is false. The boundary is exclusive: `sourceAmount === vMin`
 *   does not warn.
 * - If `sourceDecimals` is omitted, `sourceAmount` is assumed to already be in
 *   `vMin`'s 6-decimal basis (matching {@link DEFAULT_V_MIN}'s own assumption),
 *   and the warning includes a note to that effect.
 *
 * @param params  Intent parameters (user, destination, amounts, etc.)
 * @param options Build options: `vMin` (minimum notional, see {@link BuildOptions.vMin}),
 *                `sourceDecimals` (asset precision, see {@link BuildOptions.sourceDecimals}),
 *                and `suppressWarning` (skip the V_min check)
 * @throws {@link PerihelionValidationError} if any field is malformed
 * @returns A fully-formed Intent with nonce and preferredSolver filled in
 */
export function buildIntent(params: IntentParams, options?: BuildOptions): Intent {
  validateIntent(params);

  const vMin = options?.vMin ?? DEFAULT_V_MIN;
  const suppressWarning = options?.suppressWarning ?? false;

  // destination/destAsset checksum and shape validation is performed above by
  // validateIntent(params) (via isStellarAddress/isStellarAsset), so no need
  // to repeat it here — see #526.

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
  // vMin is denominated in a fixed 6-decimal basis (see BuildOptions.vMin / DEFAULT_V_MIN),
  // while sourceAmount is denominated in sourceDecimals units (e.g. wei for 18dp WETH,
  // stroops for 7dp XLM). Comparing the two raw values directly would over- or under-warn
  // for any asset whose decimals differ from 6 (#527) — e.g. a tiny-but-nonzero WETH amount
  // has a huge raw wei value that would never trip a raw comparison against vMin. Instead,
  // cross-multiply so both sides are compared on a common (sourceDecimals + 6)-scale without
  // any rounding loss:
  //   sourceAmount / 10^sourceDecimals  <  vMin / 10^6
  //   sourceAmount * 10^6               <  vMin * 10^sourceDecimals
  if (!suppressWarning) {
    const vMinBig = BigInt(vMin);
    const sourceAmountBig = BigInt(intent.sourceAmount);
    const sourceDecimals = options?.sourceDecimals ?? 6;
    const lhs = sourceAmountBig * 10n ** 6n;
    const rhs = vMinBig * 10n ** BigInt(sourceDecimals);
    if (lhs < rhs) {
      const decimalNote = options?.sourceDecimals === undefined
        ? " (sourceDecimals not provided; assuming default 6-decimal precision)"
        : ` (normalized from ${sourceDecimals}-decimal source units)`;
      console.warn(
        `[Perihelion] Intent source amount (${intent.sourceAmount}) is below the ` +
        `economical minimum V_min (${vMin})${decimalNote}. The fixed LayerZero messaging fee may ` +
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
 * Matches `PerihelionEscrow._verify` exactly: only a canonical 65-byte
 * `r ‖ s ‖ v` signature is accepted.
 * - **64-byte EIP-2098 "compact" signatures are rejected outright.** viem's
 *   recovery path accepts them, but the on-chain verifier does not (it checks
 *   `signature.length != 65` before touching `r`/`s`/`v`), so accepting them
 *   here would let a signature the contract would refuse pass SDK-side checks —
 *   and, worse, a compact re-encoding of an already-valid 65-byte signature
 *   recovers to the *same* signer, giving each signed intent a second valid
 *   byte-string (malleability) purely from the encoding choice.
 * - Any length other than 65 bytes is rejected immediately.
 * - The EIP-2 low-s check is applied unconditionally to the one accepted
 *   length, rejecting the high-s (`s > n/2`) malleable counterpart of every
 *   signature.
 *
 * @param domain  Must be built with {@link perihelionDomain}.
 */
export async function verifyIntent(
  intent: Intent,
  signature: Hex,
  domain: TypedDataDomain,
): Promise<boolean> {
  // Strictly require a canonical 65-byte (r, s, v) signature:
  // "0x" + r[32] + s[32] + v[1] = 132 hex chars. This rejects 64-byte EIP-2098
  // compact signatures outright, matching PerihelionEscrow._verify's
  // `signature.length != 65` guard.
  if (signature.length !== 132) return false;

  // EIP-2 low-s enforcement, unconditional for the one accepted length.
  const s = BigInt(`0x${signature.slice(66, 130)}`);
  if (s > SECP256K1_HALF_N) return false;

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
