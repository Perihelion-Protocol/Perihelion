// SPDX-License-Identifier: MIT

import { scValToNative, type xdr } from "@stellar/stellar-sdk";

/**
 * Core protocol types shared across the Perihelion SDK, solver, and relayer.
 *
 * An {@link Intent} is the canonical, signable description of what a user wants:
 * spend a known asset/amount on a source EVM chain, receive at least
 * `minDestAmount` of a target asset on Stellar, before `deadline`.
 */

/** A 20-byte EVM address, `0x`-prefixed and checksummed. */
export type Address = `0x${string}`;

/** A `0x`-prefixed hex string of arbitrary length. */
export type Hex = `0x${string}`;

/**
 * A Stellar account or contract address. Either a `G...` (account) or `C...`
 * (contract) strkey, or `"native"` for the native XLM asset destination.
 */
export type StellarAddress = string;

/**
 * Identifier for a Stellar asset at settlement time.
 * - `"native"` for XLM
 * - `"<CODE>:<ISSUER_G...>"` for an issued asset (e.g. `"USDC:GA5Z..."`)
 */
export type StellarAsset = string;

/**
 * A user's signed request to bridge value onto Stellar. All numeric amounts are
 * decimal strings in the asset's smallest unit to preserve precision.
 */
export interface Intent {
  /** EVM address of the user funding the source leg (the EIP-712 signer). */
  readonly user: Address;
  /** Stellar address that receives the settled assets. */
  readonly destination: StellarAddress;
  /** EVM chain id the user spends from (1 = mainnet, 8453 = Base, ...). */
  readonly sourceChainId: number;
  /** ERC-20 token address being spent on the source chain. */
  readonly sourceAsset: Address;
  /** Amount of `sourceAsset` the user locks, in smallest units. */
  readonly sourceAmount: string;
  /** Asset the user wants to receive on Stellar. */
  readonly destAsset: StellarAsset;
  /** Minimum acceptable amount of `destAsset`, in smallest units (slippage floor). */
  readonly minDestAmount: string;
  /** Unix seconds after which the intent is void and funds are refundable. */
  readonly deadline: number;
  /** Unique value preventing replay/collision of otherwise-identical intents. */
  readonly nonce: string;
  /** Optional solver address granted exclusive fill rights; zero address = open. */
  readonly preferredSolver: Address;
}

/** Lifecycle states an intent moves through in the mempool and on-chain. */
export type IntentStatus =
  | "pending" // signed, in the mempool, unclaimed
  | "claimed" // a solver has locked source funds
  | "settling" // cross-chain message in flight
  | "filled" // delivered on Stellar; awaiting source-chain `Released`
  | "settled" // source-chain escrow emitted `Released`; bridge complete
  | "refunded" // deadline passed / failed; source funds returned
  | "expired" // deadline passed before any claim
  | "cancelled"; // user revoked the signed intent before any lock (#1053)

/**
 * On-chain `IntentStatus` enum as defined by the settlement contract
 * (`contracts/soroban/settlement/src/types.rs`).
 *
 * The contract declares a `#[contracttype]` C-like enum with explicit
 * discriminants, which Soroban encodes as a `u32`. `status(intent_hash)`
 * returns `Option<IntentStatus>`, so an absent intent decodes to `undefined`.
 */
export enum OnChainIntentStatus {
  Locked = 0,
  Filled = 1,
  ConfirmationSent = 2,
  Cancelled = 3,
}

/** Canonical variant label for an {@link OnChainIntentStatus}. */
export type OnChainIntentStatusName = "Locked" | "Filled" | "ConfirmationSent" | "Cancelled";

const INTENT_STATUS_NAMES: Readonly<Record<OnChainIntentStatus, OnChainIntentStatusName>> =
  Object.freeze({
    [OnChainIntentStatus.Locked]: "Locked",
    [OnChainIntentStatus.Filled]: "Filled",
    [OnChainIntentStatus.ConfirmationSent]: "ConfirmationSent",
    [OnChainIntentStatus.Cancelled]: "Cancelled",
  });

const INTENT_STATUS_BY_NAME: Readonly<Record<string, OnChainIntentStatus>> = Object.freeze({
  Locked: OnChainIntentStatus.Locked,
  Filled: OnChainIntentStatus.Filled,
  ConfirmationSent: OnChainIntentStatus.ConfirmationSent,
  Cancelled: OnChainIntentStatus.Cancelled,
});

/**
 * Convert an {@link OnChainIntentStatus} discriminant to its variant name,
 * or `undefined` when `status` is `undefined`.
 */
export function intentStatusName(
  status: OnChainIntentStatus | undefined,
): OnChainIntentStatusName | undefined {
  if (status === undefined) return undefined;
  return INTENT_STATUS_NAMES[status];
}

/**
 * Decode the `ScVal` returned by the settlement contract's `status` view into
 * an {@link OnChainIntentStatus}.
 *
 * Accepts the raw `ScVal` (or an already-converted native value) and returns
 * `undefined` when the intent is not registered (`scvVoid` / `undefined`).
 * Throws on values that are not a valid `IntentStatus` discriminant.
 */
