// SPDX-License-Identifier: MIT

/**
 * Library entry point for `@perihelion/solver`.
 *
 * Importing this module has no side effects: it only re-exports the public
 * API. The runnable solver node lives in `cli.ts` (the `perihelion-solver` bin).
 */

export { Solver, FatalError } from "./solver.js";
export { Executor, DefiniteFailureError } from "./executor.js";
export { SolverMetrics } from "./metrics.js";
export { createLogger } from "./logger.js";
export { loadConfig } from "./config.js";
export { hasExecutorConfig, loadExecutorConfig } from "./executor-config.js";
export { InFlightTracker, UnlimitedInventoryProvider } from "./inventory.js";
export { BackoffState } from "./backoff.js";
export { SeenLRU } from "./seen-lru.js";
export {
  RATE_SCALE,
  computeProceeds,
  defaultDecimalsLookup,
  defaultFeeEstimator,
  defaultPriceOracle,
  escrowSourceNativeCost,
  evaluate,
  isSolverEligible,
} from "./quote.js";
export type { SolverConfig } from "./config.js";
export type { ExecutorConfig } from "./executor.js";
export type { Metrics, MetricsSnapshot, CorridorStats } from "./metrics.js";
export type { Logger, LoggerOptions } from "./logger.js";
export type { InventoryProvider } from "./inventory.js";
export type { BackoffConfig, Rng } from "./backoff.js";
export type { IntentVerifier } from "./solver.js";
export type {
  DecimalsLookup,
  EvaluateDeps,
  FeeEstimator,
  FillDecision,
  NativeCostDeps,
  PriceOracle,
  PricingDeps,
} from "./quote.js";
