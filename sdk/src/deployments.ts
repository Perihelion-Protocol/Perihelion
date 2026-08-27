// SPDX-License-Identifier: MIT

/**
 * PerihelionEscrow deployment addresses by chain ID.
 *
 * This map is the source of truth for escrow addresses across all deployed chains.
 * It mirrors `docs/deployment.md` and is kept in sync by CI during deployments.
 *
 * Format: chainId → escrow address (0x-prefixed, checksummed).
 */

import type { Address } from "./types.js";

export const DEPLOYMENTS: Readonly<Record<number, Address>> = {
  // Placeholder deployments — update with actual addresses as chains deploy.
  // 1: "0x..." as Address,  // Ethereum mainnet
  // 8453: "0x..." as Address,  // Base mainnet
  // 42161: "0x..." as Address,  // Arbitrum One
};

/**
 * Get the escrow address for a given chain ID.
 *
 * @param chainId The EVM chain ID.
 * @returns The escrow address, or undefined if not deployed on this chain.
 */
export function getEscrowAddress(chainId: number): Address | undefined {
  return DEPLOYMENTS[chainId];
}
