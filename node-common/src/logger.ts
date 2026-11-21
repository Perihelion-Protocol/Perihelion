// SPDX-License-Identifier: MIT

export interface Logger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

export const noopLogger: Logger = { info() {}, warn() {}, error() {} };

export type Component = "relayer" | "solver";

export interface LoggerOptions {
  stdout?: { write(s: string): void };
  stderr?: { write(s: string): void };
  component?: Component;
  level?: "info" | "warn" | "error";
}

const LEVEL_RANK: Record<string, number> = { info: 0, warn: 1, error: 2 };

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
    const { intentHash, ...rest } = meta;
    stream.write(
      JSON.stringify({
        ts: new Date().toISOString(),
        level,
        component,
        msg,
        ...(intentHash !== undefined ? { intentHash } : {}),
        ...rest,
      }) + "\n",
    );
  }

  return {
    info: (msg, meta) => write(out, "info", msg, meta),
    warn: (msg, meta) => write(out, "warn", msg, meta),
    error: (msg, meta) => write(err, "error", msg, meta),
  };
}
