#!/usr/bin/env node
// SPDX-License-Identifier: MIT

/**
 * Entry point for the reference Perihelion solver node.
 *
 * Configure via environment variables (see `.env.example`) and run:
 *   perihelion-solver
 */

import { loadConfig } from "./config.js";
import { hasExecutorConfig, loadExecutorConfig } from "./executor-config.js";
import { Solver } from "./solver.js";
import { Executor } from "./executor.js";
import { SolverMetrics } from "./metrics.js";
import { createLogger } from "./logger.js";
import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";

async function main(): Promise<void> {
  const config = loadConfig();
  const executorConfig = hasExecutorConfig() ? loadExecutorConfig() : undefined;
  const metrics = new SolverMetrics();

  // Structured JSON logger — replaces console for production-grade output.
  const log = createLogger();

  const executor = new Executor(executorConfig, log);

  const solver = new Solver(config, executor, log, metrics);

  // Minimal HTTP server for Prometheus scraping.
  //
  // Publishing a solver's realised fill/win/loss margin to competitors on a
  // fill-race market is directly adversarial (docs/ECONOMICS.md), so this
  // binds to loopback by default and supports optional bearer-token auth —
  // widen or open it up only deliberately.
  const metricsPort = Number(process.env.PERIHELION_METRICS_PORT ?? 9090);
  let metricsHost = process.env.PERIHELION_METRICS_HOST;
  if (!metricsHost && process.env.PERIHELION_HEALTH_HOST) {
    log.warn(
      "PERIHELION_HEALTH_HOST is deprecated for the solver; use PERIHELION_METRICS_HOST instead",
    );
    metricsHost = process.env.PERIHELION_HEALTH_HOST;
  }
  if (!metricsHost) {
    metricsHost = "127.0.0.1";
  }
  const metricsToken = process.env.PERIHELION_METRICS_TOKEN || undefined;
  const isAuthorized = (authHeader: string | undefined): boolean => {
    if (!metricsToken) return true;
    const [scheme, token] = (authHeader ?? "").split(" ");
    if (scheme !== "Bearer" || !token) return false;
    const expected = Buffer.from(metricsToken);
    const actual = Buffer.from(token);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  };
  const stalenessThresholdMs = Number(
    process.env.PERIHELION_READINESS_STALE_MS ?? config.pollIntervalMs * 3,
  );
  const maxConsecutiveFailures = Number(
    process.env.PERIHELION_MAX_CONSECUTIVE_FAILURES ?? 5,
  );

  const server = createServer((req, res) => {
    if (req.url === "/healthz") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
    } else if (req.url === "/readyz") {
      const r = solver.readiness;
      const now = Date.now();
      const reasons: string[] = [];

      if (!r.lastTickOk || r.lastTickAt === 0) {
        reasons.push("no successful tick yet");
      } else {
        const age = now - r.lastTickAt;
        if (age > stalenessThresholdMs) {
          reasons.push(
            `last tick was ${age}ms ago (threshold: ${stalenessThresholdMs}ms)`,
          );
        }
      }

      if (r.consecutiveFailures > maxConsecutiveFailures) {
        reasons.push(
          `consecutive failures ${r.consecutiveFailures} exceeds threshold ${maxConsecutiveFailures}`,
        );
      }

      if (reasons.length > 0) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            status: "not ready",
            reasons,
            lastTickAt: r.lastTickAt,
            consecutiveFailures: r.consecutiveFailures,
            seenCount: r.seenCount,
            retryStateCount: r.retryStateCount,
          }),
        );
      } else {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            status: "ready",
            lastTickAt: r.lastTickAt,
            consecutiveFailures: r.consecutiveFailures,
            seenCount: r.seenCount,
            retryStateCount: r.retryStateCount,
          }),
        );
      }
    } else if (req.url === "/metrics") {
      if (!isAuthorized(req.headers.authorization)) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "text/plain; version=0.0.4" });
      res.end(metrics.toPrometheusText());
    } else {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    }
  });
  server.listen(metricsPort, metricsHost, () => {
    log.info("health and metrics server listening", {
      host: metricsHost,
      port: metricsPort,
      paths: ["/healthz", "/readyz", "/metrics"],
    });
    if (metricsHost !== "127.0.0.1" && metricsHost !== "localhost") {
      log.warn("metrics endpoint bound to a non-loopback address; solver margin data is reachable from the network", {
        host: metricsHost,
      });
    }
  });

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info("shutting down solver", { signal });
    solver.stop();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  try {
    await solver.start();
  } finally {
    log.info("solver stopped cleanly");
  }
}

main().catch((err) => {
  const log = createLogger();
  log.error("fatal startup error", { err: String(err) });
  process.exit(1);
});
