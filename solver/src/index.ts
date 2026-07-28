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
import { timingSafeEqual } from "node:crypto";

async function main(): Promise<void> {
  const config = loadConfig();
  const executorConfig = loadExecutorConfig();
  const executor = new Executor(executorConfig);
  const metrics = new SolverMetrics();

  // Structured JSON logger — replaces console for production-grade output.
  const log = createLogger();

  const solver = new Solver(config, executor, log, metrics);

  // Minimal HTTP server for Prometheus scraping.
  //
  // Publishing a solver's realised fill/win/loss margin to competitors on a
  // fill-race market is directly adversarial (docs/ECONOMICS.md), so this
  // binds to loopback by default and supports optional bearer-token auth —
  // widen or open it up only deliberately.
  const metricsPort = Number(process.env.PERIHELION_METRICS_PORT ?? 9090);
  const metricsHost = process.env.PERIHELION_HEALTH_HOST ?? "127.0.0.1";
  const metricsToken = process.env.PERIHELION_METRICS_TOKEN || undefined;
  const isAuthorized = (authHeader: string | undefined): boolean => {
    if (!metricsToken) return true;
    const [scheme, token] = (authHeader ?? "").split(" ");
    if (scheme !== "Bearer" || !token) return false;
    const expected = Buffer.from(metricsToken);
    const actual = Buffer.from(token);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  };
  const server = createServer((req, res) => {
    if (req.url === "/metrics") {
      if (!isAuthorized(req.headers.authorization)) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "text/plain; version=0.0.4" });
      res.end(metrics.toPrometheusText());
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  server.listen(metricsPort, metricsHost, () => {
    log.info("metrics endpoint listening", {
      host: metricsHost,
      port: metricsPort,
      path: "/metrics",
    });
    if (metricsHost !== "127.0.0.1" && metricsHost !== "localhost") {
      log.warn("metrics endpoint bound to a non-loopback address; solver margin data is reachable from the network", {
        host: metricsHost,
      });
    }
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
