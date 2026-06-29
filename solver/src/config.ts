/** Solver runtime configuration, loaded from environment variables. */

import { zeroAddress, type Address } from "viem";

export interface SolverConfig {
  /** Base URL of the Perihelion mempool API to poll. */
  readonly mempoolUrl: string;
  /** This solver's EVM address (used to claim `preferredSolver` intents). */
  readonly solverAddress: Address;
  /** EVM chain ID the escrow is deployed on (required for signature verification). */
  readonly sourceChainId: number;
  /** Address of the PerihelionEscrow contract (required for signature verification). */
  readonly escrowAddress: Address;
  /** Minimum profit, in basis points of source amount, required to fill. */
  readonly minMarginBps: number;
  /** How often to poll the mempool, in milliseconds. */
  readonly pollIntervalMs: number;
  /** Stellar assets this solver is willing to provide liquidity for. */
  readonly supportedDestAssets: readonly string[];
  /** Maximum number of verification results to cache (LRU eviction). Defaults to 10,000. */
  readonly verificationCacheSize?: number;
}

/** Build config from `process.env`, applying sensible defaults. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): SolverConfig {
  return {
    mempoolUrl: env.PERIHELION_MEMPOOL_URL ?? "http://localhost:8080",
    solverAddress: (env.PERIHELION_SOLVER_ADDRESS as Address) ?? zeroAddress,
    sourceChainId: Number(env.PERIHELION_SOURCE_CHAIN_ID ?? 8453),
    escrowAddress: (env.PERIHELION_ESCROW_ADDRESS as Address) ?? zeroAddress,
    minMarginBps: Number(env.PERIHELION_MIN_MARGIN_BPS ?? 15),
    pollIntervalMs: Number(env.PERIHELION_POLL_INTERVAL_MS ?? 2_000),
    supportedDestAssets: (env.PERIHELION_SUPPORTED_ASSETS ?? "native")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    verificationCacheSize: Number(env.PERIHELION_VERIFICATION_CACHE_SIZE ?? 10_000),
  };
}
