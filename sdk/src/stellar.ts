// SPDX-License-Identifier: MIT

/**
 * Validators for Stellar addresses and asset identifiers, plus the Soroban
 * settlement contract client ({@link PerihelionSettlementClient}).
 *
 * Stellar uses a custom Base32 encoding (RFC 4648 alphabet with CRC-16/XMODEM
 * checksum) for public keys and contract addresses — "strkeys". This module
 * validates the structure and checksum of those values so integrators catch
 * malformed inputs before a cross-chain hop, not after, and provides typed
 * bindings for the Soroban settlement contract (`contracts/soroban/settlement`).
 *
 * Supported strkey version bytes:
 *   G...  → 0x06 << 3 = 0x30  (ED25519 public key / account address)
 *   C...  → 0x02 << 3 = 0x10  (contract address)
 */

import {
  Account,
  Address,
  Asset,
  Contract,
  Keypair,
  Operation,
  SorobanDataBuilder,
  SorobanRpc,
  StrKey,
  TransactionBuilder,
  nativeToScVal,
  scValToNative,
  xdr,
  type Transaction,
} from "@stellar/stellar-sdk";
import { PerihelionContractError, PerihelionError, PerihelionValidationError } from "./errors.js";
import {
  submitAndWait,
  submitWithFeeEscalation,
  type InclusionFeePolicy,
  type SubmitAndWaitOptions,
  type SubmitWithEscalationResult,
} from "./soroban-submit.js";
import {
  OnChainIntentStatus,
  decodeIntentStatus,
  isSettledStatus,
  type Hex,
  type StellarAddress,
  type StellarAsset,
} from "./types.js";

// Stellar's Base32 alphabet (same as RFC 4648 but uppercase only).
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** Default Stellar network passphrase (Testnet) when none is specified. */
export const DEFAULT_STELLAR_NETWORK_PASSPHRASE = "Test SDF Network ; September 2015";

/**
 * Valid zero-byte Stellar account strkey (`G...`) used as the static dummy
 * source account for read-only Soroban `simulateTransaction` view calls.
 */
export const DUMMY_STELLAR_SOURCE_ACCOUNT: StellarAddress =
  "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

/** CRC-16/XMODEM over a byte array, as used by Stellar strkey. */
function crc16(data: Uint8Array): number {
  let crc = 0x0000;
  for (const byte of data) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) {
      crc = crc & 0x8000 ? (crc << 1) ^ 0x1021 : crc << 1;
    }
  }
  return crc & 0xffff;
}

/** Decode a Stellar Base32 string to raw bytes, or null on invalid input. */
function base32Decode(input: string): Uint8Array | null {
  // Stellar strkeys have no padding; length must produce a whole number of bytes.
  const bits = input.length * 5;
  if (bits % 8 !== 0) return null;
  const out = new Uint8Array(bits / 8);
  let buf = 0;
  let bitsLeft = 0;
  let idx = 0;
  for (const ch of input) {
    const val = BASE32_ALPHABET.indexOf(ch);
    if (val === -1) return null;
    buf = (buf << 5) | val;
    bitsLeft += 5;
    if (bitsLeft >= 8) {
      bitsLeft -= 8;
      out[idx++] = (buf >> bitsLeft) & 0xff;
    }
  }
  return out;
}

/**
 * Validate a Stellar strkey.
 * @param value  The strkey string to validate.
 * @param expectedVersion  Expected version byte (0x30 for G-keys, 0x10 for C-keys).
 */
function isValidStrkey(value: string, expectedVersion: number): boolean {
  const decoded = base32Decode(value);
  if (!decoded || decoded.length < 3) return false;
  if (decoded[0] !== expectedVersion) return false;
  // Last 2 bytes are the CRC-16 checksum over the preceding bytes.
  const payload = decoded.slice(0, -2);
  const checksum = decoded[decoded.length - 2]! | (decoded[decoded.length - 1]! << 8);
  return crc16(payload) === checksum;
}

/**
 * Returns true if `value` is a valid Stellar account address (`G...` strkey,
 * 56 chars) or contract address (`C...` strkey, 56 chars).
 *
 * These are the only valid forms for {@link Intent.destination}.
 */
export function isStellarAddress(value: string): boolean {
  if (typeof value !== "string") return false;
  if (value.length !== 56) return false;
  if (value[0] === "G") return isValidStrkey(value, 0x30);
  if (value[0] === "C") return isValidStrkey(value, 0x10);
  return false;
}

/**
 * Decode a Stellar strkey to its 33-byte canonical form: version byte + 32-byte key.
 * Returns [version, keyBytes] on success, null if strkey is invalid.
 *
 * @param value - A valid G... or C... strkey (56 chars).
 */
export function decodeStrkey(value: string): [version: number, key: Uint8Array] | null {
  const decoded = base32Decode(value);
  if (!decoded || decoded.length !== 35) return null; // 1 version + 32 key + 2 CRC

  const version = decoded[0]!;
  if (version !== 0x30 && version !== 0x10) return null; // G or C only

  // Validate CRC-16 checksum (last 2 bytes)
  const payload = decoded.slice(0, 33);
  const checksum = decoded[33]! | (decoded[34]! << 8);
  if (crc16(payload) !== checksum) return null;

  const key = decoded.slice(1, 33);
  return [version, key];
}

/**
 * Returns true if `value` is a canonical Stellar asset identifier, one of:
 * - `"native"` for XLM;
 * - `"<CODE>:<ISSUER>"` where CODE is 1–12 alphanumeric chars and ISSUER
 *   is a valid `G...` account strkey — a classic asset, settled through its
 *   Stellar Asset Contract;
 * - a `C...` contract strkey (56 chars) — a contract-native (SEP-41) token
 *   with no classic asset, settled by calling that contract directly. The
 *   settlement contract only accepts tokens its admin has allowlisted, so a
 *   well-formed `C...` value can still be refused on Stellar.
 *
 * These are the valid forms for {@link Intent.destAsset}. Matches the Soroban
 * decoder (`contracts/soroban/settlement/src/asset.rs`) exactly.
 */
export function isStellarAsset(value: string): boolean {
  if (typeof value !== "string") return false;
  if (value === "native") return true;
  const colon = value.indexOf(":");
  if (colon === -1) {
    return value.length === 56 && value[0] === "C" && isValidStrkey(value, 0x10);
  }
  const code = value.slice(0, colon);
  const issuer = value.slice(colon + 1);
  // Asset codes: 1–12 alphanumeric characters (Stellar spec).
  if (!/^[A-Za-z0-9]{1,12}$/.test(code)) return false;
  // Issuer must be a valid G... account strkey.
  return issuer.length === 56 && issuer[0] === "G" && isValidStrkey(issuer, 0x30);
}

// =============================================================================
// Recipient Deliverability Checks (trustlines / account existence)
// =============================================================================

/**
 * Minimal Horizon account resource shape used by {@link checkRecipientCanReceive}.
 * Only the fields needed to determine account existence and trustline state are
 * required, so lightweight test stubs and raw Horizon JSON both satisfy it.
 */
export interface HorizonAccountResource {
  readonly account_id?: string;
  readonly id?: string;
  readonly sequence?: string;
  readonly balances?: ReadonlyArray<{
    readonly asset_type?: string;
    readonly asset_code?: string;
    readonly asset_issuer?: string;
    readonly balance?: string;
    readonly is_authorized?: boolean;
    readonly is_authorized_to_maintain_liabilities?: boolean;
    readonly limit?: string;
  }>;
}

/**
 * Minimal Horizon client interface required by {@link checkRecipientCanReceive}.
 * Satisfied by `Horizon.Server` from `@stellar/stellar-sdk` as well as test stubs.
 */
export interface HorizonAccountClient {
  loadAccount(accountId: string): Promise<HorizonAccountResource>;
}

