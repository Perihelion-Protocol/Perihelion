/**
 * Structured JSON logger for the Perihelion relayer.
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
 * | component   | string | "relayer" (static, aids multi-component filtering) |
 * | intentHash  | string | Present when the meta object contains intentHash   |
 * | …meta       | any    | All other keys from the meta object are spread in  |
 *
 * ## Usage
 *
 * ```ts
 * import { createLogger } from "./logger.js";
 *
 * // Default: writes to process.stdout / process.stderr
 * const log = createLogger();
 * log.info("relayer started", { escrow: "0x…", cursor: 42 });
 * // → {"ts":"2024-01-01T00:00:00.000Z","level":"info","component":"relayer","msg":"relayer started","escrow":"0x…","cursor":42}
 *
 * log.info("delivered", { intentHash: "0xabc…", dstTxHash: "0xdef…" });
 * // → {"ts":"…","level":"info","component":"relayer","msg":"delivered","intentHash":"0xabc…","dstTxHash":"0xdef…"}
 * ```
 *
 * ## Injecting a production logger (pino / winston)
 *
 * The relayer and solver accept a `Logger` interface:
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
 * const relayer = new Relayer(config, watcher, delivery, log);
 * ```
 *
 * ### winston
 *
 * ```ts
 * import winston from "winston";
 * const winstonLogger = winston.createLogger({
 *   format: winston.format.json(),
 *   transports: [new winston.transports.Console()],
 * });
 *
 * const log: Logger = {
 *   info:  (msg, meta = {}) => winstonLogger.info(msg, meta),
 *   warn:  (msg, meta = {}) => winstonLogger.warn(msg, meta),
 *   error: (msg, meta = {}) => winstonLogger.error(msg, meta),
 * };
 * const relayer = new Relayer(config, watcher, delivery, log);
 * ```
 *
 * ### Per-intent correlation
 *
 * Wrap the logger with a fixed `intentHash` so every message in a single
 * intent's lifecycle carries the same stable field:
 *
 * ```ts
 * function withIntent(base: Logger, intentHash: string): Logger {
 *   return {
 *     info:  (msg, meta = {}) => base.info(msg,  { intentHash, ...meta }),
 *     warn:  (msg, meta = {}) => base.warn(msg,  { intentHash, ...meta }),
 *     error: (msg, meta = {}) => base.error(msg, { intentHash, ...meta }),
 *   };
 * }
 * ```
 *
 * Pass the wrapped logger when calling `relayer.relayOne` or `solver.consider`
 * to correlate every log line for a single intent across the relayer and solver.
 */

/** Minimal logger interface — identical to the one in relayer.ts and solver.ts. */
export interface Logger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

/** Component tag written into every log line. */
export type Component = "relayer" | "solver";

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
  /** Component tag included in every log line. Default: "relayer". */
  component?: Component;
  /**
   * Minimum log level. Lines below this level are suppressed.
   * Default: "info". Set to "error" in tests to silence noise.
   */
  level?: "info" | "warn" | "error";
}

const LEVEL_RANK: Record<string, number> = { info: 0, warn: 1, error: 2 };

/**
 * Create a structured JSON logger.
 *
 * Every log call emits exactly one JSON line:
 *   {"ts":"…","level":"…","component":"…","msg":"…",[...meta]}
 *
 * `intentHash`, when present in `meta`, is always placed immediately after
 * `msg` for grep-friendliness.
 */
export function createLogger(opts: LoggerOptions = {}): Logger {
  const out = opts.stdout ?? process.stdout;
  const err = opts.stderr ?? process.stderr;
  const component = opts.component ?? "relayer";
  const minRank = LEVEL_RANK[opts.level ?? "info"] ?? 0;

  function write(
    stream: { write(s: string): void },
    level: string,
    msg: string,
    meta: Record<string, unknown> = {},
  ): void {
    if ((LEVEL_RANK[level] ?? 0) < minRank) return;

    // Pull intentHash to the front if present so it appears near msg in the JSON.
    const { intentHash, ...rest } = meta;
    const line: Record<string, unknown> = {
      ts: new Date().toISOString(),
      level,
      component,
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
