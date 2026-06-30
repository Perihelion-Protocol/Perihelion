/**
 * Structured JSON logger for the Perihelion solver.
 *
 * Emits one JSON object per line to stdout/stderr so log aggregators
 * (CloudWatch, Datadog, Loki, etc.) can parse and index every field.
 *
 * ## Fields included in every log line
 *
 * | Field       | Type   | Description                                        |
 * |-------------|--------|----------------------------------------------------|
 * | ts          | string | ISO-8601 timestamp (UTC)                           |
 * | level       | string | "info" | "warn" | "error"                            |
 * | msg         | string | Human-readable message                             |
 * | component   | string | "solver" (static, aids multi-component filtering)  |
 * | intentHash  | string | Present when the meta object contains intentHash   |
 * | …meta       | any    | All other keys from the meta object are spread in  |
 *
 * ## Usage
 *
 * ```ts
 * import { createLogger } from "./logger.js";
 *
 * const log = createLogger();
 * log.info("solver started", { solver: "0x…", mempool: "http://…" });
 * // → {"ts":"2024-01-01T00:00:00.000Z","level":"info","component":"solver","msg":"solver started","solver":"0x…","mempool":"http://…"}
 *
 * log.info("filled", { intentHash: "0xabc…", settlementTx: "…" });
 * // → {"ts":"…","level":"info","component":"solver","msg":"filled","intentHash":"0xabc…","settlementTx":"…"}
 * ```
 *
 * ## Injecting a production logger (pino / winston)
 *
 * The solver accepts a `Logger` interface:
 *
 * ```ts
 * export interface Logger {
 *   info(msg: string, meta?: Record<string, unknown>): void;
 *   warn(msg: string, meta?: Record<string, unknown>): void;
 *   error(msg: string, meta?: Record<string, unknown>): void;
 * }
 * ```
 *
 * ### pino
 *
 * ```ts
 * import pino from "pino";
 * const pinoLogger = pino({ level: "info" });
 *
 * const log: Logger = {
 *   info:  (msg, meta = {}) => pinoLogger.info(meta, msg),
 *   warn:  (msg, meta = {}) => pinoLogger.warn(meta, msg),
 *   error: (msg, meta = {}) => pinoLogger.error(meta, msg),
 * };
 * const solver = new Solver(config, executor, log);
 * ```
 *
 * ### Per-intent correlation
 *
 * Wrap the logger with a fixed `intentHash` so every message in a single
 * intent's lifecycle carries the same stable field, greppable across both
 * the solver and relayer:
 *
 * ```ts
 * function withIntent(base: Logger, intentHash: string): Logger {
 *   return {
 *     info:  (msg, meta = {}) => base.info(msg,  { intentHash, ...meta }),
 *     warn:  (msg, meta = {}) => base.warn(msg,  { intentHash, ...meta }),
 *     error: (msg, meta = {}) => base.error(msg, { intentHash, ...meta }),
 *   };
 * }
 * // Usage: withIntent(log, record.hash).info("filling intent", { marginBps });
 * ```
 */

/** Minimal logger interface — identical to the one in solver.ts. */
export interface Logger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

/** Options for createLogger. */
export interface LoggerOptions {
  /**
   * Destination stream for info/warn lines (default: process.stdout).
   * Tests can inject a writable stream or a string-collecting sink.
   */
  stdout?: { write(s: string): void };
  /**
   * Destination stream for error lines (default: process.stderr).
   */
  stderr?: { write(s: string): void };
  /**
   * Minimum log level. Lines below this level are suppressed.
   * Default: "info".
   */
  level?: "info" | "warn" | "error";
}

const LEVEL_RANK: Record<string, number> = { info: 0, warn: 1, error: 2 };

/**
 * Create a structured JSON logger for the solver.
 *
 * Every log call emits exactly one JSON line:
 *   {"ts":"…","level":"…","component":"solver","msg":"…",[...meta]}
 *
 * `intentHash`, when present in `meta`, is placed immediately after `msg`
 * for grep-friendliness and log aggregator correlation.
 */
export function createLogger(opts: LoggerOptions = {}): Logger {
  const out = opts.stdout ?? process.stdout;
  const err = opts.stderr ?? process.stderr;
  const minRank = LEVEL_RANK[opts.level ?? "info"] ?? 0;

  function write(
    stream: { write(s: string): void },
    level: string,
    msg: string,
    meta: Record<string, unknown> = {},
  ): void {
    if ((LEVEL_RANK[level] ?? 0) < minRank) return;

    const { intentHash, ...rest } = meta;
    const line: Record<string, unknown> = {
      ts: new Date().toISOString(),
      level,
      component: "solver",
      msg,
      ...(intentHash !== undefined ? { intentHash } : {}),
      ...rest,
    };
    stream.write(JSON.stringify(line) + "\n");
  }

  return {
    info:  (msg, meta) => write(out, "info",  msg, meta),
    warn:  (msg, meta) => write(out, "warn",  msg, meta),
    error: (msg, meta) => write(err, "error", msg, meta),
  };
}
