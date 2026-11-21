// SPDX-License-Identifier: MIT

/**
 * Library entry point for `@perihelion/relayer`.
 *
 * Importing this module has no side effects: it only re-exports the public
 * API. The runnable relayer lives in `cli.ts` (the `perihelion-relayer` bin).
 */

export { EVMSourceWatcher } from "./evm-watcher.js";
export { SorobanSourceWatcher } from "./soroban-watcher.js";
export { SorobanDestinationDelivery } from "./soroban-delivery.js";
export { EvmDestinationDelivery } from "./evm-delivery.js";
export { Relayer } from "./relayer.js";
export { FileCheckpointStore } from "./file-checkpoint-store.js";
export { NoopCheckpointStore } from "./checkpoint.js";
export { InMemoryDeadLetterStore } from "./dead-letter.js";
export { FileDeadLetterStore, HybridDeadLetterStore } from "./file-dead-letter-store.js";
export { createLogger } from "@perihelion/node-common";
export { HealthServer } from "./health-server.js";
export type { CheckpointStore } from "./checkpoint.js";
export type { DeadLetterStore, DeadLetterEntry } from "./dead-letter.js";
export type {
  SourceWatcher,
  DestinationDelivery,
  Logger,
  RetryPolicy,
  RelayMetrics,
} from "./relayer.js";
export type {
  PendingMessage,
  BridgeMessage,
  RelayResult,
  EndpointId,
  MessageType,
  MessageKey,
} from "./types.js";
export { messageKeyString } from "./types.js";
export { loadConfig } from "./config.js";
export type { RelayerConfig, RelayerMode } from "./config.js";
export {
  Keeper,
  ViemEvmKeeperAdapter,
  StellarSorobanKeeperAdapter,
  renderKeeperPrometheusMetrics,
} from "./keeper.js";
export type {
  EvmKeeperAdapter,
  EvmKeeperScanResult,
  SorobanKeeperAdapter,
  KeeperMetrics,
  KeeperReadinessState,
  KeeperActionRecord,
  KeeperTickResult,
  KeeperOptions,
  ViemEvmKeeperAdapterConfig,
} from "./keeper.js";
export type { LoggerOptions } from "@perihelion/node-common";
