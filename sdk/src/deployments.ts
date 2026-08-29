// SPDX-License-Identifier: MIT

/**
 * PerihelionEscrow deployment addresses by chain ID.
 *
 * Perihelion is pre-deployment: no chain has a live escrow yet, so this map
 * is intentionally empty. There is no automated sync — an entry is added by
 * hand, in the same PR that records the address in `docs/deployment.md`
 * (§4.4), once a chain's escrow is deployed.
 *
 * Format: chainId → escrow address (0x-prefixed, checksummed).
 */

import type { Address } from "./types.js";
import { PerihelionValidationError } from "./errors.js";

export const DEPLOYMENTS: Readonly<Record<number, Address>> = {
  // 1: "0x..." as Address,  // Ethereum mainnet
  // 8453: "0x..." as Address,  // Base mainnet
  // 42161: "0x..." as Address,  // Arbitrum One
};

/**
 * Get the escrow address for a given chain ID.
 *
 * @param chainId The EVM chain ID.
 * @returns The escrow address.
 * @throws {@link PerihelionValidationError} if no escrow is recorded for `chainId`
 *   — either the chain has no deployment yet, or `DEPLOYMENTS` hasn't been
 *   updated for it. Callers must not treat an unknown chain as a silent default.
 */
export function getEscrowAddress(chainId: number): Address {
  const address = DEPLOYMENTS[chainId];
  if (!address) {
    throw new PerihelionValidationError(
      `[Perihelion] No escrow deployment recorded for chain id ${chainId}. ` +
        `DEPLOYMENTS is populated manually as chains go live; see docs/deployment.md.`,
      "chainId",
    );
  }
  return address;
}
