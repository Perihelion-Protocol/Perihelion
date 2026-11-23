// SPDX-License-Identifier: MIT

import { noopLogger, type Logger } from "@perihelion/node-common";
import { isValidEd25519SecretSeed } from "./strkey.js";

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
  /** Stellar transaction timeout in seconds. Defaults to 30. */
  readonly txTimeoutSeconds?: number;
  /** Path of the JSON file that persists the relay cursor. */
  readonly checkpointFile: string;
  /** Path of the JSON file that persists dead-lettered messages. */
  readonly deadLetterFile: string;
  /** TCP port of the health / readiness / metrics server. Defaults to 8080. */
  readonly healthPort: number;
  /** Interface the health server binds to. Defaults to 127.0.0.1. */
  readonly healthHost: string;
  /** Bearer token required for `/metrics`, when set. */
  readonly metricsToken?: string;
  /** Milliseconds since the last successful tick before `/readyz` fails. Defaults to 3 × pollIntervalMs. */
  readonly readinessStaleMs: number;
  /** Maximum cursor lag, in blocks, before `/readyz` fails. Defaults to 500. */
  readonly maxLagBlocks: number;
  /**
   * Relayer operating mode.  `"dev"` (the default) runs the development-only
   * stand-in for the LayerZero executor, which signs `lz_receive` directly as
   * the settlement contract's configured `Endpoint`.  `"executor"` is reserved
   * for the production design, where the relayer is a permissionless executor
   * calling a real LayerZero endpoint/adapter and its key carries no authority.
   */
  readonly relayerMode: RelayerMode;
  /**
   * Explicit override that permits endpoint-impersonation mode (`"dev"`)
   * against a public network (Pubnet).  Without it, the relayer refuses to
   * start in `"dev"` mode when {@link stellarNetwork} is Pubnet.
   */
  readonly allowEndpointImpersonation: boolean;
}

/** Supported relayer operating modes. */
export type RelayerMode = "dev" | "executor";

/** Stellar Pubnet network passphrase. */
export const PUBNET_PASSPHRASE = "Public Global Stellar Network ; September 2015";

/** Accepted truthy values for boolean environment flags. */
const TRUTHY_RE = /^(1|true|yes|on)$/i;

/** Largest LayerZero endpoint id: endpoint ids are uint32 on-chain. */
const MAX_ENDPOINT_ID = 0xffff_ffff;

/**
 * Parse a base-10 integer from an environment value. Only ASCII digits are
 * accepted, so fractions ("1.5"), exponents ("1e3"), signs and empty strings
 * are rejected. Returns undefined when the value is not an integer in
 * [min, max].
 */
function parseIntegerInRange(raw: string, min: number, max: number): number | undefined {
  if (!/^\d+$/.test(raw)) return undefined;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= min && value <= max ? value : undefined;
}

/**
 * Read an optional integer setting. Falls back to `fallback` when unset and
 * records an error naming the variable when the value is malformed.
 */
