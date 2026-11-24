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
  type Hex as ViemHex,
  type PublicClient,
  type TypedDataDomain,
} from "viem";
import { verifyTypedData } from "viem/actions";
import type { Address, Hex, Intent } from "./types.js";
import {
  MAX_DEADLINE_HORIZON,
  MAX_DEADLINE_HORIZON_SEC,
  MAX_DESTINATION_LEN,
  MAX_DEST_ASSET_LEN,
  MIN_FILL_HEADROOM_SECS,
} from "./constants.js";
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
export function validateIntent(params: IntentParams, now = Math.floor(Date.now() / 1000)): void {
  if (!isAddress(params.user)) {
    throw new IntentValidationError(
      "user",
      `must be a valid 20-byte EVM address (got '${params.user}')`,
    );
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
      `must be 'native', '<CODE>:<G...ISSUER>' or a 'C...' token contract strkey, with a valid checksum (got '${params.destAsset}')`,
      "destAsset",
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
      throw new IntentValidationError("nonce", `exceeds uint256 maximum (got ${params.nonce})`);
    }
  }
  if (params.preferredSolver !== undefined && !isAddress(params.preferredSolver)) {
    throw new IntentValidationError(
      "preferredSolver",
      `must be a valid 20-byte EVM address or zero address (got '${params.preferredSolver}')`,
    );
  }
}

export {
  MAX_DEADLINE_HORIZON,
  MAX_DEADLINE_HORIZON_SEC,
  MAX_DESTINATION_LEN,
  MAX_DEST_ASSET_LEN,
  MIN_FILL_HEADROOM_SECS,
};

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
    throw new PerihelionValidationError(`exceeds maximum bridgeable amount (${max})`, field);
  }
}

/**
 * Result of a destination trustline pre-check.
 *
 * Classic Stellar assets (`CODE:ISSUER`) can only be received by an account that
 * exists and holds an authorised trustline for the asset; `native` (XLM) only
 * requires the account to exist. Soroban token contracts (`C...`) need no check.
 */
export interface TrustlineCheckResult {
  /** True when the destination can receive `destAsset` without further setup. */
  ok: boolean;
  /** Human-readable explanation when `ok` is false. */
  reason?: string;
}

/**
 * Callback used to pre-check that a destination can receive `destAsset`.
 *
 * Supply it via {@link BuildOptions.checkTrustline} (or {@link BuildOptions.horizon})
 * to make {@link buildIntent} fail fast — before any EVM lock — when the recipient
 * lacks a trustline for a classic `CODE:ISSUER` asset, or does not exist for `native`.
 * The check is opt-in: when neither option is provided, no network call is made.
 */
export type TrustlineCheck = (destination: string, destAsset: string) => Promise<TrustlineCheckResult>;

/**
 * Minimal Horizon account shape used by the built-in trustline check.
 * Only the fields the check reads are typed.
 */
export interface HorizonAccountLike {
  account_id?: string;
  balances?: Array<{ asset_type?: string; asset_code?: string; asset_issuer?: string }>;
}

/**
 * Minimal Horizon client interface accepted by {@link BuildOptions.horizon}.
 * A real `StellarSdk.Horizon.Server` satisfies this shape.
 */
export interface HorizonClientLike {
  loadAccount(accountId: string): Promise<HorizonAccountLike>;
}

/**
 * Build the default trustline check backed by a Horizon client.
 *
 * - `native`: the account must exist (Horizon `loadAccount` must succeed).
 * - `CODE:ISSUER`: the account must exist and hold a trustline for the asset.
 * - `C...` contract strkeys: always OK (no trustline required).
 *
 * A 404 from Horizon (thrown by `loadAccount`) is reported as "account does not exist".
 */
export function horizonTrustlineCheck(horizon: HorizonClientLike): TrustlineCheck {
  return async (destination: string, destAsset: string): Promise<TrustlineCheckResult> => {
    if (destAsset.startsWith("C")) return { ok: true };
    let account: HorizonAccountLike;
    try {
      account = await horizon.loadAccount(destination);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        reason:
          `destination account ${destination} does not exist on Stellar ` +
          `(Horizon error: ${message}); it must be funded before receiving ${destAsset}`,
      };
    }
    if (destAsset === "native") return { ok: true };
    const sep = destAsset.indexOf(":");
    const code = destAsset.slice(0, sep);
    const issuer = destAsset.slice(sep + 1);
    const hasTrustline = (account.balances ?? []).some(
      (b) =>
        b.asset_type !== "native" &&
        b.asset_code === code &&
        b.asset_issuer === issuer,
    );
    if (!hasTrustline) {
      return {
        ok: false,
        reason:
          `destination account ${destination} has no trustline for ${destAsset}; ` +
          `the recipient must add a trustline for this asset before the fill can succeed`,
      };
    }
    return { ok: true };
  };
}

