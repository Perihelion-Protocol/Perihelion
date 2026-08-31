// SPDX-License-Identifier: MIT

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
  | "settled" // assets released on Stellar
  | "refunded" // deadline passed / failed; source funds returned
  | "expired"; // deadline passed before any claim

/**
 * Subset of {@link IntentStatus} values that the mempool can store and accept
 * via `PATCH /intents/:hash/status`.
 *
 * The full `IntentStatus` type includes transient on-chain states
 * (`"claimed"`, `"settling"`) that the mempool does not track — attempting
 * to report those will produce an HTTP 400.  Solver and relayer code that
 * calls {@link PerihelionClient.reportStatus} must use this narrower type
 * (or one of its literal members) to stay within the accepted vocabulary.
 */
export type MempoolIntentStatus = Extract<IntentStatus, "pending" | "settled" | "refunded" | "expired">;

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
  readonly status: IntentStatus;
  /** Solver that claimed the intent, if any. */
  readonly solver?: Address;
  /** Stellar tx hash of the settlement, once settled. */
  readonly settlementTx?: string;
  /** Unix timestamp in seconds when the record was created in the mempool. */
  readonly createdAt: number;
}