export function decodeIntentStatus(scVal: unknown): OnChainIntentStatus | undefined {
  const native = toNativeStatus(scVal);
  if (native === undefined || native === null) return undefined;
  if (typeof native === "string") {
    if (Object.prototype.hasOwnProperty.call(INTENT_STATUS_BY_NAME, native)) {
      return INTENT_STATUS_BY_NAME[native];
    }
    throw new Error(`Unknown IntentStatus variant: ${native}`);
  }
  const numeric = typeof native === "bigint" ? Number(native) : native;
  if (typeof numeric !== "number" || !Number.isInteger(numeric)) {
    const label =
      typeof native === "number" || typeof native === "boolean" || typeof native === "symbol"
        ? String(native)
        : "[object Object]";
    throw new Error(`Unexpected IntentStatus value: ${label}`);
  }
  if (numeric === 0) return OnChainIntentStatus.Locked;
  if (numeric === 1) return OnChainIntentStatus.Filled;
  if (numeric === 2) return OnChainIntentStatus.ConfirmationSent;
  if (numeric === 3) return OnChainIntentStatus.Cancelled;
  throw new Error(`Unknown IntentStatus discriminant: ${numeric}`);
}

/**
 * Whether an on-chain status means the intent has been (or is being) settled,
 * i.e. the destination leg is complete for idempotency purposes.
 */
export function isSettledStatus(status: OnChainIntentStatus | undefined): boolean {
  return status === OnChainIntentStatus.Filled || status === OnChainIntentStatus.ConfirmationSent;
}

/**
 * Normalise an `ScVal`-like value to the native representation produced by
 * `scValToNative`. Handles real `@stellar/stellar-sdk` `xdr.ScVal` instances,
 * mock `ScVal` objects (`{ switch: { name }, u32 }`), variant strings, bigints,
 * and already-converted numbers/`undefined`.
 */
function toNativeStatus(scVal: unknown): unknown {
  if (scVal === undefined || scVal === null) return undefined;
  if (typeof scVal === "number") return scVal;
  if (typeof scVal === "bigint") return Number(scVal);
  if (typeof scVal === "string") return scVal;
  if (typeof scVal === "object") {
    const candidate = scVal as {
      switch?: unknown;
      u32?: unknown;
      i32?: unknown;
      sym?: unknown;
      vec?: unknown;
      value?: unknown;
    };

    if (typeof candidate.switch === "function") {
      const realScVal = scVal as xdr.ScVal;
      const sw = realScVal.switch().name;
      if (sw === "scvVoid") return undefined;
      if (sw === "scvU32") return realScVal.u32();
      if (sw === "scvI32") return realScVal.i32();
      if (sw === "scvSymbol") return realScVal.sym().toString();
      if (sw === "scvVec") {
        const vec = realScVal.vec();
        if (vec && vec.length === 1) {
          return toNativeStatus(vec[0]);
        }
      }
      const converted = scValToNative(realScVal) as unknown;
      if (Array.isArray(converted) && converted.length === 1) {
        return toNativeStatus(converted[0]);
      }
      return typeof converted === "bigint" ? Number(converted) : converted;
    }

    const swObj =
      typeof candidate.switch === "object" && candidate.switch !== null
        ? (candidate.switch as { name?: string })
        : undefined;
    const name = swObj?.name;
    if (name === "scvVoid") return undefined;
    if (name === "scvU32") {
      return typeof candidate.u32 === "function"
        ? (candidate.u32 as () => unknown)()
        : candidate.u32;
    }
    if (name === "scvI32") {
      return typeof candidate.i32 === "function"
        ? (candidate.i32 as () => unknown)()
        : candidate.i32;
    }
    if (name === "scvSymbol") {
      const symVal =
        typeof candidate.sym === "function" ? (candidate.sym as () => unknown)() : candidate.sym;
      if (typeof symVal === "string") return symVal;
      if (symVal instanceof Uint8Array || Buffer.isBuffer(symVal)) {
        return Buffer.from(symVal).toString("utf8");
      }
      return undefined;
    }
    if (name === "scvU64" || name === "scvI64") {
      const raw =
        typeof candidate.value === "function"
          ? (candidate.value as () => unknown)()
          : candidate.value;
      return typeof raw === "bigint" ? Number(raw) : raw;
    }
    // Already-converted native value wrapped in an object.
    if ("value" in candidate) {
      const raw =
        typeof candidate.value === "function"
          ? (candidate.value as () => unknown)()
          : candidate.value;
      if (typeof raw === "number") return raw;
      if (typeof raw === "bigint") return Number(raw);
    }
  }
  return scVal;
}

/**
 * Subset of {@link IntentStatus} values that the mempool can store and accept
 * via `PATCH /intents/:hash/status`.
 *
 * The full `IntentStatus` type includes transient on-chain states
 * (`"claimed"`, `"settling"`) that the mempool does not track — attempting
 * to report those will produce an HTTP 400.  Solver and relayer code that
 * calls {@link PerihelionClient.reportStatus} must use this narrower type
 * (or one of its literal members) to stay within the accepted vocabulary.
 *
 * `"filled"` is an intermediate, non-terminal state: the Stellar leg has been
 * delivered but the source-chain escrow has not yet emitted `Released`.  It
 * must not be treated as settled — a record only becomes `"settled"` once the
 * source chain has released the funds.
 */
export type MempoolIntentStatus = Extract<
  IntentStatus,
  "pending" | "filled" | "settled" | "refunded" | "expired" | "cancelled"
>;

/** An intent together with its signature and current status. */
export interface SignedIntent {
  readonly intent: Intent;
  /** EIP-712 signature over the intent by `intent.user`. */
  readonly signature: Hex;
  /** keccak256 commitment of the intent — its mempool/on-chain id. */
  readonly hash: Hex;
}

/** A status record returned by the mempool for a given intent hash. */
export interface IntentRecord extends SignedIntent {
  readonly status: MempoolIntentStatus;
  /** Solver that claimed the intent, if any. */
  readonly solver?: Address;
  /** Stellar tx hash of the settlement, once settled. */
  readonly settlementTx?: string;
  /** Unix timestamp in seconds when the record was created in the mempool. */
  readonly createdAt: number;
}
