// SPDX-License-Identifier: MIT

import { MempoolServer } from "./index.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
const server = new MempoolServer(config);

await server.start();

let shuttingDown = false;
const shutdown = async (signal: string): Promise<void> => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[mempool] received ${signal}, shutting down`);
  try {
    // Stops accepting new connections and resolves once in-flight requests drain.
    await server.stop();
  } catch (err) {
    console.error("[mempool] error during shutdown:", err);
    process.exitCode = 1;
  }
};

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
