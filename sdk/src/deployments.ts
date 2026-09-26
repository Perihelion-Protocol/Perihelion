// SPDX-License-Identifier: MIT

import { Address } from "viem";

/**
 * Deployed Perihelion escrow addresses by chain ID.
 *
 * This map is the source of truth for escrow addresses across deployed chains.
 * See `docs/deployment.md` for the deployment procedure and address registration.
 *
 * Currently no chains are deployed. Use `getEscrowAddress` or `tryGetEscrowAddress`
 * to query this map with proper error handling.
 */
export const DEPLOYMENTS: Readonly<Record<number, Address>> = Object.freeze({
  // Deployments will be added here as chains go live.
  // See docs/deployment.md for the deployment procedure.
});

/**
 * Get the escrow address for a chain, throwing if not deployed.
 *
 * @param chainId - The EVM chain ID
 * @returns The escrow contract address
 * @throws UndeployedChainError if the chain is not deployed
 *
 * @example
 * ```ts
 * const escrowAddr = getEscrowAddress(8453); // Base mainnet
 * ```
 */
export function getEscrowAddress(chainId: number): Address {
  const address = DEPLOYMENTS[chainId];
  if (!address) {
    const error = new Error(
      `Chain ${chainId} is not deployed. See docs/deployment.md for deployment procedure and supported chains.`
    );
    error.name = "UndeployedChainError";
    throw error;
  }
  return address;
}

/**
 * Try to get the escrow address for a chain, returning undefined if not deployed.
 *
 * Use this when you need to distinguish "not deployed" from "configured but no address".
 *
 * @param chainId - The EVM chain ID
 * @returns The escrow contract address, or undefined if not deployed
 *
 * @example
 * ```ts
 * const escrowAddr = tryGetEscrowAddress(8453);
 * if (!escrowAddr) {
 *   console.log("Chain not deployed yet");
 * }
 * ```
 */
export function tryGetEscrowAddress(chainId: number): Address | undefined {
  return DEPLOYMENTS[chainId];
}
