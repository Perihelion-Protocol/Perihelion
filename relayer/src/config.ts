// SPDX-License-Identifier: MIT

/** Relayer runtime configuration, loaded from environment variables. */

export interface RelayerConfig {
  /** RPC endpoint for the EVM source chain. */
  readonly evmRpcUrl: string;
  /** Horizon / RPC endpoint for Stellar. */
  readonly stellarRpcUrl: string;
  /** Address of the EVM escrow contract emitting bridge messages. */
  readonly escrowAddress: string;
  /** Address of the Soroban settlement (OApp) contract. */
  readonly settlementContractId: string;
  /** Block confirmations to wait before relaying a source message. */
  readonly confirmations: number;
  /** Poll interval for new messages, milliseconds. */
  readonly pollIntervalMs: number;
  /** Starting block for initial poll (avoids scanning genesis). */
  readonly startBlock: number;
  /** EVM chain endpoint ID. */
  readonly sourceEid: number;
  /** Stellar chain endpoint ID. */
  readonly stellarEid: number;
  /** Stellar network passphrase (e.g., "Test SDF Network ; September 2015"). */
  readonly stellarNetwork: string;
  /** Stellar signing secret key (S… strkey format). */
  readonly signerSecret: string;
  /**
   * Base URL of the Perihelion mempool API.  When set together with
   * {@link mempoolStatusToken}, the relayer reports `"refunded"` to the
   * mempool after delivering a `CancelIntent` message.
   */
  readonly mempoolUrl?: string;
  /**
   * Shared bearer token for the mempool's `PATCH /intents/:hash/status`
   * endpoint.  Required (along with {@link mempoolUrl}) to enable
   * best-effort `"refunded"` reporting after `CancelIntent` delivery.
   */
  readonly mempoolStatusToken?: string;
}

/** 0x-prefixed 20-byte EVM address. */
const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
/** Soroban contract IDs start with 'C' and are 56 base-32 characters. */
const SOROBAN_CONTRACT_RE = /^C[A-Z2-7]{55}$/;
/** Stellar secret key starts with 'S' and is 56 base-32 characters. */
const STELLAR_SECRET_RE = /^S[A-Z2-7]{55}$/;

/**
 * Validate a URL string and return the URL object.
 * Throws if the URL is invalid.
 */
function validateUrl(value: string, name: string): URL {
  try {
    return new URL(value);
  } catch {
    throw new Error(`${name} must be a valid URL, got: "${value}"`);
  }
}

