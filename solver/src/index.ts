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
import { createLogger } from "./logger.js";
import { createServer } from "node:http";

async function main(): Promise<void> {
  const config = loadConfig();
  const executorConfig = loadExecutorConfig();
  const executor = new Executor(executorConfig);
  const metrics = new SolverMetrics();

  // Structured JSON logger — replaces console for production-grade output.
  const log = createLogger();

  const solver = new Solver(config, executor, log, metrics);

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
    log.info("metrics endpoint listening", { port: metricsPort, path: "/metrics" });
  });

  const shutdown = () => {
    log.info("shutting down solver");
    solver.stop();
    server.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await solver.start();
}

main().catch((err) => {
  const log = createLogger();
  log.error("fatal startup error", { err: String(err) });
  process.exit(1);
});
