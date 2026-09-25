// SPDX-License-Identifier: MIT

/**
 * Library entry point for `@perihelion/relayer`.
 *
 * Importing this module has no side effects: it only re-exports the public
 * API. The runnable relayer lives in `cli.ts` (the `perihelion-relayer` bin).
 */

export { EVMSourceWatcher } from "./evm-watcher.js";
export { SorobanDestinationDelivery } from "./soroban-delivery.js";
export { Relayer } from "./relayer.js";
export { FileCheckpointStore } from "./file-checkpoint-store.js";
export { NoopCheckpointStore } from "./checkpoint.js";
export { InMemoryDeadLetterStore } from "./dead-letter.js";
export { FileDeadLetterStore, HybridDeadLetterStore } from "./file-dead-letter-store.js";
export { createLogger } from "./logger.js";
export { HealthServer } from "./health-server.js";
export type { CheckpointStore } from "./checkpoint.js";
export type { DeadLetterStore, DeadLetterEntry } from "./dead-letter.js";
export type { SourceWatcher, DestinationDelivery, Logger, RetryPolicy, RelayMetrics } from "./relayer.js";
export type { PendingMessage, BridgeMessage, RelayResult, EndpointId, MessageType, MessageKey } from "./types.js";
export { messageKeyString } from "./types.js";
export type { RelayerConfig } from "./config.js";