/** Options for {@link checkRecipientCanReceive}. */
export interface CheckRecipientCanReceiveOptions {
  /** Recipient Stellar address (`G...` account or `C...` contract). */
  readonly recipient: StellarAddress;
  /**
   * Destination asset identifier: `"native"`, `"<CODE>:<ISSUER>"` (classic
   * asset), or a `C...` contract strkey (SEP-41 token).
   */
  readonly destAsset: StellarAsset;
  /**
   * Horizon client (or any object with `loadAccount`) used to inspect the
   * recipient's account and trustlines. Required for `G...` recipients.
   */
  readonly horizon?: HorizonAccountClient;
  /**
   * Optional Horizon URL used to construct a `Horizon.Server` when `horizon`
   * is omitted. Ignored when `horizon` is provided.
   */
  readonly horizonUrl?: string;
  /** Allow HTTP `horizonUrl` connections. Defaults to `true` for `http://` URLs. */
  readonly allowHttp?: boolean;
}

/** Result of {@link checkRecipientCanReceive}. */
export interface RecipientDeliverabilityResult {
  /** True when the recipient can receive `destAsset` (or the check was skipped). */
  readonly canReceive: boolean;
  /** True when the check could not be performed (e.g. no Horizon client, `C...` recipient). */
  readonly skipped: boolean;
  /** Human-readable explanation, suitable for surfacing to end users. */
  readonly reason?: string;
  /** True when the recipient account does not exist on Stellar. */
  readonly accountMissing?: boolean;
  /** True when the recipient account exists but lacks a trustline for the asset. */
  readonly trustlineMissing?: boolean;
  /** True when the trustline exists but is not authorised by the issuer. */
  readonly trustlineUnauthorized?: boolean;
}

function parseClassicAsset(destAsset: string): { code: string; issuer: string } | undefined {
  if (destAsset === "native") return undefined;
  const colon = destAsset.indexOf(":");
  if (colon === -1) return undefined;
  return { code: destAsset.slice(0, colon), issuer: destAsset.slice(colon + 1) };
}

/**
 * Check whether a Stellar recipient can actually receive `destAsset` before an
 * intent is registered on the EVM side.
 *
 * For classic assets (`"<CODE>:<ISSUER>"`) the destination SAC `transfer`
 * requires the recipient account to exist and to hold an authorised trustline
 * for the asset. For `"native"` the account must simply exist. For `C...`
 * recipients (contracts) and `C...` assets (SEP-41 tokens) no trustline is
 * required, so the check is skipped.
 *
 * Never throws for a missing account/trustline: returns a structured result so
 * callers can decide whether to warn or fail. Throws only on invalid input.
 *
 * @example
 * ```ts
 * const check = await checkRecipientCanReceive({
 *   recipient: "G...",
 *   destAsset: "USDC:GISSUER...",
 *   horizonUrl: "https://horizon-testnet.stellar.org",
 * });
 * if (!check.canReceive) throw new Error(check.reason);
 * ```
 */
