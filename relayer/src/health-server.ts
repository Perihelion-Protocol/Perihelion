/**
 * Lightweight HTTP health/readiness/metrics server for the Perihelion relayer.
 *
 * ## Endpoints
 *
 * | Path      | Method | Description                                            |
 * |-----------|--------|--------------------------------------------------------|
 * | /healthz  | GET    | Liveness: 200 while the process is alive               |
 * | /readyz   | GET    | Readiness: 200 when the relayer is healthy, 503 if not |
 * | /metrics  | GET    | Prometheus-style text metrics                          |
 *
 * ### /healthz
 *
 * Always returns `200 OK` with `{"status":"ok"}` as long as the HTTP server
 * is running. Use this for orchestrator liveness checks (Kubernetes, systemd
 * watchdog, Docker HEALTHCHECK). A 503 here means the process is dead — the
 * orchestrator should restart it.
 *
 * ### /readyz
 *
 * Returns `200 OK` when:
 *   - At least one tick has completed successfully (`lastTickOk` is true), AND
 *   - The last successful tick was within the staleness window
 *     (default: `3 × pollIntervalMs`, configurable via `PERIHELION_READINESS_STALE_MS`), AND
 *   - Cursor lag ≤ `maxLagBlocks` (default: 500, configurable via `PERIHELION_MAX_LAG_BLOCKS`).
 *
 * Returns `503 Service Unavailable` with a JSON body explaining which check
 * failed when any condition is not met. Use this for orchestrator readiness
 * checks — an unhealthy readiness probe causes the orchestrator to restart
 * or stop sending traffic to the instance.
 *
 * ### /metrics
 *
 * Returns Prometheus-style plain text (`text/plain; version=0.0.4`) with:
 *
 * ```
 * # HELP relayer_delivered_total Messages successfully delivered to Soroban
 * # TYPE relayer_delivered_total counter
 * relayer_delivered_total 42
 *
 * # HELP relayer_failed_total Delivery attempts that threw an error
 * # TYPE relayer_failed_total counter
 * relayer_failed_total 3
 *
 * # HELP relayer_dead_lettered_total Messages that exhausted the retry budget
 * # TYPE relayer_dead_lettered_total counter
 * relayer_dead_lettered_total 1
 *
 * # HELP relayer_cursor_lag_blocks Blocks between current head and relayer cursor
 * # TYPE relayer_cursor_lag_blocks gauge
 * relayer_cursor_lag_blocks 6
 *
 * # HELP relayer_cursor_block Current relay cursor (last confirmed block processed)
 * # TYPE relayer_cursor_block gauge
 * relayer_cursor_block 100
 *
 * # HELP relayer_head_block Latest chain head seen
 * # TYPE relayer_head_block gauge
 * relayer_head_block 106
 *
 * # HELP relayer_last_tick_timestamp_seconds Unix timestamp of last successful tick
 * # TYPE relayer_last_tick_timestamp_seconds gauge
 * relayer_last_tick_timestamp_seconds 1700000000
 * ```
 *
 * ## Configuration
 *
 * | Environment variable              | Default                      | Description                                    |
 * |-----------------------------------|------------------------------|------------------------------------------------|
 * | PERIHELION_HEALTH_PORT            | 8080                         | HTTP port for the health server                |
 * | PERIHELION_HEALTH_HOST            | 127.0.0.1                    | Bind address. Widen deliberately (e.g. 0.0.0.0 in Kubernetes, where the probe reaches the pod IP) |
 * | PERIHELION_METRICS_TOKEN          | (unset)                      | If set, `/metrics` requires `Authorization: Bearer <token>`. `/healthz`/`/readyz` stay open for orchestrators |
 * | PERIHELION_READINESS_STALE_MS     | 3 × pollIntervalMs           | Max ms since last tick before readiness fails  |
 * | PERIHELION_MAX_LAG_BLOCKS         | 500                          | Max block lag before readiness fails           |
 *
 * ## Orchestration examples
 *
 * ### Kubernetes
 *
 * ```yaml
 * livenessProbe:
 *   httpGet:
 *     path: /healthz
 *     port: 8080
 *   initialDelaySeconds: 5
 *   periodSeconds: 10
 *
 * readinessProbe:
 *   httpGet:
 *     path: /readyz
 *     port: 8080
 *   initialDelaySeconds: 15
 *   periodSeconds: 10
 * ```
 *
 * ### Docker HEALTHCHECK
 *
 * ```dockerfile
 * HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
 *   CMD curl -f http://localhost:8080/healthz || exit 1
 * ```
 */

import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { Relayer } from "./relayer.js";
import type { Logger } from "./relayer.js";

/** Options for the HealthServer. */
export interface HealthServerOptions {
  /**
   * Maximum milliseconds since the last successful tick before the relayer
   * is considered unhealthy. Defaults to 3 × `config.pollIntervalMs`.
   */
  stalenessThresholdMs?: number;
  /**
   * Maximum block lag (head − cursor) before the relayer is considered unhealthy.
   * Default: 500.
   */
  maxLagBlocks?: number;
}

/**
 * Lightweight HTTP server exposing /healthz, /readyz, and /metrics for the
 * Perihelion relayer.
 */
export class HealthServer {
  private server: Server | null = null;
  private readonly stalenessThresholdMs: number;
  private readonly maxLagBlocks: number;
  private readonly host: string;
  private readonly metricsToken: string | undefined;

