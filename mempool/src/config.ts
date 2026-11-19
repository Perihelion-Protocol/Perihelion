// SPDX-License-Identifier: MIT

/** Mempool runtime configuration, loaded and validated from environment variables. */

import type { Address } from "@perihelion/sdk";

export interface MempoolConfig {
  /** TCP port the HTTP server binds. */
  readonly port: number;
  /** Interface the HTTP server binds. */
  readonly host: string;
  /** EVM chain ID the escrow is deployed on. Binds the EIP-712 domain. */
  readonly chainId: number;
  /** PerihelionEscrow contract address. Binds the EIP-712 domain. */
  readonly verifyingContract: Address;
  /** Shared bearer token for `PATCH /intents/:hash/status`, if configured. */
  readonly statusToken?: string;
  /** Bearer token required on `GET /metrics`, if configured. */
  readonly metricsToken?: string;
  /** Maximum number of intents retained in the store, if configured. */
  readonly maxStoreSize?: number;
  /** Grace period past expiry before an intent is pruned, in ms, if configured. */
  readonly expiryGraceMs?: number;
  /** Rate-limit window length in ms, if configured. */
  readonly rateLimitWindowMs?: number;
  /** Maximum writes per window per client, if configured. */
  readonly writeRateLimit?: number;
  /** Maximum reads per window per client, if configured. */
  readonly readRateLimit?: number;
}

/**
 * 0x-prefixed 20-byte EVM address. Mirrors the check the solver and relayer
 * apply to `PERIHELION_ESCROW_ADDRESS` — a bad escrow address binds the EIP-712
 * domain to a contract that does not exist, and every signed intent is then
 * rejected as "Invalid signature" with no hint that the server is misconfigured.
 */
const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

const MAX_PORT = 65_535;

/**
 * Parse an optional positive-integer env var. Returns `undefined` when unset or
 * empty; records an error and returns `undefined` when the value is not a
 * positive integer.
 */
function optionalPositiveInt(
  env: NodeJS.ProcessEnv,
  name: string,
  errors: string[],
): number | undefined {
  const raw = env[name];
  if (raw === undefined || raw === "") return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    errors.push(`${name} must be a positive integer, got: "${raw}"`);
    return undefined;
  }
  return value;
}

/**
 * Build config from `process.env`, applying defaults. Collects every problem
 * and throws once with all of them named, matching the shape `loadConfig` has
 * in the solver and relayer packages — so a misconfigured deploy fails fast at
 * startup instead of binding a random port or rejecting every submission.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): MempoolConfig {
  const errors: string[] = [];

  // --- Port: positive integer within the valid TCP range ---
  const portRaw = env.PORT ?? "3000";
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port < 1 || port > MAX_PORT) {
    errors.push(
      `PORT must be an integer between 1 and ${MAX_PORT}, got: "${portRaw}"`,
    );
  }

  // --- Bind host: mempool-specific name wins, then the shared names ---
  const host =
    env.PERIHELION_MEMPOOL_HOST ??
    env.PERIHELION_METRICS_HOST ??
    env.PERIHELION_HEALTH_HOST ??
    "localhost";

  // --- Required: source chain ID ---
  const chainIdRaw = env.PERIHELION_SOURCE_CHAIN_ID;
  const chainId = Number(chainIdRaw);
  if (!chainIdRaw) {
    errors.push("PERIHELION_SOURCE_CHAIN_ID is required");
  } else if (!Number.isInteger(chainId) || chainId <= 0) {
    errors.push(
      `PERIHELION_SOURCE_CHAIN_ID must be a positive integer, got: "${chainIdRaw}"`,
    );
  }

  // --- Required: escrow address ---
  const escrowAddress = env.PERIHELION_ESCROW_ADDRESS ?? "";
  if (!escrowAddress) {
    errors.push("PERIHELION_ESCROW_ADDRESS is required");
  } else if (!EVM_ADDRESS_RE.test(escrowAddress)) {
    errors.push(
      `PERIHELION_ESCROW_ADDRESS must be a 0x-prefixed 20-byte EVM address, got: "${escrowAddress}"`,
    );
  }

  // Status updates change what solvers and users see, so the endpoint must be
  // authenticated by default. A token-less server only starts when the operator
  // explicitly opts into insecure local development (#966).
  const statusToken = env.PERIHELION_MEMPOOL_STATUS_TOKEN || undefined;
  if (!statusToken && env.PERIHELION_MEMPOOL_INSECURE_DEV !== "1") {
    errors.push(
      "PERIHELION_MEMPOOL_STATUS_TOKEN is required: PATCH /intents/:hash/status must be authenticated. For local development only, set PERIHELION_MEMPOOL_INSECURE_DEV=1 to run without it",
    );
  }

  // --- Optional: store and rate-limit tuning ---
  const maxStoreSize = optionalPositiveInt(
    env,
    "PERIHELION_MEMPOOL_MAX_STORE_SIZE",
    errors,
  );
  const expiryGraceMs = optionalPositiveInt(
    env,
    "PERIHELION_MEMPOOL_EXPIRY_GRACE_MS",
    errors,
  );
  const rateLimitWindowMs = optionalPositiveInt(
    env,
    "PERIHELION_MEMPOOL_RATE_LIMIT_WINDOW_MS",
    errors,
  );
  const writeRateLimit = optionalPositiveInt(
    env,
    "PERIHELION_MEMPOOL_WRITE_RATE_LIMIT",
    errors,
  );
  const readRateLimit = optionalPositiveInt(
    env,
    "PERIHELION_MEMPOOL_READ_RATE_LIMIT",
    errors,
  );

  if (errors.length > 0) {
    throw new Error(
      `Mempool configuration error — fix the following before starting:\n  • ${errors.join("\n  • ")}`,
    );
  }

  return {
    port,
    host,
    chainId,
    verifyingContract: escrowAddress as Address,
    statusToken,
    metricsToken,
    maxStoreSize,
    expiryGraceMs,
    rateLimitWindowMs,
    writeRateLimit,
    readRateLimit,
  };
}