export async function checkRecipientCanReceive(
  options: CheckRecipientCanReceiveOptions,
): Promise<RecipientDeliverabilityResult> {
  if (!options || typeof options !== "object") {
    throw new PerihelionValidationError("checkRecipientCanReceive options are required", "options");
  }
  const { recipient, destAsset } = options;
  if (!isStellarAddress(recipient)) {
    throw new PerihelionValidationError(
      `Invalid recipient Stellar address: expected a valid G... or C... strkey, got "${String(recipient)}"`,
      "recipient",
    );
  }
  if (!isStellarAsset(destAsset)) {
    throw new PerihelionValidationError(
      `Invalid destAsset: expected "native", "<CODE>:<ISSUER_G...>", or a valid C... contract strkey, got "${String(destAsset)}"`,
      "destAsset",
    );
  }

  // Contract recipients and contract-native (SEP-41) assets need no trustline.
  if (recipient[0] === "C" || destAsset[0] === "C") {
    return {
      canReceive: true,
      skipped: true,
      reason: "Trustline check not applicable to contract recipients or SEP-41 assets",
    };
  }

  let horizon = options.horizon;
  if (!horizon && typeof options.horizonUrl === "string" && options.horizonUrl.trim().length > 0) {
    const url = options.horizonUrl.trim();
    // Lazily import Horizon to avoid a hard dependency for callers that never use it.
    const { Horizon } = await import("@stellar/stellar-sdk");
    horizon = new Horizon.Server(url, {
      allowHttp: options.allowHttp ?? url.startsWith("http://"),
    }) as unknown as HorizonAccountClient;
  }
  if (!horizon || typeof horizon.loadAccount !== "function") {
    return {
      canReceive: true,
      skipped: true,
      reason: "No Horizon client provided; recipient deliverability not verified",
    };
  }

  let account: HorizonAccountResource;
  try {
    account = await horizon.loadAccount(recipient);
  } catch (err) {
    const status = (err as { response?: { status?: number } })?.response?.status;
    if (status === 404) {
      return {
        canReceive: false,
        skipped: false,
        accountMissing: true,
        reason:
          `Recipient account ${recipient} does not exist on Stellar. ` +
          `Fund it (create the account) before bridging ${destAsset}.`,
      };
    }
    return {
      canReceive: true,
      skipped: true,
      reason: `Could not load recipient account ${recipient}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }

  if (destAsset === "native") {
    return { canReceive: true, skipped: false };
  }

  const classic = parseClassicAsset(destAsset);
  if (!classic) {
    return { canReceive: true, skipped: true };
  }

  const balances = account.balances ?? [];
  const trustline = balances.find(
    (b) =>
      b.asset_type !== "native" &&
      b.asset_code === classic.code &&
      b.asset_issuer === classic.issuer,
  );

  if (!trustline) {
    return {
      canReceive: false,
      skipped: false,
      trustlineMissing: true,
      reason:
        `Recipient ${recipient} has no trustline for ${destAsset}. ` +
        `Create the trustline (change_trust) before bridging.`,
    };
  }

  if (trustline.is_authorized === false) {
    return {
      canReceive: false,
      skipped: false,
      trustlineUnauthorized: true,
      reason:
        `Recipient ${recipient} holds a trustline for ${destAsset} that is not authorised ` +
        `by the issuer. Ask the issuer to authorise it before bridging.`,
    };
  }

  if (trustline.limit !== undefined && trustline.balance !== undefined) {
    try {
      const limit = BigInt(trustline.limit);
      const balance = BigInt(trustline.balance);
      if (limit !== 0n && balance >= limit) {
        return {
          canReceive: false,
          skipped: false,
          reason:
            `Recipient ${recipient} trustline for ${destAsset} is at its limit ` +
            `(${balance.toString()} / ${limit.toString()}).`,
        };
      }
    } catch {
      // Non-numeric limit/balance: ignore the capacity check.
    }
  }

  return { canReceive: true, skipped: false };
}

/**
 * Build the canonical Stellar `Asset` for a classic `"<CODE>:<ISSUER>"` or
 * `"native"` identifier. Returns `undefined` for `C...` contract assets.
 */
export function toStellarAsset(destAsset: StellarAsset): Asset | undefined {
  if (destAsset === "native") return Asset.native();
  const classic = parseClassicAsset(destAsset);
  if (!classic) return undefined;
  return new Asset(classic.code, classic.issuer);
}

// =============================================================================
// Soroban Settlement Contract Spec, Error Mapping & Record Decoder
// =============================================================================

/** Descriptor for an entrypoint exposed by the Soroban settlement contract. */
export interface SettlementMethodSpec {
  readonly name: string;
  readonly args: ReadonlyArray<{ readonly name: string; readonly type: string }>;
  readonly returns: string;
  readonly readOnly: boolean;
}

/**
 * Canonical contract specification metadata for the Soroban settlement contract
 * (`contracts/soroban/settlement/src/lib.rs`), following `stellar contract bindings typescript`
 * conventions.
 */
export const SETTLEMENT_CONTRACT_SPEC = Object.freeze({
  status: {
    name: "status",
    args: [{ name: "intent_hash", type: "BytesN<32>" }],
    returns: "Option<IntentStatus>",
    readOnly: true,
  },
  get_intent: {
    name: "get_intent",
    args: [{ name: "intent_hash", type: "BytesN<32>" }],
    returns: "Option<IntentRecord>",
    readOnly: true,
  },
  is_settled: {
    name: "is_settled",
    args: [{ name: "intent_hash", type: "BytesN<32>" }],
    returns: "bool",
    readOnly: true,
  },
  is_cancelled: {
    name: "is_cancelled",
    args: [{ name: "intent_hash", type: "BytesN<32>" }],
    returns: "bool",
    readOnly: true,
  },
  resolve_dest_asset: {
    name: "resolve_dest_asset",
    args: [{ name: "asset_id", type: "Bytes" }],
    returns: "Result<Address, PerihelionError>",
    readOnly: true,
  },
  quote_cancel_fee: {
    name: "quote_cancel_fee",
    args: [{ name: "dst_eid", type: "u32" }],
    returns: "Result<i128, PerihelionError>",
    readOnly: true,
  },
  quote_fill_confirmed_fee: {
    name: "quote_fill_confirmed_fee",
    args: [{ name: "dst_eid", type: "u32" }],
    returns: "Result<i128, PerihelionError>",
    readOnly: true,
  },
  get_peer: {
    name: "get_peer",
    args: [{ name: "eid", type: "u32" }],
    returns: "Option<BytesN<32>>",
    readOnly: true,
  },
  cancel_expired_intent: {
    name: "cancel_expired_intent",
    args: [
      { name: "caller", type: "Address" },
      { name: "intent_hash", type: "BytesN<32>" },
      { name: "lz_fee", type: "i128" },
    ],
    returns: "Result<(), PerihelionError>",
    readOnly: false,
  },
} as const satisfies Record<string, SettlementMethodSpec>);

/** Array view of {@link SETTLEMENT_CONTRACT_SPEC} method descriptors. */
export const CONTRACT_SPEC_ENTRIES: ReadonlyArray<SettlementMethodSpec> = Object.freeze(
  Object.values(SETTLEMENT_CONTRACT_SPEC),
);

/**
 * Numeric error codes defined by `contracts/soroban/settlement/src/error.rs::PerihelionError`.
 * Surfaced by Soroban RPC as `Error(Contract, #code)`.
 */
export const SETTLEMENT_ERROR_CODES = Object.freeze({
  100: "AlreadyInitialized",
  101: "NotInitialized",
  102: "ContractPaused",
  132: "ReservedForSolver",
  133: "NotPendingAdmin",
  134: "AdminEndpointCollision",
  135: "NotPendingPeerChange",
  136: "PeerChangeNotReady",
  137: "PeerChangeExpired",
  138: "NotPendingEndpointChange",
  139: "EndpointChangeNotReady",
  140: "IntentNotFound",
  141: "IntentFinalized",
  142: "IntentExpired",
  143: "DeadlineNotPassed",
  144: "InsufficientFillAmount",
  145: "InvalidAmount",
  146: "AlreadyFilled",
  147: "DeadlineTooFar",
  148: "ExceedsMaxIntentAmount",
  149: "RollingWindowCapExceeded",
  150: "RollingWindowCapTriggered",
  151: "EndpointChangeExpired",
  152: "InvalidDelay",
  153: "PendingPeerChangeExists",
  154: "PendingEndpointChangeExists",
  155: "AdminUnchanged",
  156: "GuardianCooldownActive",
  157: "GuardianPauseNotExpired",
  160: "MalformedPayload",
  161: "UnknownMessageType",
  162: "StaleNonce",
  163: "UntrustedPeer",
  164: "InsufficientLzFee",
  165: "InvalidSolverEvm",
  166: "UnsupportedDestAsset",
  167: "InvalidDestAsset",
  168: "BatchTooLarge",
  169: "DestAssetSacNotDeployed",
  500: "ArithmeticError",
} as const);

/** Union of all known Soroban settlement contract error variant names. */
export type SettlementErrorName =
  (typeof SETTLEMENT_ERROR_CODES)[keyof typeof SETTLEMENT_ERROR_CODES];

/**
 * Decode a Soroban simulation/invocation error into a typed {@link PerihelionContractError}
 * (when `Error(Contract, #code)` is present) or a {@link PerihelionError}.
 */
export function decodeSettlementError(rawError: unknown, method?: string): PerihelionError {
  const causeOption = rawError instanceof Error ? { cause: rawError } : undefined;

  if (typeof rawError === "number" && Number.isInteger(rawError)) {
    const code = rawError;
    const errorName =
      (SETTLEMENT_ERROR_CODES as Readonly<Record<number, string>>)[code] ??
      `UnknownContractError_${code}`;
    const contractErr = new PerihelionContractError(errorName, `#${code}`, [code], causeOption);
    if (method) {
      contractErr.message = `[Perihelion] ${method} reverted with ${errorName} (selector #${code})`;
    }
    return Object.assign(contractErr, { code });
  }

  const rawText =
    rawError instanceof Error
      ? rawError.message
      : typeof rawError === "string"
        ? rawError
        : typeof rawError === "number" ||
            typeof rawError === "boolean" ||
            typeof rawError === "bigint"
          ? String(rawError)
          : typeof rawError === "object" && rawError !== null && "error" in rawError
            ? typeof rawError.error === "string"
              ? rawError.error
              : JSON.stringify(rawError.error)
            : "unknown simulation error";

  const match =
    /Error\(\s*Contract\s*,\s*#?(\d+)\s*\)/i.exec(rawText) ?? /^#(\d+)$/.exec(rawText.trim());
  if (match && match[1]) {
    const code = Number.parseInt(match[1], 10);
    const errorName =
      (SETTLEMENT_ERROR_CODES as Readonly<Record<number, string>>)[code] ??
      `UnknownContractError_${code}`;
    const contractErr = new PerihelionContractError(errorName, `#${code}`, [code], causeOption);
    contractErr.message =
      `[Perihelion] ${method ? `${method}: ` : ""}Contract reverted with ${errorName} ` +
      `(selector #${code}) — ${rawText}`;
    return Object.assign(contractErr, { code });
  }

  return new PerihelionError(
    `[Perihelion] ${method ?? "Soroban"} simulation failed: ${rawText}`,
    causeOption,
  );
}

/**
 * On-chain `IntentRecord` returned by the Soroban settlement contract's
 * `get_intent(intent_hash)` view (`contracts/soroban/settlement/src/types.rs`).
 */
export interface SettlementIntentRecord {
  /** 32-byte `0x`-prefixed EIP-712 intent hash (`BytesN<32>`). */
  readonly intentHash: Hex;
  /** Source-chain LayerZero endpoint ID (`u32`). */
  readonly srcEid: number;
  /** Recipient Stellar address (`G...` or `C...` strkey). */
  readonly recipient: StellarAddress;
  /** Resolved destination token contract address (`C...` strkey). */
  readonly destAsset: StellarAddress;
  /** Minimum destination amount in smallest units (`i128`). */
  readonly minDestAmount: bigint;
  /** Unix timestamp deadline in seconds (`u64`). */
  readonly deadline: bigint;
  /** Optional preferred solver Stellar address (`Option<Address>`). */
  readonly preferredSolver?: StellarAddress;
  /** Unix timestamp when the preferred-solver reservation expires (`u64`). */
  readonly reservationExpires: bigint;
  /** Current on-chain lifecycle status (`IntentStatus`). */
  readonly status: OnChainIntentStatus;
  /** Stellar address of the solver that filled the intent, if filled (`Option<Address>`). */
  readonly solver?: StellarAddress;
  /** 32-byte left-padded EVM address of the solver, if present (`Option<BytesN<32>>`). */
  readonly solverEvm?: Hex;
  /** Delivered amount in destination token smallest units (`i128`). */
  readonly fillAmount: bigint;
  /** Ledger sequence at which the intent was filled (`u32`). */
  readonly fillLedger: number;
  /** Ledger sequence at which the intent was registered (`u32`). */
  readonly registeredLedger: number;
}

function isRealScVal(value: unknown): value is xdr.ScVal {
  return (
    typeof value === "object" &&
    value !== null &&
    "switch" in value &&
    typeof (value as { switch?: unknown }).switch === "function"
  );
}

function isVoidScVal(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (isRealScVal(value)) return value.switch().name === "scvVoid";
  if (typeof value === "object" && "switch" in value) {
    const sw = (value as { switch?: { name?: string } }).switch;
    if (sw && typeof sw === "object" && sw.name === "scvVoid") return true;
  }
  return false;
}

function decodeScKey(keyVal: xdr.ScVal): string {
  const sw = keyVal.switch().name;
  if (sw === "scvSymbol") return keyVal.sym().toString();
  if (sw === "scvString") return keyVal.str().toString();
  return String(scValToNative(keyVal));
}

function bytesToHex32(bytes: Uint8Array | Buffer, fieldName: string): Hex {
  if (bytes.length !== 32) {
    throw new PerihelionError(
      `[Perihelion] Expected 32 bytes for ${fieldName}, got ${bytes.length}`,
    );
  }
  return `0x${Buffer.from(bytes).toString("hex").toLowerCase()}`;
}

function decodeBytes32Hex(value: unknown, fieldName: string): Hex {
  if (typeof value === "string") {
    const clean = value.startsWith("0x") ? value.slice(2) : value;
    if (/^[0-9a-fA-F]{64}$/.test(clean)) {
      return `0x${clean.toLowerCase()}`;
    }
    throw new PerihelionError(`[Perihelion] Invalid 32-byte hex for ${fieldName}: ${value}`);
  }
  if (value instanceof Uint8Array || Buffer.isBuffer(value)) {
    return bytesToHex32(value, fieldName);
  }
  if (isRealScVal(value)) {
    if (value.switch().name === "scvBytes") {
      return bytesToHex32(value.bytes(), fieldName);
    }
    const native = scValToNative(value) as unknown;
    return decodeBytes32Hex(native, fieldName);
  }
  throw new PerihelionError(`[Perihelion] Missing or invalid ${fieldName} in IntentRecord`);
}

function decodeOptionalBytes32Hex(value: unknown): Hex | undefined {
  if (isVoidScVal(value)) return undefined;
  return decodeBytes32Hex(value, "solver_evm");
}

function decodeAddressValue(value: unknown, fieldName: string): StellarAddress {
  if (typeof value === "string") {
    return value;
  }
  if (isRealScVal(value)) {
    if (value.switch().name === "scvAddress") {
      return Address.fromScVal(value).toString();
    }
    if (value.switch().name === "scvString" || value.switch().name === "scvSymbol") {
      return String(scValToNative(value));
    }
    const native = scValToNative(value) as unknown;
    if (typeof native === "string") return native;
  }
  if (
    typeof value === "object" &&
    value !== null &&
    "toString" in value &&
    typeof (value as { toString?: unknown }).toString === "function"
  ) {
    const str = (value as { toString: () => string }).toString();
    if (isStellarAddress(str)) return str;
  }
  throw new PerihelionError(`[Perihelion] Invalid Stellar address for ${fieldName}`);
}

function decodeOptionalAddress(value: unknown): StellarAddress | undefined {
  if (isVoidScVal(value)) return undefined;
  return decodeAddressValue(value, "optional_address");
}

function decodeU32Value(value: unknown, fieldName: string): number {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
    return value;
  }
  if (typeof value === "bigint") {
    return Number(value);
  }
  if (isRealScVal(value)) {
    const sw = value.switch().name;
    if (sw === "scvU32") return value.u32();
    if (sw === "scvI32") return value.i32();
    const native = scValToNative(value) as unknown;
    return decodeU32Value(native, fieldName);
  }
  throw new PerihelionError(`[Perihelion] Invalid u32 value for ${fieldName}: ${String(value)}`);
}

function decodeBigIntScVal(value: unknown, fieldName: string): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isInteger(value)) return BigInt(value);
  if (typeof value === "string" && /^-?\d+$/.test(value)) return BigInt(value);
  if (isRealScVal(value)) {
    const sw = value.switch().name;
    if (sw === "scvU32") return BigInt(value.u32());
    if (sw === "scvI32") return BigInt(value.i32());
    const native = scValToNative(value) as unknown;
    if (typeof native === "bigint") return native;
    if (typeof native === "number" && Number.isInteger(native)) return BigInt(native);
    if (typeof native === "string" && /^-?\d+$/.test(native)) return BigInt(native);
  }
  if (typeof value === "object" && value !== null && "value" in value) {
    const raw =
      typeof (value as { value?: unknown }).value === "function"
        ? (value as { value: () => unknown }).value()
        : (value as { value?: unknown }).value;
    if (typeof raw === "bigint" || typeof raw === "number" || typeof raw === "string") {
      return BigInt(raw);
    }
  }
  throw new PerihelionError(
    `[Perihelion] Invalid integer value for ${fieldName}: ${String(value)}`,
  );
}

/**
 * Decode an `Option<IntentRecord>` `xdr.ScVal` (or native map/object) returned
 * by `get_intent(intent_hash)` into a typed {@link SettlementIntentRecord}, or
 * `undefined` when the intent is not registered (`scvVoid` / `null` / `undefined`).
 */
export function decodeSettlementIntentRecord(retval: unknown): SettlementIntentRecord | undefined {
  if (isVoidScVal(retval)) return undefined;

  const fields = new Map<string, unknown>();

  if (isRealScVal(retval)) {
    const sw = retval.switch().name;
    if (sw === "scvMap") {
      const entries = retval.map() ?? [];
      for (const entry of entries) {
        fields.set(decodeScKey(entry.key()), entry.val());
      }
    } else {
      const native = scValToNative(retval) as unknown;
      return decodeSettlementIntentRecord(native);
    }
  } else if (retval instanceof Map) {
    for (const [k, v] of retval.entries()) {
      fields.set(String(k), v);
    }
  } else if (typeof retval === "object" && retval !== null) {
    for (const [k, v] of Object.entries(retval)) {
      fields.set(k, v);
    }
  } else {
    throw new PerihelionError(`[Perihelion] Unexpected IntentRecord value: ${String(retval)}`);
  }

  const getField = (snake: string, camel: string): unknown =>
    fields.has(snake) ? fields.get(snake) : fields.get(camel);

  const intentHash = decodeBytes32Hex(getField("intent_hash", "intentHash"), "intent_hash");
  const srcEid = decodeU32Value(getField("src_eid", "srcEid"), "src_eid");
  const recipient = decodeAddressValue(getField("recipient", "recipient"), "recipient");
  const destAsset = decodeAddressValue(getField("dest_asset", "destAsset"), "dest_asset");
  const minDestAmount = decodeBigIntScVal(
    getField("min_dest_amount", "minDestAmount"),
    "min_dest_amount",
  );
  const deadline = decodeBigIntScVal(getField("deadline", "deadline"), "deadline");
  const preferredSolver = decodeOptionalAddress(getField("preferred_solver", "preferredSolver"));
  const reservationExpires = decodeBigIntScVal(
    getField("reservation_expires", "reservationExpires"),
    "reservation_expires",
  );
  const statusVal = getField("status", "status");
  const status = decodeIntentStatus(statusVal);
  if (status === undefined) {
    throw new PerihelionError("[Perihelion] IntentRecord is missing a valid status");
  }
  const solver = decodeOptionalAddress(getField("solver", "solver"));
  const solverEvm = decodeOptionalBytes32Hex(getField("solver_evm", "solverEvm"));
  const fillAmount = decodeBigIntScVal(getField("fill_amount", "fillAmount"), "fill_amount");
  const fillLedger = decodeU32Value(getField("fill_ledger", "fillLedger"), "fill_ledger");
  const registeredLedger = decodeU32Value(
    getField("registered_ledger", "registeredLedger"),
    "registered_ledger",
  );

  return {
    intentHash,
    srcEid,
    recipient,
    destAsset,
    minDestAmount,
    deadline,
    preferredSolver,
    reservationExpires,
    status,
    solver,
    solverEvm,
    fillAmount,
    fillLedger,
    registeredLedger,
  };
}

// =============================================================================
// PerihelionSettlementClient Interfaces & Implementation
// =============================================================================

/**
 * Restore preamble returned by `simulateTransaction` when persistent ledger
 * entries referenced by a Soroban invocation have been archived.
 */
export type SorobanRestorePreamble =
  SorobanRpc.Api.SimulateTransactionRestoreResponse["restorePreamble"];

/**
 * Minimal Soroban RPC client interface required by {@link PerihelionSettlementClient}.
 * Satisfied directly by `SorobanRpc.Server` from `@stellar/stellar-sdk` as well
 * as lightweight test stubs.
 */
export interface SorobanRpcClient {
  simulateTransaction(
    transaction: Transaction,
  ): Promise<SorobanRpc.Api.SimulateTransactionResponse>;
  getAccount?(address: string): Promise<Account>;
  sendTransaction?(transaction: Transaction): Promise<SorobanRpc.Api.SendTransactionResponse>;
  getTransaction?(hash: string): Promise<SorobanRpc.Api.GetTransactionResponse>;
  getFeeStats?(): Promise<SorobanRpc.Api.GetFeeStatsResponse>;
}

/** Configuration options for {@link PerihelionSettlementClient}. */
export interface SettlementClientOptions {
  /** Pre-configured Soroban RPC client instance (mutually optional with `rpcUrl`). */
  readonly rpc?: SorobanRpcClient;
  /** Soroban RPC endpoint URL (used to construct `SorobanRpc.Server` when `rpc` is omitted). */
  readonly rpcUrl?: string;
  /** Soroban settlement contract ID (`C...` strkey or 64-character hex string). */
  readonly contractId: StellarAddress;
  /** Stellar network passphrase. Defaults to `"Test SDF Network ; September 2015"`. */
  readonly networkPassphrase?: string;
  /** Transaction timeout in seconds. Defaults to `30`. */
  readonly timeoutSeconds?: number;
  /** Base inclusion fee in stroops for simulations and unsigned transactions. Defaults to `"100"`. */
  readonly defaultFeeStroops?: string | number;
  /** Dummy source account (`G...` strkey) used for read-only view simulations. */
  readonly sourceAccountId?: StellarAddress;
  /** Allow HTTP `rpcUrl` connections when constructing `SorobanRpc.Server`. */
  readonly allowHttp?: boolean;
}

/** Options for {@link PerihelionSettlementClient.buildCancelExpiredTx}. */
export interface BuildCancelExpiredTxOptions {
  /** Stellar address (`G...` or `C...`) authorizing `cancel_expired_intent` and paying the LZ fee. */
  readonly caller: StellarAddress;
  /** 32-byte `0x`-prefixed intent hash (`BytesN<32>`). */
  readonly intentHash: Hex;
  /**
   * LayerZero native fee in XLM stroops (`i128`).
   * When omitted, `buildCancelExpiredTx` automatically quotes the fee via
   * `quoteCancelFee(dstEid)` (resolving `dstEid` from `options.dstEid` or
   * `getIntent(intentHash).srcEid`).
   */
  readonly lzFee?: bigint;
  /**
   * Optional safety buffer in stroops added on top of an auto-quoted `lzFee`.
   * Defaults to `0n`.
   */
  readonly lzFeeBufferStroops?: bigint;
  /**
   * Source-chain LayerZero endpoint ID (`u32`) used when auto-quoting `lzFee`.
   * If omitted when `lzFee` is omitted, `getIntent(intentHash)` is queried
   * to discover `srcEid`.
   */
  readonly dstEid?: number;
  /**
   * Optional pre-loaded `Account` for the transaction builder.
   * When omitted and `rpc.getAccount` is available, fetches `await rpc.getAccount(caller)`.
   */
  readonly account?: Account;
  /** Per-operation inclusion fee in stroops. Defaults to `client.defaultFeeStroops` (`"100"`). */
  readonly fee?: string | number;
  /** Transaction timeout in seconds. Defaults to `client.timeoutSeconds` (`30`). */
  readonly timeoutSeconds?: number;
  /**
   * Whether to simulate the transaction via `rpc.simulateTransaction` and
   * assemble the Soroban footprint/auth via `SorobanRpc.assembleTransaction`.
   * Defaults to `true`. Set to `false` to return the raw un-assembled invocation transaction.
   */
  readonly simulate?: boolean;
  /**
   * Optional hook invoked when `simulateTransaction` reports that persistent
   * contract entries are archived (`SorobanRpc.Api.isSimulationRestore`).
   * After the callback completes (e.g. submitting a `RestoreFootprint` transaction),
   * `buildCancelExpiredTx` re-simulates and assembles the transaction.
   */
  readonly onRestorePreamble?: (restorePreamble: SorobanRestorePreamble) => void | Promise<void>;
}

/** Options for {@link PerihelionSettlementClient.submitCancelExpired}. */
export interface SubmitCancelExpiredOptions {
  /** Stellar address (`G...`) of the caller, or omitted if `signer` (`Keypair` / secret) is provided. */
  readonly caller?: StellarAddress;
  /** 32-byte `0x`-prefixed intent hash (`BytesN<32>`). */
  readonly intentHash: Hex;
  /**
   * LayerZero native fee in XLM stroops (`i128`).
   * If omitted, automatically quoted via `quoteCancelFee(dstEid)`.
   */
  readonly lzFee?: bigint;
  /** Optional safety buffer in stroops added on top of an auto-quoted `lzFee`. */
  readonly lzFeeBufferStroops?: bigint;
  /** Optional `dstEid` used when auto-quoting `lzFee`. */
  readonly dstEid?: number;
  /**
   * Stellar `Keypair` or secret key (`S...` strkey) used to sign transactions,
   * or omitted if a custom `sign(transaction)` callback is provided.
   */
  readonly signer?: Keypair | string;
  /** Custom transaction signer callback (used if `signer` keypair/secret is not provided). */
  readonly sign?: (transaction: Transaction) => void;
  /** Inclusion-fee escalation policy passed to `submitWithFeeEscalation`. */
  readonly policy?: InclusionFeePolicy;
  /** Polling and retry knobs passed to `submitWithFeeEscalation` / `submitAndWait`. */
  readonly submitOptions?: SubmitAndWaitOptions;
  /**
   * Whether to automatically build, sign, and submit a `RestoreFootprint`
   * transaction when simulation reports archived entries. Defaults to `true`.
   */
  readonly restoreFootprint?: boolean;
  /** Transaction timeout in seconds. Defaults to `client.timeoutSeconds`. */
  readonly timeoutSeconds?: number;
  /** Optional structured logger for fee-escalation warnings. */
  readonly logger?: { warn(message: string, meta?: Record<string, unknown>): void };
}

function normalizeContractId(contractId: string): StellarAddress {
  if (typeof contractId !== "string" || contractId.trim().length === 0) {
    throw new PerihelionValidationError(
      "Settlement contractId must be a non-empty C... strkey or 64-character hex string",
      "contractId",
    );
  }
  const trimmed = contractId.trim();
  if (trimmed.length === 56 && trimmed[0] === "C" && isValidStrkey(trimmed, 0x10)) {
    return trimmed;
  }
  if (/^(?:0x)?[0-9a-fA-F]{64}$/.test(trimmed)) {
    const cleanHex = trimmed.startsWith("0x") ? trimmed.slice(2) : trimmed;
    return StrKey.encodeContract(Buffer.from(cleanHex, "hex"));
  }
  throw new PerihelionValidationError(
    `Invalid settlement contractId: expected a valid C... contract strkey or 32-byte hex ID, got "${contractId}"`,
    "contractId",
  );
}

function assertValidIntentHash(intentHash: string): Buffer {
  if (typeof intentHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(intentHash)) {
    throw new PerihelionValidationError(
      `Invalid intentHash: expected a 0x-prefixed 32-byte hex string, got "${String(intentHash)}"`,
      "intentHash",
    );
  }
  return Buffer.from(intentHash.slice(2), "hex");
}

function assertValidEid(eid: number, fieldName = "dstEid"): number {
  if (typeof eid !== "number" || !Number.isInteger(eid) || eid <= 0 || eid > 0xffff_ffff) {
    throw new PerihelionValidationError(
      `Invalid ${fieldName}: expected an integer in 1..4294967295, got ${String(eid)}`,
      fieldName,
    );
  }
  return eid;
}

function hasRestorePreamble(
  simulated: unknown,
): simulated is { restorePreamble: SorobanRestorePreamble } {
  if (!simulated || typeof simulated !== "object") return false;
  if (SorobanRpc.Api.isSimulationRestore(simulated as SorobanRpc.Api.SimulateTransactionResponse)) {
    return true;
  }
  const preamble = (
    simulated as {
      restorePreamble?: { transactionData?: unknown; minResourceFee?: string };
    }
  ).restorePreamble;
  return Boolean(preamble && preamble.transactionData);
}

function extractSorobanData(
  data: SorobanDataBuilder | xdr.SorobanTransactionData | string | undefined,
): xdr.SorobanTransactionData {
  if (data && typeof (data as { build?: unknown }).build === "function") {
    return (data as SorobanDataBuilder).build();
  }
  if (data instanceof xdr.SorobanTransactionData) {
    return data;
  }
  if (typeof data === "string" && data.length > 0) {
    return new SorobanDataBuilder(data).build();
  }
  return new SorobanDataBuilder().build();
}

function assembleSimulatedTransaction(
  tx: Transaction,
  simulated: SorobanRpc.Api.SimulateTransactionResponse,
): Transaction {
  const simObj = simulated as unknown as {
    id?: string;
    latestLedger?: number;
    events?: xdr.DiagnosticEvent[];
    minResourceFee?: string;
    transactionData?: SorobanDataBuilder | xdr.SorobanTransactionData | string;
    result?: {
      auth?: xdr.SorobanAuthorizationEntry[];
      retval?: xdr.ScVal;
    };
  };

  const txDataBuilder =
    simObj.transactionData &&
    typeof (simObj.transactionData as { build?: unknown }).build === "function"
      ? (simObj.transactionData as SorobanDataBuilder)
      : new SorobanDataBuilder(extractSorobanData(simObj.transactionData));

  const normalizedSim = {
    _parsed: true,
    id: simObj.id ?? "sim",
    latestLedger: simObj.latestLedger ?? 1,
    events: simObj.events ?? [],
    minResourceFee: simObj.minResourceFee ?? "0",
    transactionData: txDataBuilder,
    result: {
      auth: simObj.result?.auth ?? [],
      retval: simObj.result?.retval ?? xdr.ScVal.scvVoid(),
    },
  } as unknown as SorobanRpc.Api.SimulateTransactionSuccessResponse;

  return SorobanRpc.assembleTransaction(tx, normalizedSim).build();
}

/**
 * TypeScript SDK client for the Soroban settlement contract
 * (`contracts/soroban/settlement`).
 *
 * All read-only view methods (`status`, `getIntent`, `isSettled`,
 * `resolveDestAsset`, `quoteCancelFee`, `quoteFillConfirmedFee`, `getPeer`)
 * simulate transactions using a static zero-sequence dummy `Account` and
 * **never** call `rpc.getAccount`.
 */
export class PerihelionSettlementClient {
  readonly contractId: StellarAddress;
  readonly networkPassphrase: string;
  readonly timeoutSeconds: number;
  readonly defaultFeeStroops: string;
  readonly sourceAccountId: StellarAddress;
  readonly rpc: SorobanRpcClient;
  private readonly contract: Contract;

  constructor(options: SettlementClientOptions);
  constructor(rpcOrUrl: SorobanRpcClient | string, contractId: string, networkPassphrase?: string);
  constructor(
    optionsOrRpc: SettlementClientOptions | SorobanRpcClient | string,
    contractIdArg?: string,
    networkPassphraseArg?: string,
  ) {
    let options: SettlementClientOptions;
    if (
      typeof optionsOrRpc === "string" ||
      (typeof optionsOrRpc === "object" &&
        optionsOrRpc !== null &&
        "simulateTransaction" in optionsOrRpc &&
        !("contractId" in optionsOrRpc))
    ) {
      options = {
        ...(typeof optionsOrRpc === "string" ? { rpcUrl: optionsOrRpc } : { rpc: optionsOrRpc }),
        contractId: contractIdArg ?? "",
        networkPassphrase: networkPassphraseArg,
      };
    } else if (typeof optionsOrRpc === "object" && optionsOrRpc !== null) {
      options = optionsOrRpc as SettlementClientOptions;
    } else {
      throw new PerihelionValidationError(
        "PerihelionSettlementClient options are required",
        "options",
      );
    }

    this.contractId = normalizeContractId(options.contractId);
    this.contract = new Contract(this.contractId);
    this.networkPassphrase =
      options.networkPassphrase && options.networkPassphrase.trim().length > 0
        ? options.networkPassphrase
        : DEFAULT_STELLAR_NETWORK_PASSPHRASE;
    this.timeoutSeconds = options.timeoutSeconds ?? 30;
    this.defaultFeeStroops = String(options.defaultFeeStroops ?? "100");

    const sourceAccount = options.sourceAccountId ?? DUMMY_STELLAR_SOURCE_ACCOUNT;
    if (!isStellarAddress(sourceAccount) || sourceAccount[0] !== "G") {
      throw new PerihelionValidationError(
        `Invalid sourceAccountId: expected a valid G... account strkey, got "${String(sourceAccount)}"`,
        "sourceAccountId",
      );
    }
    this.sourceAccountId = sourceAccount;

    if (options.rpc && typeof options.rpc.simulateTransaction === "function") {
      this.rpc = options.rpc;
    } else if (typeof options.rpcUrl === "string" && options.rpcUrl.trim().length > 0) {
      const url = options.rpcUrl.trim();
      this.rpc = new SorobanRpc.Server(url, {
        allowHttp: options.allowHttp ?? url.startsWith("http://"),
      });
    } else {
      throw new PerihelionValidationError(
        "PerihelionSettlementClient requires either an rpc client instance or a non-empty rpcUrl",
        "rpc",
      );
    }
  }

  /**
   * Authoritative intent status view (`status(intent_hash)`).
   * Consults durable idempotency markers (`ConfirmationSent`, `Settled`, `Cancelled`)
   * first, then falls back to the live `IntentRecord`.
   * Returns `undefined` when the intent is not registered.
   */
  async status(intentHash: Hex): Promise<OnChainIntentStatus | undefined> {
    const hashBytes = assertValidIntentHash(intentHash);
    const retval = await this.simulateView("status", [xdr.ScVal.scvBytes(hashBytes)]);
    return decodeIntentStatus(retval);
  }

  /**
   * Fetch the full on-chain `IntentRecord` (`get_intent(intent_hash)`), or
   * `undefined` if not registered or archived after the grace window.
   */
  async getIntent(intentHash: Hex): Promise<SettlementIntentRecord | undefined> {
    const hashBytes = assertValidIntentHash(intentHash);
    const retval = await this.simulateView("get_intent", [xdr.ScVal.scvBytes(hashBytes)]);
    return decodeSettlementIntentRecord(retval);
  }

  /**
   * Check whether an intent has been settled on Stellar (`is_settled(intent_hash)`).
   */
  async isSettled(intentHash: Hex): Promise<boolean> {
    const hashBytes = assertValidIntentHash(intentHash);
    const retval = await this.simulateView("is_settled", [xdr.ScVal.scvBytes(hashBytes)]);
    if (retval === undefined || retval === null) return false;
    if (typeof retval === "boolean") return retval;
    if (isRealScVal(retval)) {
      const sw = retval.switch().name;
      if (sw === "scvBool") return retval.b();
      if (sw === "scvVoid") return false;
      if (sw === "scvU32" || sw === "scvI32" || sw === "scvSymbol") {
        return isSettledStatus(decodeIntentStatus(retval));
      }
      const native = scValToNative(retval) as unknown;
      if (typeof native === "boolean") return native;
      if (typeof native === "number" || typeof native === "bigint") {
        return isSettledStatus(decodeIntentStatus(native));
      }
      return Boolean(native);
    }
    return Boolean(retval);
  }

  /**
   * Resolve a canonical `destAsset` identifier (`"native"`, `"CODE:ISSUER"`, or
   * allowlisted `"C..."` strkey) to the Stellar token contract address (`C...`)
   * that `fill_intent` transfers (`resolve_dest_asset(asset_id)`).
   */
  async resolveDestAsset(destAsset: StellarAsset): Promise<StellarAddress> {
    if (!isStellarAsset(destAsset)) {
      throw new PerihelionValidationError(
        `Invalid destAsset: expected "native", "<CODE>:<ISSUER_G...>", or a valid C... contract strkey, got "${String(destAsset)}"`,
        "destAsset",
      );
    }
    const assetBytes = Buffer.from(destAsset, "utf8");
    const retval = await this.simulateView("resolve_dest_asset", [xdr.ScVal.scvBytes(assetBytes)]);
    const address = decodeAddressValue(retval, "resolve_dest_asset");
    if (!isStellarAddress(address)) {
      throw new PerihelionError(
        `[Perihelion] resolve_dest_asset returned an invalid Stellar address: ${address}`,
      );
    }
    return address;
  }

  /**
   * Quote the LayerZero native fee (in XLM stroops) required to dispatch a
   * `CancelIntent` message to `dstEid` (`quote_cancel_fee(dst_eid)`).
   */
  async quoteCancelFee(dstEid: number): Promise<bigint> {
    const validEid = assertValidEid(dstEid, "dstEid");
    const retval = await this.simulateView("quote_cancel_fee", [xdr.ScVal.scvU32(validEid)]);
    return decodeBigIntScVal(retval, "quote_cancel_fee");
  }

  /**
   * Quote the LayerZero native fee (in XLM stroops) required to dispatch a
   * `FillConfirmed` message to `dstEid` (`quote_fill_confirmed_fee(dst_eid)`).
   */
  async quoteFillConfirmedFee(dstEid: number): Promise<bigint> {
    const validEid = assertValidEid(dstEid, "dstEid");
    const retval = await this.simulateView("quote_fill_confirmed_fee", [
      xdr.ScVal.scvU32(validEid),
    ]);
    return decodeBigIntScVal(retval, "quote_fill_confirmed_fee");
  }

  /**
   * Read the registered 32-byte peer address for `eid` (`get_peer(eid)`), or
   * `undefined` if no peer is configured for `eid`.
   */
  async getPeer(eid: number): Promise<Uint8Array | undefined> {
    const validEid = assertValidEid(eid, "eid");
    const retval = await this.simulateView("get_peer", [xdr.ScVal.scvU32(validEid)]);
    if (isVoidScVal(retval)) return undefined;
    if (retval instanceof Uint8Array || Buffer.isBuffer(retval)) {
      return retval.length === 32 ? new Uint8Array(retval) : undefined;
    }
    if (isRealScVal(retval)) {
      if (retval.switch().name === "scvBytes") {
        const bytes = retval.bytes();
        return bytes.length === 32 ? new Uint8Array(bytes) : undefined;
      }
      const native = scValToNative(retval) as unknown;
      if (native instanceof Uint8Array || Buffer.isBuffer(native)) {
        return native.length === 32 ? new Uint8Array(native) : undefined;
      }
    }
    return undefined;
  }

  /**
   * Build (and by default simulate + assemble) a transaction invoking
   * `cancel_expired_intent(caller, intent_hash, lz_fee)`.
   *
   * Supports both an options object ({@link BuildCancelExpiredTxOptions}) and
   * positional arguments `(caller, intentHash, lzFee?, options?)`.
   * If `lzFee` is omitted, automatically quotes the fee via `quoteCancelFee(dstEid)`
   * (resolving `dstEid` from `options.dstEid` or `getIntent(intentHash).srcEid`).
   */
  buildCancelExpiredTx(options: BuildCancelExpiredTxOptions): Promise<Transaction>;
  buildCancelExpiredTx(
    caller: StellarAddress,
    intentHash: Hex,
    lzFee?: bigint,
    options?: Omit<BuildCancelExpiredTxOptions, "caller" | "intentHash" | "lzFee">,
  ): Promise<Transaction>;
  async buildCancelExpiredTx(
    optionsOrCaller: BuildCancelExpiredTxOptions | StellarAddress,
    intentHashArg?: Hex,
    lzFeeArg?: bigint,
    extraOptions?: Omit<BuildCancelExpiredTxOptions, "caller" | "intentHash" | "lzFee">,
  ): Promise<Transaction> {
    const opts: BuildCancelExpiredTxOptions =
      typeof optionsOrCaller === "string"
        ? {
            ...extraOptions,
            caller: optionsOrCaller,
            intentHash: intentHashArg as Hex,
            lzFee: lzFeeArg,
          }
        : optionsOrCaller;

    if (!opts || typeof opts !== "object") {
      throw new PerihelionValidationError(
        "buildCancelExpiredTx requires options or (caller, intentHash, lzFee?)",
        "options",
      );
    }

    if (!isStellarAddress(opts.caller)) {
      throw new PerihelionValidationError(
        `Invalid caller Stellar address: expected a valid G... or C... strkey, got "${String(opts.caller)}"`,
        "caller",
      );
    }
    const hashBytes = assertValidIntentHash(opts.intentHash);

    let resolvedLzFee = opts.lzFee;
    if (resolvedLzFee !== undefined) {
      if (typeof resolvedLzFee !== "bigint" || resolvedLzFee < 0n) {
        throw new PerihelionValidationError(
          `Invalid lzFee: expected a non-negative bigint, got ${String(resolvedLzFee)}`,
          "lzFee",
        );
      }
    } else {
      let dstEid = opts.dstEid;
      if (dstEid === undefined) {
        const record = await this.getIntent(opts.intentHash);
        if (!record) {
          throw decodeSettlementError(140, "cancel_expired_intent");
        }
        dstEid = record.srcEid;
      }
      const quoted = await this.quoteCancelFee(dstEid);
      const buffer = opts.lzFeeBufferStroops ?? 0n;
      if (typeof buffer !== "bigint" || buffer < 0n) {
        throw new PerihelionValidationError(
          `Invalid lzFeeBufferStroops: expected a non-negative bigint, got ${String(buffer)}`,
          "lzFeeBufferStroops",
        );
      }
      resolvedLzFee = quoted + buffer;
    }

    const resolveBuilderAccount = async (): Promise<Account> => {
      if (opts.account) {
        return new Account(opts.account.accountId(), opts.account.sequenceNumber());
      }
      if (
        opts.simulate !== false &&
        typeof this.rpc.getAccount === "function" &&
        opts.caller.startsWith("G")
      ) {
        const loaded = await this.rpc.getAccount(opts.caller);
        return new Account(loaded.accountId(), loaded.sequenceNumber());
      }
      const sourceId = opts.caller.startsWith("G") ? opts.caller : this.sourceAccountId;
      return new Account(sourceId, "0");
    };

    const args: xdr.ScVal[] = [
      new Address(opts.caller).toScVal(),
      xdr.ScVal.scvBytes(hashBytes),
      nativeToScVal(resolvedLzFee, { type: "i128" }),
    ];

    const feeStroops = String(opts.fee ?? this.defaultFeeStroops);
    const timeoutSecs = opts.timeoutSeconds ?? this.timeoutSeconds;

    const buildRawTx = (builderAccount: Account): Transaction =>
      new TransactionBuilder(builderAccount, {
        fee: feeStroops,
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(this.contract.call("cancel_expired_intent", ...args))
        .setTimeout(timeoutSecs)
        .build();

    let tx = buildRawTx(await resolveBuilderAccount());
    if (opts.simulate === false) {
      return tx;
    }

    let simulated = await this.rpc.simulateTransaction(tx);
    if (hasRestorePreamble(simulated)) {
      if (opts.onRestorePreamble) {
        await opts.onRestorePreamble(simulated.restorePreamble);
        let postRestoreAccount: Account;
        if (typeof this.rpc.getAccount === "function" && opts.caller.startsWith("G")) {
          const refreshed = await this.rpc.getAccount(opts.caller);
          postRestoreAccount = new Account(refreshed.accountId(), refreshed.sequenceNumber());
        } else {
          postRestoreAccount = new Account(tx.source, String(BigInt(tx.sequence)));
        }
        tx = buildRawTx(postRestoreAccount);
        simulated = await this.rpc.simulateTransaction(tx);
      } else {
        throw new PerihelionError(
          "[Perihelion] cancel_expired_intent simulation requires footprint restoration (restorePreamble present)",
        );
      }
    }

    if ("error" in simulated && simulated.error) {
      throw decodeSettlementError(simulated.error, "cancel_expired_intent");
    }
    if (
      !SorobanRpc.Api.isSimulationSuccess(simulated) &&
      !("result" in simulated && simulated.result)
    ) {
      throw decodeSettlementError(
        (simulated as { error?: unknown })?.error ?? "missing simulation result",
        "cancel_expired_intent",
      );
    }

    return assembleSimulatedTransaction(tx, simulated);
  }

  /**
   * Build a `RestoreFootprint` transaction from a simulation's `restorePreamble`
   * when persistent contract entries have been archived.
   */
  buildRestoreFootprintTx(
    account: Account,
    restorePreamble: SorobanRestorePreamble,
    options?: { timeoutSeconds?: number },
  ): Transaction {
    const builderAccount = new Account(account.accountId(), account.sequenceNumber());
    return new TransactionBuilder(builderAccount, {
      fee: String(restorePreamble.minResourceFee ?? this.defaultFeeStroops),
      networkPassphrase: this.networkPassphrase,
    })
      .setSorobanData(extractSorobanData(restorePreamble.transactionData))
      .addOperation(Operation.restoreFootprint({}))
      .setTimeout(options?.timeoutSeconds ?? this.timeoutSeconds)
      .build();
  }

  /**
   * End-to-end helper for keepers and backends: restores archived footprint
   * entries if needed (`RestoreFootprint`), then submits `cancel_expired_intent`
   * with automatic inclusion-fee escalation via {@link submitWithFeeEscalation}.
   */
  async submitCancelExpired(
    options: SubmitCancelExpiredOptions,
  ): Promise<SubmitWithEscalationResult> {
    if (!options || typeof options !== "object") {
      throw new PerihelionValidationError("submitCancelExpired options are required", "options");
    }

    let keypair: Keypair | undefined;
    if (typeof options.signer === "string") {
      try {
        keypair = Keypair.fromSecret(options.signer);
      } catch (err) {
        throw new PerihelionValidationError(
          `Invalid signer secret key: ${err instanceof Error ? err.message : String(err)}`,
          "signer",
          { cause: err },
        );
      }
    } else if (options.signer) {
      keypair = options.signer;
    }

    const caller = options.caller ?? keypair?.publicKey();
    if (!caller || !isStellarAddress(caller) || !caller.startsWith("G")) {
      throw new PerihelionValidationError(
        `Invalid caller Stellar account address: expected a valid G... strkey, got "${String(caller)}"`,
        "caller",
      );
    }
    assertValidIntentHash(options.intentHash);

    const signFn = options.sign ?? (keypair ? (tx: Transaction) => tx.sign(keypair) : undefined);
    if (!signFn) {
      throw new PerihelionValidationError(
        "submitCancelExpired requires either a signer Keypair/secret or a sign callback",
        "signer",
      );
    }

    if (
      typeof this.rpc.getAccount !== "function" ||
      typeof this.rpc.sendTransaction !== "function" ||
      typeof this.rpc.getTransaction !== "function"
    ) {
      throw new PerihelionValidationError(
        "submitCancelExpired requires an rpc client with getAccount, sendTransaction, and getTransaction",
        "rpc",
      );
    }

    let resolvedLzFee = options.lzFee;
    if (resolvedLzFee !== undefined) {
      if (typeof resolvedLzFee !== "bigint" || resolvedLzFee < 0n) {
        throw new PerihelionValidationError(
          `Invalid lzFee: expected a non-negative bigint, got ${String(resolvedLzFee)}`,
          "lzFee",
        );
      }
    } else {
      let dstEid = options.dstEid;
      if (dstEid === undefined) {
        const record = await this.getIntent(options.intentHash);
        if (!record) {
          throw decodeSettlementError(140, "cancel_expired_intent");
        }
        dstEid = record.srcEid;
      }
      const quoted = await this.quoteCancelFee(dstEid);
      resolvedLzFee = quoted + (options.lzFeeBufferStroops ?? 0n);
    }

    const initialAccount = await this.rpc.getAccount(caller);
    let activeSequence = initialAccount.sequenceNumber();
    let restoredOnce = false;

    return submitWithFeeEscalation({
      rpc: this.rpc as unknown as SorobanRpc.Server,
      signerPublicKey: caller,
      sequence: activeSequence,
      policy: options.policy,
      submitOptions: options.submitOptions,
      logger: options.logger,
      prepare: async (_attemptAccount, inclusionFeeStroops) => {
        return this.buildCancelExpiredTx({
          caller,
          intentHash: options.intentHash,
          lzFee: resolvedLzFee,
          account: new Account(caller, activeSequence),
          fee: inclusionFeeStroops,
          timeoutSeconds: options.timeoutSeconds,
          simulate: true,
          onRestorePreamble:
            options.restoreFootprint === false
              ? undefined
              : async (preamble) => {
                  if (restoredOnce) return;
                  restoredOnce = true;
                  const restoreTx = this.buildRestoreFootprintTx(
                    new Account(caller, activeSequence),
                    preamble,
                    { timeoutSeconds: options.timeoutSeconds },
                  );
                  signFn(restoreTx);
                  await submitAndWait(
                    this.rpc as unknown as SorobanRpc.Server,
                    restoreTx,
                    options.submitOptions,
                  );
                  // RestoreFootprint consumed a sequence number; refresh or advance sequence.
                  const refreshed = await this.rpc.getAccount!(caller);
                  const refreshedSeq = refreshed.sequenceNumber();
                  activeSequence =
                    refreshedSeq !== activeSequence
                      ? refreshedSeq
                      : String(BigInt(activeSequence) + 1n);
                },
        });
      },
      sign: signFn,
    });
  }

  /**
   * Simulate a read-only contract view call using a static zero-sequence dummy
   * `Account`. Never calls `rpc.getAccount`.
   */
  private async simulateView(
    method: string,
    args: readonly xdr.ScVal[],
  ): Promise<xdr.ScVal | undefined> {
    const dummyAccount = new Account(this.sourceAccountId, "0");
    const tx = new TransactionBuilder(dummyAccount, {
      fee: this.defaultFeeStroops,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(this.contract.call(method, ...args))
      .setTimeout(this.timeoutSeconds)
      .build();

    const simulated = await this.rpc.simulateTransaction(tx);
    if (!simulated) {
      throw new PerihelionError(`[Perihelion] ${method} simulation returned empty response`);
    }
    if ("error" in simulated && simulated.error) {
      throw decodeSettlementError(simulated.error, method);
    }
    if (
      !SorobanRpc.Api.isSimulationSuccess(simulated) &&
      !("result" in simulated && simulated.result)
    ) {
      throw decodeSettlementError(
        (simulated as { error?: unknown })?.error ?? "missing simulation result",
        method,
      );
    }
    return (simulated as { result?: { retval?: xdr.ScVal } }).result?.retval;
  }
}
