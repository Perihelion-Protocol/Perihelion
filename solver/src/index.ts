#!/usr/bin/env node
/**
 * Entry point for the reference Perihelion solver node.
 *
 * Configure via environment variables (see `.env.example`) and run:
 *   perihelion-solver
 */

import { loadConfig } from "./config.js";
import { loadExecutorConfig } from "./executor-config.js";
import { Solver } from "./solver.js";
import { Executor } from "./executor.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const executorConfig = loadExecutorConfig();
  const executor = new Executor(executorConfig);
  const solver = new Solver(config, executor);

  const shutdown = () => {
    console.info("shutting down solver");
    solver.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await solver.start();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
