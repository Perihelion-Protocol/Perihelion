/** Load executor configuration from environment variables. */

import type { ExecutorConfig } from "./executor.js";
import { getAddress, type Hex } from "viem";

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
 */
export function loadExecutorConfig(
  env: NodeJS.ProcessEnv = process.env,
): ExecutorConfig {
  const evmRpcUrl = env.PERIHELION_EVM_RPC_URL;
  if (!evmRpcUrl) {
    throw new Error("PERIHELION_EVM_RPC_URL not set");
  }

  const sorobanRpcUrl = env.PERIHELION_SOROBAN_RPC_URL;
  if (!sorobanRpcUrl) {
    throw new Error("PERIHELION_SOROBAN_RPC_URL not set");
  }

  const evmPrivateKey = env.PERIHELION_EVM_PRIVATE_KEY;
  if (!evmPrivateKey) {
    throw new Error("PERIHELION_EVM_PRIVATE_KEY not set");
  }
  if (!evmPrivateKey.startsWith("0x")) {
    throw new Error("PERIHELION_EVM_PRIVATE_KEY must start with 0x");
  }

  const sorobanSecretKey = env.PERIHELION_SOROBAN_SECRET_KEY;
  if (!sorobanSecretKey) {
    throw new Error("PERIHELION_SOROBAN_SECRET_KEY not set");
  }

  const escrowAddress = env.PERIHELION_ESCROW_ADDRESS;
  if (!escrowAddress) {
    throw new Error("PERIHELION_ESCROW_ADDRESS not set");
  }

  const settlementContractId = env.PERIHELION_SETTLEMENT_CONTRACT_ID;
  if (!settlementContractId) {
    throw new Error("PERIHELION_SETTLEMENT_CONTRACT_ID not set");
  }

  const sourceChainId = Number(env.PERIHELION_SOURCE_CHAIN_ID ?? 1);
  if (sourceChainId <= 0) {
    throw new Error("PERIHELION_SOURCE_CHAIN_ID must be a positive number");
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
