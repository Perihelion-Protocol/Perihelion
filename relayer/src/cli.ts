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

import { inclusionFeePolicyFromEnv } from "@perihelion/sdk";
import { loadConfig } from "./config.js";
import { Relayer } from "./relayer.js";
import { EVMSourceWatcher } from "./evm-watcher.js";
import { SorobanDestinationDelivery } from "./soroban-delivery.js";
import { SorobanSourceWatcher } from "./soroban-watcher.js";
import { EvmDestinationDelivery } from "./evm-delivery.js";
import { FileCheckpointStore } from "./file-checkpoint-store.js";
import { HybridDeadLetterStore } from "./file-dead-letter-store.js";
import { createLogger } from "@perihelion/node-common";
import { HealthServer } from "./health-server.js";

/**
 * Refuse to run endpoint-impersonation mode against a public network.
 *
 * The reference relayer signs `lz_receive` as the trusted endpoint, so its
 * Stellar key carries full authority over the settlement contract. That is a
 * development-only stand-in for the LayerZero executor/DVN stack and must
 * never be pointed at Pubnet without an explicit, deliberate override.
 */
function assertSafeRelayerMode(config: ReturnType<typeof loadConfig>): void {
  const mode = (process.env.PERIHELION_RELAYER_MODE ?? "").toLowerCase();
  const override = (process.env.PERIHELION_ALLOW_PUBNET_DEV_RELAYER ?? "").toLowerCase();
  const isPubnet = /pubnet|public/i.test(config.stellarNetwork);

  if (mode !== "dev") return;
  if (!isPubnet) return;
  if (override === "1" || override === "true" || override === "yes") return;

  throw new Error(
    "PERIHELION_RELAYER_MODE=dev refuses to start against Stellar Pubnet: " +
      "the reference relayer is a development-only stand-in for the LayerZero " +
      "executor and signs lz_receive as the trusted endpoint, so its key holds " +
      "full authority over the settlement contract. Production must use a real " +
      "LayerZero endpoint/adapter on Stellar. Set " +
      "PERIHELION_ALLOW_PUBNET_DEV_RELAYER=1 only if you fully understand the risk.",
  );
}

async function main(): Promise<void> {
  // Structured JSON logger — replaces console for production-grade output.
  const log = createLogger({ component: "relayer" });
  const config = loadConfig(process.env, log);

  assertSafeRelayerMode(config);
  if ((process.env.PERIHELION_RELAYER_MODE ?? "").toLowerCase() === "dev") {
    log.warn(
      "running in development endpoint-impersonation mode: the relayer key " +
        "acts as the trusted endpoint and carries full authority over the " +
        "settlement contract; this is not a production trust model",
    );
  }

  // Log startup configuration (with secret redacted)
  log.info("relayer starting", {
    escrowAddress: config.escrowAddress,
    settlementContractId: config.settlementContractId,
    sourceEid: config.sourceEid,
    stellarEid: config.stellarEid,
    confirmations: config.confirmations,
    pollIntervalMs: config.pollIntervalMs,
    evmRpcOrigin: new URL(config.evmRpcUrl).origin,
    stellarRpcOrigin: new URL(config.stellarRpcUrl).origin,
    stellarNetwork: config.stellarNetwork,
    signerSecretConfigured: !!config.signerSecret,
  });

  // ---------------------------------------------------------------------------
  // EVM -> Stellar leg (Locked -> lz_receive on settlement)
  // ---------------------------------------------------------------------------
  const evmWatcher = new EVMSourceWatcher({
    rpcUrl: config.evmRpcUrl,
    escrowAddress: config.escrowAddress,
    sourceEid: config.sourceEid,
    stellarEid: config.stellarEid,
    logger: log,
  });

  const sorobanDelivery = new SorobanDestinationDelivery({
    rpcUrl: config.stellarRpcUrl,
    networkPassphrase: config.stellarNetwork,
    settlementContractId: config.settlementContractId,
    signerSecret: config.signerSecret,
    escrowAddress: config.escrowAddress,
    timeoutSeconds: config.txTimeoutSeconds,
    inclusionFee: inclusionFeePolicyFromEnv(process.env),
    logger: log,
  });

  const evmToStellarCheckpoint = new FileCheckpointStore(config.checkpointFile);

  const evmToStellarDeadLetter = new HybridDeadLetterStore(config.deadLetterFile);
  await evmToStellarDeadLetter.load();

  const evmToStellarRelayer = new Relayer(
    config,
    evmWatcher,
    sorobanDelivery,
    log,
    config.startBlock,
    evmToStellarCheckpoint,
    evmToStellarDeadLetter,
  );

  // ---------------------------------------------------------------------------
  // Stellar -> EVM leg (FillConfirmed / CancelIntent -> lzReceive on escrow)
  // ---------------------------------------------------------------------------
  const sorobanWatcher = new SorobanSourceWatcher({
    rpcUrl: config.stellarRpcUrl,
    networkPassphrase: config.stellarNetwork,
    settlementContractId: config.settlementContractId,
    sourceEid: config.stellarEid,
    destinationEid: config.sourceEid,
  });

  const evmDelivery = new EvmDestinationDelivery({
    rpcUrl: config.evmRpcUrl,
    escrowAddress: config.escrowAddress,
    signerSecret: config.signerSecret,
    sourceEid: config.stellarEid,
    destinationEid: config.sourceEid,
    timeoutSeconds: config.txTimeoutSeconds,
  });

  const stellarToEvmCheckpoint = new FileCheckpointStore(config.returnCheckpointFile);

  const stellarToEvmDeadLetter = new HybridDeadLetterStore(config.returnDeadLetterFile);
  await stellarToEvmDeadLetter.load();

  const stellarToEvmRelayer = new Relayer(
    config,
    sorobanWatcher,
    evmDelivery,
    log,
    0,
    stellarToEvmCheckpoint,
    stellarToEvmDeadLetter,
  );

  // Health / readiness / metrics HTTP server.
  const healthServer = new HealthServer(evmToStellarRelayer, config.healthPort, log, {
    host: config.healthHost,
    metricsToken: config.metricsToken,
    stalenessThresholdMs: config.readinessStaleMs,
    maxLagBlocks: config.maxLagBlocks,
  });
  await healthServer.start();

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info("shutting down relayer", { signal });
    evmToStellarRelayer.stop();
    stellarToEvmRelayer.stop();
    await healthServer.stop();
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  try {
    await Promise.all([evmToStellarRelayer.start(), stellarToEvmRelayer.start()]);
  } finally {
    log.info("relayer stopped cleanly");
  }
}

main().catch((err) => {
  const log = createLogger({ component: "relayer" });
  log.error("fatal startup error", { err: String(err) });
  process.exit(1);
});
