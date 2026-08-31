// SPDX-License-Identifier: MIT

/** Load executor configuration from environment variables. */

import type { ExecutorConfig } from "./executor.js";
import { getAddress, isAddress, type Hex } from "viem";

const EXECUTOR_ENV_KEYS = [
  "PERIHELION_EVM_RPC_URL",
  "PERIHELION_SOROBAN_RPC_URL",
  "PERIHELION_EVM_PRIVATE_KEY",
  "PERIHELION_SOROBAN_SECRET_KEY",
  "PERIHELION_ESCROW_ADDRESS",
  "PERIHELION_SETTLEMENT_CONTRACT_ID",
  "PERIHELION_SOURCE_CHAIN_ID",
] as const;

/**
 * Return true when any executor-specific configuration has been provided.
 * This lets the solver start in a non-executing mode until the real executor
 * is enabled and configured for a given deployment.
 */
export function hasExecutorConfig(env: NodeJS.ProcessEnv = process.env): boolean {
  return EXECUTOR_ENV_KEYS.some((key) => (env[key] ?? "").trim() !== "");
}

/**
 * Build executor config from `process.env`.
 * Required env vars:
 * - PERIHELION_EVM_RPC_URL: EVM RPC endpoint
 * - PERIHELION_SOROBAN_RPC_URL: Soroban RPC endpoint
 * - PERIHELION_EVM_PRIVATE_KEY: EVM private key (0x-prefixed)
 * - PERIHELION_SOROBAN_SECRET_KEY: Soroban secret key (strkey)
 * - PERIHELION_ESCROW_ADDRESS: EVM escrow contract address
 * - PERIHELION_SETTLEMENT_CONTRACT_ID: Soroban settlement contract ID
 * - PERIHELION_SOURCE_CHAIN_ID: Source EVM chain ID (1, 8453, etc.)
 *
 * Throws a single consolidated error listing every missing/invalid variable.
 */
export function loadExecutorConfig(
  env: NodeJS.ProcessEnv = process.env,
): ExecutorConfig {
  const errors: string[] = [];

  const evmRpcUrl = env.PERIHELION_EVM_RPC_URL ?? "";
  if (!evmRpcUrl) errors.push("PERIHELION_EVM_RPC_URL is required");

  const sorobanRpcUrl = env.PERIHELION_SOROBAN_RPC_URL ?? "";
  if (!sorobanRpcUrl) errors.push("PERIHELION_SOROBAN_RPC_URL is required");

  const evmPrivateKey = env.PERIHELION_EVM_PRIVATE_KEY ?? "";
  if (!evmPrivateKey) {
    errors.push("PERIHELION_EVM_PRIVATE_KEY is required");
  } else if (!evmPrivateKey.startsWith("0x")) {
    errors.push("PERIHELION_EVM_PRIVATE_KEY must start with 0x");
  }

  const sorobanSecretKey = env.PERIHELION_SOROBAN_SECRET_KEY ?? "";
  if (!sorobanSecretKey) errors.push("PERIHELION_SOROBAN_SECRET_KEY is required");

  const escrowAddress = env.PERIHELION_ESCROW_ADDRESS ?? "";
  if (!escrowAddress) {
    errors.push("PERIHELION_ESCROW_ADDRESS is required");
  } else if (!isAddress(escrowAddress)) {
    errors.push(
      `PERIHELION_ESCROW_ADDRESS must be a 0x-prefixed 20-byte EVM address, got: "${escrowAddress}"`,
    );
  }

  const settlementContractId = env.PERIHELION_SETTLEMENT_CONTRACT_ID ?? "";
  if (!settlementContractId) errors.push("PERIHELION_SETTLEMENT_CONTRACT_ID is required");

  const sourceChainId = Number(env.PERIHELION_SOURCE_CHAIN_ID ?? 1);
  if (!Number.isInteger(sourceChainId) || sourceChainId <= 0) {
    errors.push(
      `PERIHELION_SOURCE_CHAIN_ID must be a positive integer, got: "${env.PERIHELION_SOURCE_CHAIN_ID}"`,
    );
  }

  if (errors.length > 0) {
    throw new Error(
      `Executor configuration error — fix the following before starting:\n  • ${errors.join("\n  • ")}`,
    );
  }

  return {
    evmRpcUrl,
    sorobanRpcUrl,
    evmPrivateKey: evmPrivateKey as Hex,
    sorobanSecretKey,
    escrowAddress: getAddress(escrowAddress),
    settlementContractId,
    sourceChainId,
  };
}
