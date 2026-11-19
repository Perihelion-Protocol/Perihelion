// SPDX-License-Identifier: MIT

/** Load executor configuration from environment variables. */

import type { ExecutorConfig } from "./executor.js";
import { getAddress, isAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const EXECUTOR_ENV_KEYS = [
  "PERIHELION_EVM_RPC_URL",
  "PERIHELION_SOROBAN_RPC_URL",
  "PERIHELION_STELLAR_RPC_URL",
  "PERIHELION_EVM_PRIVATE_KEY",
  "PERIHELION_SOROBAN_SECRET_KEY",
  "PERIHELION_ESCROW_ADDRESS",
  "PERIHELION_SETTLEMENT_CONTRACT_ID",
  "PERIHELION_SETTLEMENT_CONTRACT",
  "PERIHELION_SOURCE_CHAIN_ID",
] as const;

/** Read a setting, preferring the unified name and warning on legacy names. */
function readWithLegacy(
  env: NodeJS.ProcessEnv,
  primary: string,
  legacy: string,
  errors: string[],
): string {
  const primaryValue = (env[primary] ?? "").trim();
  const legacyValue = (env[legacy] ?? "").trim();
  if (primaryValue) {
    if (legacyValue && legacyValue !== primaryValue) {
      errors.push(
        `${legacy} is deprecated and conflicts with ${primary}; remove ${legacy} and keep only ${primary}`,
      );
    } else if (legacyValue) {
      console.warn(
        `[config] ${legacy} is deprecated; use ${primary} instead`,
      );
    }
    return primaryValue;
  }
  if (legacyValue) {
    console.warn(`[config] ${legacy} is deprecated; use ${primary} instead`);
    return legacyValue;
  }
  return "";
}

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

  const sorobanRpcUrl = readWithLegacy(
    env,
    "PERIHELION_SOROBAN_RPC_URL",
    "PERIHELION_STELLAR_RPC_URL",
    errors,
  );
  if (!sorobanRpcUrl) {
    errors.push(
      "PERIHELION_SOROBAN_RPC_URL is required (legacy alias: PERIHELION_STELLAR_RPC_URL)",
    );
  }

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

  const settlementContractId = readWithLegacy(
    env,
    "PERIHELION_SETTLEMENT_CONTRACT_ID",
    "PERIHELION_SETTLEMENT_CONTRACT",
    errors,
  );
  if (!settlementContractId) {
    errors.push(
      "PERIHELION_SETTLEMENT_CONTRACT_ID is required (legacy alias: PERIHELION_SETTLEMENT_CONTRACT)",
    );
  }

  const stellarNetwork = env.STELLAR_NETWORK ?? "";
  if (!stellarNetwork) errors.push("STELLAR_NETWORK is required");

  const rawSourceChainId = (env.PERIHELION_SOURCE_CHAIN_ID ?? "").trim();
  const sourceChainId = Number(rawSourceChainId);
  if (!rawSourceChainId) {
    errors.push("PERIHELION_SOURCE_CHAIN_ID is required");
  } else if (!Number.isInteger(sourceChainId) || sourceChainId <= 0) {
    errors.push(
      `PERIHELION_SOURCE_CHAIN_ID must be a positive integer, got: "${rawSourceChainId}"`,
    );
  }

  // The solver address used for eligibility checks must match the key that
  // signs lock transactions, otherwise reserved intents are mis-attributed.
  const configuredSolverAddress = (env.PERIHELION_SOLVER_ADDRESS ?? "").trim();
  if (configuredSolverAddress && evmPrivateKey.startsWith("0x")) {
    let derivedAddress: string | undefined;
    try {
      derivedAddress = privateKeyToAccount(evmPrivateKey as Hex).address;
    } catch {
      errors.push("PERIHELION_EVM_PRIVATE_KEY is not a valid EVM private key");
    }
    if (derivedAddress) {
      if (!isAddress(configuredSolverAddress)) {
        errors.push(
          `PERIHELION_SOLVER_ADDRESS must be a 0x-prefixed 20-byte EVM address, got: "${configuredSolverAddress}"`,
        );
      } else if (
        getAddress(configuredSolverAddress) !== getAddress(derivedAddress)
      ) {
        errors.push(
          `PERIHELION_SOLVER_ADDRESS (${getAddress(configuredSolverAddress)}) does not match the address derived from PERIHELION_EVM_PRIVATE_KEY (${getAddress(derivedAddress)})`,
        );
      }
    }
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
    stellarNetwork,
    lzFeeBufferBps,
    registrationPollIntervalMs,
    minFillHeadroomSecs,
  };
}

/**
 * Parse an optional non-negative integer env var, falling back to `fallback`
 * when unset/blank. Invalid values are recorded in `errors` and the fallback
 * is returned so the consolidated error message can list every problem.
 */
function parseNonNegativeInteger(
  raw: string | undefined,
  fallback: number,
  name: string,
  errors: string[],
): number {
  const trimmed = (raw ?? "").trim();
  if (trimmed === "") return fallback;
  const value = Number(trimmed);
  if (!Number.isInteger(value) || value < 0) {
    errors.push(`${name} must be a non-negative integer, got: "${trimmed}"`);
    return fallback;
  }
  return value;
}