/**
 * Build config from `process.env`, applying sensible defaults.
 * Throws a descriptive error and exits if required vars are missing or
 * any value is malformed/NaN.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): RelayerConfig {
  const errors: string[] = [];

  // --- Required: escrow address ---
  const escrowAddress = env.PERIHELION_ESCROW_ADDRESS ?? "";
  if (!escrowAddress) {
    errors.push("PERIHELION_ESCROW_ADDRESS is required");
  } else if (!EVM_ADDRESS_RE.test(escrowAddress)) {
    errors.push(
      `PERIHELION_ESCROW_ADDRESS must be a 0x-prefixed 20-byte EVM address, got: "${escrowAddress}"`,
    );
  }

  // --- Required: settlement contract id ---
  const settlementContractId = env.PERIHELION_SETTLEMENT_CONTRACT ?? "";
  if (!settlementContractId) {
    errors.push("PERIHELION_SETTLEMENT_CONTRACT is required");
  } else if (!SOROBAN_CONTRACT_RE.test(settlementContractId)) {
    errors.push(
      `PERIHELION_SETTLEMENT_CONTRACT must be a valid Soroban contract id (C…, 56 chars), got: "${settlementContractId}"`,
    );
  }

  // --- Required: EVM RPC URL ---
  const evmRpcUrl = env.PERIHELION_EVM_RPC_URL ?? "";
  if (!evmRpcUrl) {
    errors.push("PERIHELION_EVM_RPC_URL is required");
  } else {
    try {
      validateUrl(evmRpcUrl, "PERIHELION_EVM_RPC_URL");
    } catch (err) {
      errors.push(String(err));
    }
  }

  // --- Required: Stellar RPC URL ---
  const stellarRpcUrl = env.PERIHELION_STELLAR_RPC_URL ?? "";
  if (!stellarRpcUrl) {
    errors.push("PERIHELION_STELLAR_RPC_URL is required");
  } else {
    try {
      validateUrl(stellarRpcUrl, "PERIHELION_STELLAR_RPC_URL");
    } catch (err) {
      errors.push(String(err));
    }
  }

  // --- Required: source EID (positive integer) ---
  const sourceEid = Number(env.PERIHELION_SOURCE_EID ?? "");
  if (!env.PERIHELION_SOURCE_EID || Number.isNaN(sourceEid) || sourceEid <= 0) {
    errors.push("PERIHELION_SOURCE_EID is required and must be a positive integer");
  }

  // --- Required: stellar EID (positive integer) ---
  const stellarEid = Number(env.PERIHELION_STELLAR_EID ?? "");
  if (!env.PERIHELION_STELLAR_EID || Number.isNaN(stellarEid) || stellarEid <= 0) {
    errors.push("PERIHELION_STELLAR_EID is required and must be a positive integer");
  }

  // --- Required: Stellar network passphrase ---
  const stellarNetwork = env.STELLAR_NETWORK ?? "";
  if (!stellarNetwork) {
    errors.push("STELLAR_NETWORK is required");
  }

  // --- Required: signer secret (Stellar S… format) ---
  const signerSecret = env.SIGNER_SECRET ?? "";
  if (!signerSecret) {
    errors.push("SIGNER_SECRET is required");
  } else if (!STELLAR_SECRET_RE.test(signerSecret)) {
    errors.push(
      `SIGNER_SECRET must be a valid Stellar secret key (S…, 56 chars), got: "${signerSecret.substring(0, 5)}…"`,
    );
  }

  // --- Optional with sane defaults but must not be NaN/negative if set ---
  const confirmations = Number(env.PERIHELION_CONFIRMATIONS ?? 6);
  if (Number.isNaN(confirmations) || confirmations < 0 || !Number.isInteger(confirmations)) {
    errors.push(
      `PERIHELION_CONFIRMATIONS must be a non-negative integer, got: "${env.PERIHELION_CONFIRMATIONS}"`,
    );
  }

  const pollIntervalMs = Number(env.PERIHELION_POLL_INTERVAL_MS ?? 5_000);
  if (Number.isNaN(pollIntervalMs) || pollIntervalMs <= 0) {
    errors.push(
      `PERIHELION_POLL_INTERVAL_MS must be a positive integer, got: "${env.PERIHELION_POLL_INTERVAL_MS}"`,
    );
  }

  const startBlock = Number(env.PERIHELION_START_BLOCK ?? 0);
  if (Number.isNaN(startBlock) || startBlock < 0) {
    errors.push(
      `PERIHELION_START_BLOCK must be a non-negative integer, got: "${env.PERIHELION_START_BLOCK}"`,
    );
  }

  if (errors.length > 0) {
    throw new Error(
      `Relayer configuration error — fix the following before starting:\n  • ${errors.join("\n  • ")}`,
    );
  }

  // --- Optional: mempool URL and status token ---
  const mempoolUrl = env.PERIHELION_MEMPOOL_URL || undefined;
  const mempoolStatusToken = env.PERIHELION_MEMPOOL_STATUS_TOKEN || undefined;

  return {
    evmRpcUrl,
    stellarRpcUrl,
    escrowAddress,
    settlementContractId,
    confirmations,
    pollIntervalMs,
    startBlock,
    sourceEid,
    stellarEid,
    stellarNetwork,
    signerSecret,
    mempoolUrl,
    mempoolStatusToken,
  };
}
