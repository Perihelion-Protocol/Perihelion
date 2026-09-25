// SPDX-License-Identifier: MIT

/**
 * Shared, complete, valid relayer configuration fixture.
 *
 * Every relayer test that needs a valid config should build it from here so
 * that adding a new required variable to `loadConfig` forces a single,
 * visible, intentional fixture update instead of breaking many tests.
 */

/** A well-formed Stellar `S…` strkey (regex-validated by config.ts). */
export const VALID_SIGNER_SECRET =
  "SBZVMB74Z76QB3ZL2YFBN7EWUIXVXSNXKNQRIPZTKMZDDQ3FJBNRHWBU";

export const VALID_ESCROW = "0xaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaA";
export const VALID_CONTRACT =
  "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFCT4";

/**
 * The complete set of environment variables `loadConfig` requires.
 *
 * Keep this in sync with `relayer/src/config.ts`; the `config.test.ts`
 * "requires the complete set of variables" test asserts against this list so
 * a new required variable cannot be added silently.
 */
export const REQUIRED_CONFIG_VARS = [
  "PERIHELION_ESCROW_ADDRESS",
  "PERIHELION_SETTLEMENT_CONTRACT",
  "PERIHELION_EVM_RPC_URL",
  "PERIHELION_STELLAR_RPC_URL",
  "PERIHELION_SOURCE_EID",
  "PERIHELION_STELLAR_EID",
  "STELLAR_NETWORK",
  "SIGNER_SECRET",
] as const;

/**
 * A complete, valid environment for `loadConfig`.
 *
 * Returns a fresh object each call so tests can mutate their copy freely.
 */
export function validConfigEnv(): Record<string, string> {
  return {
    PERIHELION_ESCROW_ADDRESS: VALID_ESCROW,
    PERIHELION_SETTLEMENT_CONTRACT: VALID_CONTRACT,
    PERIHELION_EVM_RPC_URL: "http://localhost:8545",
    PERIHELION_STELLAR_RPC_URL: "https://soroban-testnet.stellar.org",
    PERIHELION_SOURCE_EID: "30101",
    PERIHELION_STELLAR_EID: "40161",
    STELLAR_NETWORK: "Test SDF Network ; September 2015",
    SIGNER_SECRET: VALID_SIGNER_SECRET,
  };
}
