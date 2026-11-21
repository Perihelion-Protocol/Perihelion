#!/usr/bin/env node
// SPDX-License-Identifier: MIT

/**
 * CLI entry point for the reference Perihelion solver node.
 *
 * Configure via environment variables (see `.env.example`) and run:
 *   perihelion-solver
 *
 * This module starts the solver as soon as it is evaluated. Library consumers
 * should import from `index.ts` instead, which has no side effects.
 */

import { loadConfig } from "./config.js";
import { hasExecutorConfig, loadExecutorConfig } from "./executor-config.js";
import { Solver } from "./solver.js";
import { Executor } from "./executor.js";
import { PRICE_RATES_ENV, priceOracleFromEnv } from "./pricing.js";
import { SolverMetrics } from "./metrics.js";
import { createLogger } from "@perihelion/node-common";
import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { privateKeyToAccount } from "viem/accounts";

async function main(): Promise<void> {
  const config = loadConfig();
  const metrics = new SolverMetrics();

  // Structured JSON logger — replaces console for production-grade output.
  const log = createLogger({ component: "solver" });

  const mode = (process.env.PERIHELION_SOLVER_MODE ?? "").trim().toLowerCase();
  const watchOnly = mode === "watch";
  if (mode !== "" && !watchOnly) {
    throw new Error(
      `invalid PERIHELION_SOLVER_MODE "${process.env.PERIHELION_SOLVER_MODE}"; expected "watch" or unset`,
    );
  }

  // Pricing comes from an explicit operator rate table. Executor mode refuses
  // to start without one: the built-in 1:1 oracle would quote every corridor
  // at par and fill intents at a loss.
  const priceOracle = priceOracleFromEnv();

  let executor: Executor | undefined;
  if (watchOnly) {
    // Watch-only mode: evaluate and log decisions, never invoke the executor.
    // The explicit PERIHELION_SOLVER_ADDRESS (if any) is used for eligibility.
    log.warn(
      "PERIHELION_SOLVER_MODE=watch: running in watch-only mode; no fills will be submitted",
      { solverAddress: config.solverAddress },
    );
  } else {
    if (!hasExecutorConfig()) {
      throw new Error(
        "missing executor configuration: set PERIHELION_EVM_RPC_URL, PERIHELION_EVM_PRIVATE_KEY and PERIHELION_STELLAR_SECRET (or run with PERIHELION_SOLVER_MODE=watch for a dry run)",
      );
    }
    if (!priceOracle) {
      throw new Error(
        `missing pricing configuration: set ${PRICE_RATES_ENV} to the SOURCE>DEST=RATE corridors this solver fills (the built-in 1:1 price oracle is not used by the CLI)`,
      );
    }
    const executorConfig = loadExecutorConfig();

    // The escrow enforces preferredSolver == msg.sender, so the address used
    // for eligibility decisions must be the one derived from the signing key.
    const derivedAddress = privateKeyToAccount(executorConfig.evmPrivateKey).address;
    if (
      config.solverAddress &&
      config.solverAddress.toLowerCase() !== derivedAddress.toLowerCase()
    ) {
      throw new Error(
        `PERIHELION_SOLVER_ADDRESS (${config.solverAddress}) does not match the address derived from PERIHELION_EVM_PRIVATE_KEY (${derivedAddress})`,
      );
    }
    config.solverAddress = derivedAddress;

    executor = new Executor(executorConfig, log);
  }

  if (!priceOracle) {
    log.warn(`${PRICE_RATES_ENV} is not set; watch-mode decisions will use the built-in 1:1 price oracle`);
  }
  // Undefined arguments fall back to the Solver defaults (no inventory provider,
  // default verifier).
  const solver = new Solver(config, executor, log, metrics, undefined, undefined, {
    ...(priceOracle ? { priceOracle } : {}),
  });

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
  const maxConsecutiveFailures = Number(process.env.PERIHELION_MAX_CONSECUTIVE_FAILURES ?? 5);

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
          reasons.push(`last tick was ${age}ms ago (threshold: ${stalenessThresholdMs}ms)`);
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
      log.warn(
        "metrics endpoint bound to a non-loopback address; solver margin data is reachable from the network",
        {
          host: metricsHost,
        },
      );
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
  const log = createLogger({ component: "solver" });
  log.error("fatal startup error", { err: String(err) });
  process.exit(1);
});
