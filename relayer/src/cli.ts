#!/usr/bin/env node
// SPDX-License-Identifier: MIT

/**
 * CLI entry point for the Perihelion LayerZero relayer.
 *
 * Configure via environment variables (see `.env.example`) and run:
 *   perihelion-relayer
 *
 * This module starts the relayer as soon as it is evaluated. Library consumers
 * should import from `index.ts` instead, which has no side effects.
 */

import { loadConfig } from "./config.js";
import { Relayer } from "./relayer.js";
import { EVMSourceWatcher } from "./evm-watcher.js";
import { SorobanDestinationDelivery } from "./soroban-delivery.js";
import { FileCheckpointStore } from "./file-checkpoint-store.js";
import { HybridDeadLetterStore } from "./file-dead-letter-store.js";
import { createLogger } from "./logger.js";
import { HealthServer } from "./health-server.js";

async function main(): Promise<void> {
  const config = loadConfig();

  // Structured JSON logger — replaces console for production-grade output.
  const log = createLogger({ component: "relayer" });

  // Log startup configuration (with secret redacted)
  log.info("relayer starting", {
    escrowAddress: config.escrowAddress,
    settlementContractId: config.settlementContractId,
    sourceEid: config.sourceEid,
    stellarEid: config.stellarEid,
    confirmations: config.confirmations,
    pollIntervalMs: config.pollIntervalMs,
    evmRpcUrl: config.evmRpcUrl,
    stellarRpcUrl: config.stellarRpcUrl,
    stellarNetwork: config.stellarNetwork,
    signerSecretConfigured: !!config.signerSecret,
  });

  // Initialize concrete implementations
  const watcher = new EVMSourceWatcher({
    rpcUrl: config.evmRpcUrl,
    escrowAddress: config.escrowAddress,
    sourceEid: config.sourceEid,
    stellarEid: config.stellarEid,
  });

  const delivery = new SorobanDestinationDelivery({
    rpcUrl: config.stellarRpcUrl,
    networkPassphrase: config.stellarNetwork,
    settlementContractId: config.settlementContractId,
    signerSecret: config.signerSecret,
  });

  const checkpoint = new FileCheckpointStore(
    process.env.PERIHELION_CHECKPOINT_FILE || "./.perihelion-relayer-checkpoint.json",
  );

  const deadLetter = new HybridDeadLetterStore(
    process.env.PERIHELION_DEAD_LETTER_FILE || "./.perihelion-relayer-dead-letter.json",
  );
  await deadLetter.load();

  const relayer = new Relayer(
    config,
    watcher,
    delivery,
    log,
    config.startBlock,
    checkpoint,
    deadLetter,
  );

  // Health / readiness / metrics HTTP server.
  const healthPort = Number(process.env.PERIHELION_HEALTH_PORT ?? 8080);
  const healthServer = new HealthServer(relayer, healthPort, log);
  await healthServer.start();

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info("shutting down relayer", { signal });
    relayer.stop();
    await healthServer.stop();
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  try {
    await relayer.start();
  } finally {
    log.info("relayer stopped cleanly");
  }
}

main().catch((err) => {
  const log = createLogger({ component: "relayer" });
  log.error("fatal startup error", { err: String(err) });
  process.exit(1);
});
