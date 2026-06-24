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

/** EIP-712 domain for Perihelion intents. */
export const PERIHELION_DOMAIN: TypedDataDomain = {
  name: "Perihelion",
  version: "1",
};

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

/** Compute the EIP-712 hash that uniquely identifies an intent. */
export function hashIntent(intent: Intent): Hex {
  return hashTypedData({
    domain: PERIHELION_DOMAIN,
    types: INTENT_TYPES,
    primaryType: "Intent",
    message: toMessage(intent),
  });
}

/** Recover the signer of an intent and check it matches `intent.user`. */
export async function verifyIntent(
  intent: Intent,
  signature: Hex,
): Promise<boolean> {
  const recovered = await recoverTypedDataAddress({
    domain: PERIHELION_DOMAIN,
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

/** Generate a 256-bit random nonce as a decimal string. */
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