  constructor(
    private readonly relayer: Relayer,
    private readonly port: number,
    private readonly log: Logger,
    opts: HealthServerOptions = {},
  ) {
    // Access pollIntervalMs through the public metrics/readiness interface.
    // Default staleness: 3 × pollIntervalMs (read from env, fallback 15s).
    const pollMs = Number(process.env.PERIHELION_POLL_INTERVAL_MS ?? 5_000);
    this.stalenessThresholdMs =
      opts.stalenessThresholdMs ??
      Number(process.env.PERIHELION_READINESS_STALE_MS ?? pollMs * 3);
    this.maxLagBlocks =
      opts.maxLagBlocks ??
      Number(process.env.PERIHELION_MAX_LAG_BLOCKS ?? 500);
    this.host = process.env.PERIHELION_HEALTH_HOST ?? "127.0.0.1";
    this.metricsToken = process.env.PERIHELION_METRICS_TOKEN || undefined;
  }

  /** Start the HTTP server. Resolves once the server is listening. */
  start(): Promise<void> {
    return new Promise((resolve) => {
      this.server = createServer((req, res) => this.handle(req, res));
      this.server.listen(this.port, this.host, () => {
        this.log.info("health server listening", {
          host: this.host,
          port: this.port,
          paths: ["/healthz", "/readyz", "/metrics"],
        });
        if (this.host !== "127.0.0.1" && this.host !== "localhost") {
          this.log.warn(
            "health server bound to a non-loopback address; /metrics and /readyz are reachable from the network",
            { host: this.host },
          );
        }
        resolve();
      });
    });
  }

  /** Stop the HTTP server. */
  stop(): void {
    this.server?.close();
    this.server = null;
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    const url = req.url ?? "/";

    if (url === "/healthz") {
      this.handleHealthz(res);
    } else if (url === "/readyz") {
      this.handleReadyz(res);
    } else if (url === "/metrics") {
      if (this.metricsToken && !this.isAuthorized(req)) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      this.handleMetrics(res);
    } else {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    }
  }

  /** Constant-time bearer-token check against PERIHELION_METRICS_TOKEN. */
  private isAuthorized(req: IncomingMessage): boolean {
    const header = req.headers.authorization ?? "";
    const [scheme, token] = header.split(" ");
    if (scheme !== "Bearer" || !token || !this.metricsToken) {
      return false;
    }
    const expected = Buffer.from(this.metricsToken);
    const actual = Buffer.from(token);
    return (
      expected.length === actual.length &&
      timingSafeEqual(expected, actual)
    );
  }

  /** Liveness: always 200 while the process is alive. */
  private handleHealthz(res: ServerResponse): void {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
  }

  /**
   * Readiness: reflects whether the relayer is making progress.
   *
   * Checks:
   *   1. At least one tick has succeeded.
   *   2. Last successful tick was within `stalenessThresholdMs`.
   *   3. Cursor lag ≤ `maxLagBlocks`.
   */
  private handleReadyz(res: ServerResponse): void {
    const r = this.relayer.readiness;
    const now = Date.now();
    const reasons: string[] = [];

    if (!r.lastTickOk || r.lastTickAt === 0) {
      reasons.push("no successful tick yet");
    } else {
      const age = now - r.lastTickAt;
      if (age > this.stalenessThresholdMs) {
        reasons.push(
          `last tick was ${age}ms ago (threshold: ${this.stalenessThresholdMs}ms)`,
        );
      }
    }

    if (r.lag > this.maxLagBlocks) {
      reasons.push(`cursor lag ${r.lag} blocks exceeds max ${this.maxLagBlocks}`);
    }

    if (reasons.length > 0) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          status: "not ready",
          reasons,
          cursor: r.cursor,
          head: r.head,
          lag: r.lag,
          lastTickAt: r.lastTickAt,
        }),
      );
    } else {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          status: "ready",
          cursor: r.cursor,
          head: r.head,
          lag: r.lag,
          lastTickAt: r.lastTickAt,
        }),
      );
    }
  }

  /**
   * Prometheus-style metrics exposition.
   * Content-Type: text/plain; version=0.0.4
   */
  private handleMetrics(res: ServerResponse): void {
    const m = this.relayer.metrics;
    const r = this.relayer.readiness;

    const lines = [
      "# HELP relayer_delivered_total Messages successfully delivered to Soroban",
      "# TYPE relayer_delivered_total counter",
      `relayer_delivered_total ${m.delivered}`,
      "",
      "# HELP relayer_failed_total Delivery attempts that threw an error",
      "# TYPE relayer_failed_total counter",
      `relayer_failed_total ${m.failed}`,
      "",
      "# HELP relayer_dead_lettered_total Messages that exhausted the retry budget",
      "# TYPE relayer_dead_lettered_total counter",
      `relayer_dead_lettered_total ${m.deadLettered}`,
      "",
      "# HELP relayer_max_retry_depth Maximum retry depth seen across all messages",
      "# TYPE relayer_max_retry_depth gauge",
      `relayer_max_retry_depth ${m.maxRetryDepth}`,
      "",
      "# HELP relayer_cursor_lag_blocks Blocks between current head and relayer cursor",
      "# TYPE relayer_cursor_lag_blocks gauge",
      `relayer_cursor_lag_blocks ${r.lag}`,
      "",
      "# HELP relayer_cursor_block Current relay cursor (last confirmed block processed)",
      "# TYPE relayer_cursor_block gauge",
      `relayer_cursor_block ${r.cursor}`,
      "",
      "# HELP relayer_head_block Latest chain head seen",
      "# TYPE relayer_head_block gauge",
      `relayer_head_block ${r.head}`,
      "",
      "# HELP relayer_last_tick_timestamp_seconds Unix timestamp of last successful tick",
      "# TYPE relayer_last_tick_timestamp_seconds gauge",
      `relayer_last_tick_timestamp_seconds ${r.lastTickAt > 0 ? Math.floor(r.lastTickAt / 1000) : 0}`,
      "",
    ];

    res.writeHead(200, { "Content-Type": "text/plain; version=0.0.4" });
    res.end(lines.join("\n"));
  }
}
