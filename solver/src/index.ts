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
import { SolverMetrics } from "./metrics.js";
import { createServer } from "node:http";

async function main(): Promise<void> {
  const config = loadConfig();
  const executorConfig = loadExecutorConfig();
  const executor = new Executor(executorConfig);
  const metrics = new SolverMetrics();
  const solver = new Solver(config, executor, console, metrics);

  // Minimal HTTP server for Prometheus scraping.
  const metricsPort = Number(process.env.PERIHELION_METRICS_PORT ?? 9090);
  const server = createServer((req, res) => {
    if (req.url === "/metrics") {
      res.writeHead(200, { "Content-Type": "text/plain; version=0.0.4" });
      res.end(metrics.toPrometheusText());
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  server.listen(metricsPort, () => {
    console.info(`metrics endpoint listening on :${metricsPort}/metrics`);
  });

  const shutdown = () => {
    console.info("shutting down solver");
    solver.stop();
    server.close();
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
