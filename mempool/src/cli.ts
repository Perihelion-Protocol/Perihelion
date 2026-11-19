// SPDX-License-Identifier: MIT

import { MempoolServer } from "./index.js";
import { loadConfig } from "./config.js";

// Entry point: this is where the library's warnings are routed to the terminal.
const logger = {
  warn: (msg: string, meta?: Record<string, unknown>) => console.warn(msg, meta ?? ""),
  error: (msg: string, meta?: Record<string, unknown>) => console.error(msg, meta ?? ""),
};

const config = loadConfig();
const server = new MempoolServer({ ...config, logger });

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Received ${signal}, shutting down mempool...`);
  try {
    await server.stop();
  } catch (err) {
    console.error("Error while stopping mempool:", err);
    process.exit(1);
  }
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

await server.start();
console.log(`Mempool listening on ${config.host}:${config.port}`);
