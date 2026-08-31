// SPDX-License-Identifier: MIT

/** Solver runtime configuration, loaded from environment variables. */

import { isAddress, type Address } from "viem";

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
  /**
   * Maximum number of hashes to keep in the seen-set LRU cache.
   * Entries are also evicted by TTL (past-deadline) every tick.
   * Defaults to 50,000 (~7.5 MB worst-case).
   */
  readonly seenCacheSize?: number;
  /**
   * Maximum number of entries to keep in the retry-state LRU+TTL cache.
   *
   * Each entry is a 66-character hex key plus a small `{ attempts, nextRetryAt }`
   * object (≈ 150 bytes).  Entries are also evicted by TTL every tick (same
   * clamped-deadline policy as the seen-set), so the cache is bounded both by
   * capacity and by how long intents remain alive.  Defaults to 10,000.
   */
  readonly retryCacheSize?: number;
}

/**
 * Build config from `process.env`, applying sensible defaults.
 * Throws a descriptive error and exits if required vars are missing or
 * any value is malformed/NaN.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): SolverConfig {
  const errors: string[] = [];

  // --- Required: solver address ---
  const solverAddress = env.PERIHELION_SOLVER_ADDRESS ?? "";
  if (!solverAddress) {
    errors.push("PERIHELION_SOLVER_ADDRESS is required");
  } else if (!isAddress(solverAddress)) {
    errors.push(
      `PERIHELION_SOLVER_ADDRESS must be a 0x-prefixed 20-byte EVM address, got: "${solverAddress}"`,
    );
  }

  // --- Required: escrow address ---
  const escrowAddress = env.PERIHELION_ESCROW_ADDRESS ?? "";
  if (!escrowAddress) {
    errors.push("PERIHELION_ESCROW_ADDRESS is required");
  } else if (!isAddress(escrowAddress)) {
    errors.push(
      `PERIHELION_ESCROW_ADDRESS must be a 0x-prefixed 20-byte EVM address, got: "${escrowAddress}"`,
    );
  }

  // --- Optional with sane defaults but must not be NaN/out-of-range if set ---
  const sourceChainId = Number(env.PERIHELION_SOURCE_CHAIN_ID ?? 8453);
  if (!Number.isInteger(sourceChainId) || sourceChainId <= 0) {
    errors.push(
      `PERIHELION_SOURCE_CHAIN_ID must be a positive integer, got: "${env.PERIHELION_SOURCE_CHAIN_ID}"`,
    );
  }

  const minMarginBps = Number(env.PERIHELION_MIN_MARGIN_BPS ?? 15);
  if (!Number.isInteger(minMarginBps) || minMarginBps < 0 || minMarginBps > 10_000) {
    errors.push(
      `PERIHELION_MIN_MARGIN_BPS must be an integer between 0 and 10000, got: "${env.PERIHELION_MIN_MARGIN_BPS}"`,
    );
  }

  const pollIntervalMs = Number(env.PERIHELION_POLL_INTERVAL_MS ?? 2_000);
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs <= 0) {
    errors.push(
      `PERIHELION_POLL_INTERVAL_MS must be a positive integer, got: "${env.PERIHELION_POLL_INTERVAL_MS}"`,
    );
  }

  const verificationCacheSize = Number(env.PERIHELION_VERIFICATION_CACHE_SIZE ?? 10_000);
  if (!Number.isInteger(verificationCacheSize) || verificationCacheSize <= 0) {
    errors.push(
      `PERIHELION_VERIFICATION_CACHE_SIZE must be a positive integer, got: "${env.PERIHELION_VERIFICATION_CACHE_SIZE}"`,
    );
  }

  const seenCacheSize = Number(env.PERIHELION_SEEN_CACHE_SIZE ?? 50_000);
  if (!Number.isInteger(seenCacheSize) || seenCacheSize <= 0) {
    errors.push(
      `PERIHELION_SEEN_CACHE_SIZE must be a positive integer, got: "${env.PERIHELION_SEEN_CACHE_SIZE}"`,
    );
  }

  const retryCacheSize = Number(env.PERIHELION_RETRY_CACHE_SIZE ?? 10_000);
  if (!Number.isInteger(retryCacheSize) || retryCacheSize <= 0) {
    errors.push(
      `PERIHELION_RETRY_CACHE_SIZE must be a positive integer, got: "${env.PERIHELION_RETRY_CACHE_SIZE}"`,
    );
  }

  const supportedDestAssets = (env.PERIHELION_SUPPORTED_ASSETS ?? "native")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (supportedDestAssets.length === 0) {
    errors.push("PERIHELION_SUPPORTED_ASSETS must list at least one asset");
  }

  if (errors.length > 0) {
    throw new Error(
      `Solver configuration error — fix the following before starting:\n  • ${errors.join("\n  • ")}`,
    );
  }

  return {
    mempoolUrl: env.PERIHELION_MEMPOOL_URL ?? "http://localhost:3000",
    solverAddress: solverAddress as Address,
    sourceChainId,
    escrowAddress: escrowAddress as Address,
    minMarginBps,
    pollIntervalMs,
    supportedDestAssets,
    verificationCacheSize,
    seenCacheSize,
    retryCacheSize,
  };
}