function readIntegerEnv(
  errors: string[],
  name: string,
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (raw === undefined) return fallback;
  const value = parseIntegerInRange(raw, min, max);
  if (value === undefined) {
    errors.push(`${name} must be an integer between ${min} and ${max}, got: "${raw}"`);
    return fallback;
  }
  return value;
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
 * Emit a one-time deprecation warning for an environment variable that has
 * been renamed.  The old name keeps working for one release.
 */
function warnDeprecated(oldName: string, newName: string, log: Pick<Logger, "warn">): void {
  log.warn(
    `[perihelion] ${oldName} is deprecated and will be removed in a future release; use ${newName} instead.`,
  );
}

/**
 * Build config from `process.env`, applying sensible defaults.
 * Throws a descriptive error and exits if required vars are missing or
 * any value is malformed/NaN.
 */
export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  log: Pick<Logger, "warn"> = noopLogger,
): RelayerConfig {
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
  // Preferred name is PERIHELION_SETTLEMENT_CONTRACT_ID; the old
  // PERIHELION_SETTLEMENT_CONTRACT is accepted as a deprecated alias.
  const settlementContractId =
    env.PERIHELION_SETTLEMENT_CONTRACT_ID ?? env.PERIHELION_SETTLEMENT_CONTRACT ?? "";
  if (!settlementContractId) {
    errors.push(
      "PERIHELION_SETTLEMENT_CONTRACT_ID is required (deprecated alias: PERIHELION_SETTLEMENT_CONTRACT)",
    );
  } else if (!SOROBAN_CONTRACT_RE.test(settlementContractId)) {
    errors.push(
      `PERIHELION_SETTLEMENT_CONTRACT_ID must be a valid Soroban contract id (C…, 56 chars), got: "${settlementContractId}"`,
    );
  }
  if (!env.PERIHELION_SETTLEMENT_CONTRACT_ID && env.PERIHELION_SETTLEMENT_CONTRACT) {
    warnDeprecated("PERIHELION_SETTLEMENT_CONTRACT", "PERIHELION_SETTLEMENT_CONTRACT_ID", log);
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
  // Preferred name is PERIHELION_SOROBAN_RPC_URL; the old
  // PERIHELION_STELLAR_RPC_URL is accepted as a deprecated alias.
  const stellarRpcUrl = env.PERIHELION_SOROBAN_RPC_URL ?? env.PERIHELION_STELLAR_RPC_URL ?? "";
  if (!stellarRpcUrl) {
    errors.push(
      "PERIHELION_SOROBAN_RPC_URL is required (deprecated alias: PERIHELION_STELLAR_RPC_URL)",
    );
  } else {
    try {
      validateUrl(stellarRpcUrl, "PERIHELION_SOROBAN_RPC_URL");
    } catch (err) {
      errors.push(String(err));
    }
  }
  if (!env.PERIHELION_SOROBAN_RPC_URL && env.PERIHELION_STELLAR_RPC_URL) {
    warnDeprecated("PERIHELION_STELLAR_RPC_URL", "PERIHELION_SOROBAN_RPC_URL", log);
  }

  // --- Required: source EID (uint32 LayerZero endpoint id) ---
  const parsedSourceEid = parseIntegerInRange(env.PERIHELION_SOURCE_EID ?? "", 1, MAX_ENDPOINT_ID);
  if (parsedSourceEid === undefined) {
    errors.push(
      `PERIHELION_SOURCE_EID is required and must be a positive integer no greater than ${MAX_ENDPOINT_ID}` +
        (env.PERIHELION_SOURCE_EID ? `, got: "${env.PERIHELION_SOURCE_EID}"` : ""),
    );
  }
  const sourceEid = parsedSourceEid ?? 0;

  // --- Required: stellar EID (uint32 LayerZero endpoint id) ---
  const parsedStellarEid = parseIntegerInRange(
    env.PERIHELION_STELLAR_EID ?? "",
    1,
    MAX_ENDPOINT_ID,
  );
  if (parsedStellarEid === undefined) {
    errors.push(
      `PERIHELION_STELLAR_EID is required and must be a positive integer no greater than ${MAX_ENDPOINT_ID}` +
        (env.PERIHELION_STELLAR_EID ? `, got: "${env.PERIHELION_STELLAR_EID}"` : ""),
    );
  }
  const stellarEid = parsedStellarEid ?? 0;

  // --- Required: Stellar network passphrase ---
  const stellarNetwork = env.STELLAR_NETWORK ?? "";
  if (!stellarNetwork) {
    errors.push("STELLAR_NETWORK is required");
  }

  // --- Required: signer secret (Stellar S… format) ---
  const signerSecret = env.SIGNER_SECRET ?? "";
  if (!signerSecret) {
    errors.push("SIGNER_SECRET is required");
  } else if (!STELLAR_SECRET_RE.test(signerSecret) || !isValidEd25519SecretSeed(signerSecret)) {
    errors.push(
      "SIGNER_SECRET must be a valid Stellar secret key (S…, 56 chars, with a valid checksum)",
    );
  }

  // --- Optional with sane defaults but must not be NaN/negative if set ---
  const confirmations = Number(env.PERIHELION_CONFIRMATIONS ?? 6);
  if (Number.isNaN(confirmations) || confirmations < 0 || !Number.isInteger(confirmations)) {
    errors.push(
      `PERIHELION_CONFIRMATIONS must be a non-negative integer, got: "${env.PERIHELION_CONFIRMATIONS}"`,
    );
  }

  const pollIntervalMs = readIntegerEnv(
    errors,
    "PERIHELION_POLL_INTERVAL_MS",
    env.PERIHELION_POLL_INTERVAL_MS,
    5_000,
    1,
    Number.MAX_SAFE_INTEGER,
  );

  const startBlock = readIntegerEnv(
    errors,
    "PERIHELION_START_BLOCK",
    env.PERIHELION_START_BLOCK,
    0,
    0,
    Number.MAX_SAFE_INTEGER,
  );

  const txTimeoutSeconds = Number(env.PERIHELION_TX_TIMEOUT_SECONDS ?? 30);
  if (
    Number.isNaN(txTimeoutSeconds) ||
    txTimeoutSeconds <= 0 ||
    !Number.isInteger(txTimeoutSeconds)
  ) {
    errors.push(
      `PERIHELION_TX_TIMEOUT_SECONDS must be a positive integer, got: "${env.PERIHELION_TX_TIMEOUT_SECONDS}"`,
    );
  }

  const checkpointFile = env.PERIHELION_CHECKPOINT_FILE || "./.perihelion-relayer-checkpoint.json";
  const deadLetterFile =
    env.PERIHELION_DEAD_LETTER_FILE || "./.perihelion-relayer-dead-letter.json";

  const healthPort = Number(env.PERIHELION_HEALTH_PORT ?? 8080);
  if (!Number.isInteger(healthPort) || healthPort < 1 || healthPort > 65_535) {
    errors.push(
      `PERIHELION_HEALTH_PORT must be an integer between 1 and 65535, got: "${env.PERIHELION_HEALTH_PORT}"`,
    );
  }

  const healthHost = env.PERIHELION_HEALTH_HOST || "127.0.0.1";
  const metricsToken = env.PERIHELION_METRICS_TOKEN || undefined;

  const readinessStaleMs = Number(env.PERIHELION_READINESS_STALE_MS ?? pollIntervalMs * 3);
  if (!Number.isInteger(readinessStaleMs) || readinessStaleMs <= 0) {
    errors.push(
      `PERIHELION_READINESS_STALE_MS must be a positive integer, got: "${env.PERIHELION_READINESS_STALE_MS}"`,
    );
  }

  const maxLagBlocks = Number(env.PERIHELION_MAX_LAG_BLOCKS ?? 500);
  if (!Number.isInteger(maxLagBlocks) || maxLagBlocks < 0) {
    errors.push(
      `PERIHELION_MAX_LAG_BLOCKS must be a non-negative integer, got: "${env.PERIHELION_MAX_LAG_BLOCKS}"`,
    );
  }

  // --- Relayer mode (defaults to the development-only stand-in) ---
  const rawRelayerMode = (env.PERIHELION_RELAYER_MODE ?? "dev").trim().toLowerCase();
  let relayerMode: RelayerMode = "dev";
  if (rawRelayerMode === "dev" || rawRelayerMode === "executor") {
    relayerMode = rawRelayerMode;
  } else {
    errors.push(
      `PERIHELION_RELAYER_MODE must be "dev" or "executor", got: "${env.PERIHELION_RELAYER_MODE}"`,
    );
  }

  // --- Explicit override for endpoint impersonation on a public network ---
  const allowEndpointImpersonation = TRUTHY_RE.test(
    (env.PERIHELION_ALLOW_ENDPOINT_IMPERSONATION ?? "").trim(),
  );

  // --- Network gate: refuse endpoint impersonation against Pubnet ---
  if (
    relayerMode === "dev" &&
    stellarNetwork === PUBNET_PASSPHRASE &&
    !allowEndpointImpersonation
  ) {
    errors.push(
      "PERIHELION_RELAYER_MODE=dev impersonates the settlement contract's Endpoint and is " +
        "development-only; refusing to start against Pubnet. Set " +
        "PERIHELION_ALLOW_ENDPOINT_IMPERSONATION=true to override (unsafe), or use a real " +
        "LayerZero endpoint/adapter (PERIHELION_RELAYER_MODE=executor).",
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
    txTimeoutSeconds,
    checkpointFile,
    deadLetterFile,
    healthPort,
    healthHost,
    metricsToken,
    readinessStaleMs,
    maxLagBlocks,
    relayerMode,
    allowEndpointImpersonation,
  };
}
