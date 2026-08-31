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
  /**
   * Estimated source-chain native cost of one fill, in wei (gas for
   * `PerihelionEscrow.lock` plus its LayerZero message fee). Used as the floor
   * the solver's source-chain native balance is checked against at decision
   * time when no live per-fill estimator is wired. Default `0` (check disabled
   * until configured or an estimator is supplied).
   */
  readonly sourceNativeFeeFloor: bigint;
  /**
   * Estimated Stellar native cost of one fill, in stroops (`deliver_intent`
   * plus `dispatch_confirmation`, including its `lz_fee`). Used as the floor
   * the solver's XLM balance is checked against at decision time. Default `0`
   * (check disabled until configured).
   */
  readonly stellarNativeFeeFloor: bigint;
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
   * Shared bearer token for the mempool's `PATCH /intents/:hash/status`
   * endpoint. When set, the solver reports `"settled"` after a successful
   * fill so the mempool record transitions out of `"pending"` immediately.
   * If omitted, status reporting is skipped (the mempool will evict the
   * record only after its deadline + grace period).
   */
  readonly mempoolStatusToken?: string;
}

/**
 * Parse a non-negative integer amount in an asset's smallest units (wei,
 * stroops) from an env var. Empty/unset yields `0n`. A negative or
 * non-integer value is pushed onto `errors` and yields `0n`.
 */
function parseNonNegativeBigInt(
  raw: string | undefined,
  name: string,
  errors: string[],
): bigint {
  if (raw === undefined || raw.trim() === "") return 0n;
  let value: bigint;
  try {
    value = BigInt(raw.trim());
  } catch {
    errors.push(`${name} must be a non-negative integer in smallest units, got: "${raw}"`);
    return 0n;
  }
  if (value < 0n) {
    errors.push(`${name} must be a non-negative integer in smallest units, got: "${raw}"`);
    return 0n;
  }
  return value;
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

  const sourceNativeFeeFloor = parseNonNegativeBigInt(
    env.PERIHELION_SOURCE_NATIVE_FEE_FLOOR,
    "PERIHELION_SOURCE_NATIVE_FEE_FLOOR",
    errors,
  );
  const stellarNativeFeeFloor = parseNonNegativeBigInt(
    env.PERIHELION_STELLAR_NATIVE_FEE_FLOOR,
    "PERIHELION_STELLAR_NATIVE_FEE_FLOOR",
    errors,
  );

  const supportedDestAssets = (env.PERIHELION_SUPPORTED_ASSETS ?? "native")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (supportedDestAssets.length === 0) {
    errors.push("PERIHELION_SUPPORTED_ASSETS must list at least one asset");
  }

  // --- Optional: status token for mempool PATCH /intents/:hash/status ---
  // Not validated beyond being a non-empty string when set — any non-empty
  // value is a valid bearer token.
  const mempoolStatusToken = env.PERIHELION_MEMPOOL_STATUS_TOKEN || undefined;

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
    sourceNativeFeeFloor,
    stellarNativeFeeFloor,
    pollIntervalMs,
    supportedDestAssets,
    verificationCacheSize,
    seenCacheSize,
    mempoolStatusToken,
  };
}
