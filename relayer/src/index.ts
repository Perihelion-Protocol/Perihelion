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

export { EVMSourceWatcher } from "./evm-watcher.js";
export { SorobanDestinationDelivery } from "./soroban-delivery.js";
export { Relayer } from "./relayer.js";
export type { SourceWatcher, DestinationDelivery, Logger } from "./relayer.js";
export type { PendingMessage, BridgeMessage, RelayResult, EndpointId } from "./types.js";
export type { RelayerConfig } from "./config.js";

async function main(): Promise<void> {
  const config = loadConfig();

  // Initialize concrete implementations
  // NOTE: These are skeleton implementations. Wire them to actual EVM/Soroban
  // when the contract interfaces are finalized (architecture spec §3).
  const watcher = new EVMSourceWatcher({
    rpcUrl: process.env.EVM_RPC_URL || "http://localhost:8545",
    escrowAddress: config.escrowAddress,
    sourceEid: 30101, // Placeholder; configure from environment
  });

  const delivery = new SorobanDestinationDelivery({
    rpcUrl: process.env.SOROBAN_RPC_URL || "http://localhost:8000",
    networkPassphrase:
      process.env.STELLAR_NETWORK ||
      "Test SDF Network ; September 2015",
    settlementContractId: config.settlementContractId,
    signerSecret: process.env.SIGNER_SECRET || "",
  });

  const relayer = new Relayer(config, watcher, delivery);

  const shutdown = () => {
    console.info("shutting down relayer");
    relayer.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await relayer.start();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