/** Options for {@link buildIntent}. */
export interface BuildOptions {
=======
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
  /**
   * Receives the non-fatal V_min warning. Defaults to a no-op: the SDK never
   * writes to the console, so an embedding application (wallet, backend, test
   * harness) decides where the warning goes.
   */
  onWarning?: (message: string) => void;
  /**
   * Opt-in destination trustline pre-check. When provided, {@link buildIntent}
   * awaits it and throws {@link IntentValidationError} if the recipient cannot
   * receive `destAsset` (missing account for `native`, or missing trustline for
   * a classic `CODE:ISSUER` asset). See {@link TrustlineCheck}.
   */
  checkTrustline?: TrustlineCheck;
  /**
   * Convenience alternative to {@link BuildOptions.checkTrustline}: a Horizon
   * client used to build the default trustline check via
   * {@link horizonTrustlineCheck}. Ignored when `checkTrustline` is set.
   */
  horizon?: HorizonClientLike;
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
 * **Destination trustline pre-check (opt-in):**
 * - When `options.checkTrustline` (or `options.horizon`) is supplied, the
 *   destination is checked before returning. A classic `CODE:ISSUER` asset
 *   requires the recipient to exist and hold a trustline for it; `native`
 *   requires the recipient to exist. Failures throw {@link IntentValidationError}
 *   so the caller never locks funds against an intent no solver can fill.
 * - When neither option is supplied, no network call is made and behaviour is
 *   unchanged.
 *
 * @param params  Intent parameters (user, destination, amounts, etc.)
 * @param options Build options: `vMin` (minimum notional, see {@link BuildOptions.vMin}),
 *                `sourceDecimals` (asset precision, see {@link BuildOptions.sourceDecimals}),
 *                `suppressWarning` (skip the V_min check), `onWarning` (receives the
 *                V_min warning; no-op when omitted), and `checkTrustline`/`horizon`
 *                (opt-in destination trustline pre-check)
 * @throws {@link PerihelionValidationError} if any field is malformed
 * @returns A fully-formed Intent with nonce and preferredSolver filled in
 */
export async function buildIntent(params: IntentParams, options?: BuildOptions): Promise<Intent> {
  validateIntent(params);

  const trustlineCheck = options?.checkTrustline ?? (options?.horizon ? horizonTrustlineCheck(options.horizon) : undefined);
  if (trustlineCheck) {
    const result = await trustlineCheck(params.destination, params.destAsset);
    if (!result.ok) {
      throw new IntentValidationError(
        "destination",
        result.reason ?? `destination cannot receive ${params.destAsset}`,
      );
    }
  }

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
      const decimalNote =
        options?.sourceDecimals === undefined
          ? " (sourceDecimals not provided; assuming default 6-decimal precision)"
          : ` (normalized from ${sourceDecimals}-decimal source units)`;
      options?.onWarning?.(
        `[Perihelion] Intent source amount (${intent.sourceAmount}) is below the ` +
          `economical minimum V_min (${vMin})${decimalNote}. The fixed LayerZero messaging fee may ` +
          `make this intent unprofitable to fill. Override via buildIntent(..., { vMin, suppressWarning }).`,
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
const SECP256K1_HALF_N = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;

/**
 * ERC-1271 magic value returned by `isValidSignature(bytes32,bytes)` when a
 * contract wallet accepts a signature: `bytes4(keccak256("isValidSignature(bytes32,bytes)"))`.
 */
export const ERC1271_MAGIC_VALUE = "0x1626ba7e" as const;

/** Minimal ERC-1271 ABI fragment used to verify contract-wallet signatures. */
export const ERC1271_ABI = [
  {
    type: "function",
    name: "isValidSignature",
    stateMutability: "view",
    inputs: [
      { name: "hash", type: "bytes32" },
      { name: "signature", type: "bytes" },
    ],
    outputs: [{ name: "magicValue", type: "bytes4" }],
  },
] as const;

/**
 * ERC-6492 magic suffix (32 bytes, `0x6492` repeated). A signature wrapped for a
 * counterfactual (not yet deployed) smart account ends with this value (#1054).
 */
export const ERC6492_MAGIC_SUFFIX =
  "0x6492649264926492649264926492649264926492649264926492649264926492" as const;

/** True iff `signature` carries the ERC-6492 magic suffix. */
export function isErc6492Signature(signature: Hex): boolean {
  return (
    signature.length >= 2 + 64 && signature.toLowerCase().endsWith(ERC6492_MAGIC_SUFFIX.slice(2))
  );
}

/**
 * Options for {@link verifyIntent}.
 */
export interface VerifyIntentOptions {
  /**
   * A viem `PublicClient` used to detect whether `intent.user` is a contract
   * (via `getCode`) and, if so, to call its ERC-1271 `isValidSignature`.
   *
   * Required when `intent.user` may be a smart-contract wallet (Safe multisig,
   * ERC-4337 account, etc.). Without it, contract users are rejected because
   * the ECDSA recovery path cannot validate their signatures.
   */
  client?: PublicClient;
  /**
   * Override the contract-detection step. When provided, `getCode` is not
   * called and this value decides which verification path is taken:
   * `true` → ERC-1271, `false` → ECDSA. Useful when the caller already knows
   * (or has cached) whether the user account is a contract.
   */
  isContract?: boolean;
}

/**
 * Verify an intent signature, supporting both EOAs (ECDSA) and smart-contract
 * wallets (ERC-1271).
 *
 * Mirrors `PerihelionEscrow._verify`:
 * - **Contract users** (`intent.user.code.length > 0`): the signature is
 *   validated by calling `isValidSignature(digest, signature)` on the account
 *   and checking for the ERC-1271 magic value `0x1626ba7e`. Any revert, call
 *   failure, or non-magic return value is treated as an invalid signature.
 *   Detecting a contract requires {@link VerifyIntentOptions.client} (or an
 *   explicit {@link VerifyIntentOptions.isContract} flag).
 * - **EOA users**: only a canonical 65-byte `r ‖ s ‖ v` signature is accepted.
 *   - **64-byte EIP-2098 "compact" signatures are rejected outright.** viem's
 *     recovery path accepts them, but the on-chain verifier does not (it checks
 *     `signature.length != 65` before touching `r`/`s`/`v`), so accepting them
 *     here would let a signature the contract would refuse pass SDK-side checks —
 *     and, worse, a compact re-encoding of an already-valid 65-byte signature
 *     recovers to the *same* signer, giving each signed intent a second valid
 *     byte-string (malleability) purely from the encoding choice.
 *   - Any length other than 65 bytes is rejected immediately.
 *   - The EIP-2 low-s check is applied unconditionally to the one accepted
 *     length, rejecting the high-s (`s > n/2`) malleable counterpart of every
 *     signature.
 *
 * - **ERC-6492-wrapped signatures** (counterfactual smart accounts, e.g. an ERC-4337
 *   wallet that has not been deployed yet): verified with viem's `verifyTypedData`,
 *   which unwraps the wrapper and validates undeployed accounts without deploying
 *   them. Requires `client`; without one the check fails closed.
 *
 * @param domain  Must be built with {@link perihelionDomain}.
 * @param options See {@link VerifyIntentOptions}. Supply `client` (or
 *                `isContract`) when the user may be a contract wallet.
 */
export async function verifyIntent(
  intent: Intent,
  signature: Hex,
  domain: TypedDataDomain,
  options?: VerifyIntentOptions,
): Promise<boolean> {
  if (isErc6492Signature(signature)) {
    if (!options?.client) return false;
    try {
      return await verifyTypedData(options.client, {
        address: intent.user as Address,
        domain,
        types: INTENT_TYPES,
        primaryType: "Intent",
        message: toMessage(intent),
        signature,
      });
    } catch {
      // A malformed wrapper or failed validation is an invalid signature.
      return false;
    }
  }

  // Determine whether the user account is a contract. An explicit override
  // wins; otherwise ask the chain when a client is available.
  let isContract = options?.isContract;
  if (isContract === undefined && options?.client) {
    try {
      const code = await options.client.getCode({ address: intent.user as Address });
      isContract = code !== undefined && code !== "0x";
    } catch {
      // If we cannot determine the account type, fall through to the ECDSA
      // path; a contract user will then simply fail verification.
      isContract = false;
    }
  }

  if (isContract) {
    if (!options?.client) return false;
    const digest = hashIntent(intent, domain);
    try {
      const result = await options.client.readContract({
        address: intent.user as Address,
        abi: ERC1271_ABI,
        functionName: "isValidSignature",
        args: [digest as ViemHex, signature as ViemHex],
      });
      return typeof result === "string" && result.toLowerCase() === ERC1271_MAGIC_VALUE;
    } catch {
      // Reverts (including a missing function) mean the signature is invalid.
      return false;
    }
  }

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
 *                  - Default: `0` (no adjustment). Recommended: `+660` for solver fills
 *                    (relay p99 of 600 s + worst-case clock skew of 60 s; see
 *                    `docs/clock-and-deadline-analysis.md` §5.1).
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
    preferredSolver: intent.preferredSolver,
  };
}
