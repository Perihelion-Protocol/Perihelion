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

  const host = env.PERIHELION_MEMPOOL_HOST ?? "localhost";

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

  const statusToken = env.PERIHELION_MEMPOOL_STATUS_TOKEN || undefined;

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
  };
}
