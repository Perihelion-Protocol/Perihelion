#!/usr/bin/env node
/**
 * Entry point for the Perihelion LayerZero relayer.
 *
 * Configure via environment variables (see `.env.example`) and run:
 *   perihelion-relayer
 */

import { loadConfig } from "./config.js";
import { Relayer } from "./relayer.js";
import { EVMSourceWatcher } from "./evm-watcher.js";
import { SorobanDestinationDelivery } from "./soroban-delivery.js";
import { FileCheckpointStore } from "./file-checkpoint-store.js";
import { createLogger } from "./logger.js";
import { HealthServer } from "./health-server.js";

export { EVMSourceWatcher } from "./evm-watcher.js";
export { SorobanDestinationDelivery } from "./soroban-delivery.js";
export { Relayer } from "./relayer.js";
export { FileCheckpointStore } from "./file-checkpoint-store.js";
export { NoopCheckpointStore } from "./checkpoint.js";
export { InMemoryDeadLetterStore } from "./dead-letter.js";
export { createLogger } from "./logger.js";
export { HealthServer } from "./health-server.js";
export type { CheckpointStore } from "./checkpoint.js";
export type { DeadLetterStore, DeadLetterEntry } from "./dead-letter.js";
export type { SourceWatcher, DestinationDelivery, Logger, RetryPolicy, RelayMetrics } from "./relayer.js";
export type { PendingMessage, BridgeMessage, RelayResult, EndpointId, MessageType, MessageKey } from "./types.js";
export { messageKeyString } from "./types.js";
export type { RelayerConfig } from "./config.js";

async function main(): Promise<void> {
  const config = loadConfig();

  // Structured JSON logger — replaces console for production-grade output.
  const log = createLogger({ component: "relayer" });

  // Initialize concrete implementations
  const watcher = new EVMSourceWatcher({
    rpcUrl: process.env.EVM_RPC_URL || "http://localhost:8545",
    escrowAddress: config.escrowAddress,
    sourceEid: Number(process.env.PERIHELION_SOURCE_EID ?? 30101),
    stellarEid: Number(process.env.PERIHELION_STELLAR_EID ?? 40161),
  });

  const delivery = new SorobanDestinationDelivery({
    rpcUrl: process.env.SOROBAN_RPC_URL || "http://localhost:8000",
    networkPassphrase:
      process.env.STELLAR_NETWORK ||
      "Test SDF Network ; September 2015",
    settlementContractId: config.settlementContractId,
    signerSecret: process.env.SIGNER_SECRET || "",
  });

  const checkpoint = new FileCheckpointStore(
    process.env.PERIHELION_CHECKPOINT_FILE || "./.perihelion-relayer-checkpoint.json",
  );
  const relayer = new Relayer(config, watcher, delivery, log, 0, checkpoint);

  // Health / readiness / metrics HTTP server.
  const healthPort = Number(process.env.PERIHELION_HEALTH_PORT ?? 8080);
  const healthServer = new HealthServer(relayer, healthPort, log);
  await healthServer.start();

  const shutdown = () => {
    log.info("shutting down relayer");
    relayer.stop();
    healthServer.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await relayer.start();
}

main().catch((err) => {
  const log = createLogger({ component: "relayer" });
  log.error("fatal startup error", { err: String(err) });
  process.exit(1);
});
