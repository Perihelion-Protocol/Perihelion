/**
 * Tests for the structured JSON logger (Issue 1).
 *
 * Validates:
 * - Every log call emits exactly one JSON line
 * - Stable fields (ts, level, component, msg) are always present
 * - intentHash is promoted to appear right after msg
 * - Meta fields are included
 * - Level filtering works correctly
 * - error goes to stderr, info/warn go to stdout
 * - Output is consistent across calls (stable JSON keys)
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { createLogger } from "../src/logger.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Collects written strings. */
function sink(): { lines: string[]; stream: { write(s: string): void } } {
  const lines: string[] = [];
  return {
    lines,
    stream: { write(s: string) { lines.push(s); } },
  };
}

function parseLine(s: string): Record<string, unknown> {
  return JSON.parse(s.trimEnd());
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("logger: info emits a single JSON line to stdout", () => {
  const out = sink();
  const err = sink();
  const log = createLogger({ stdout: out.stream, stderr: err.stream, component: "relayer" });

  log.info("relayer started", { cursor: 42 });

  assert.equal(out.lines.length, 1, "expected exactly one line");
  assert.equal(err.lines.length, 0, "nothing written to stderr for info");
  const obj = parseLine(out.lines[0]!);
  assert.equal(obj.level, "info");
  assert.equal(obj.msg, "relayer started");
  assert.equal(obj.component, "relayer");
  assert.equal(obj.cursor, 42);
  assert.ok(typeof obj.ts === "string" && obj.ts.length > 0, "ts field present");
});

test("logger: warn emits to stdout with level=warn", () => {
  const out = sink();
  const err = sink();
  const log = createLogger({ stdout: out.stream, stderr: err.stream, component: "relayer" });

  log.warn("delivery failed", { attempt: 1 });

  assert.equal(out.lines.length, 1);
  assert.equal(err.lines.length, 0);
  const obj = parseLine(out.lines[0]!);
  assert.equal(obj.level, "warn");
  assert.equal(obj.msg, "delivery failed");
  assert.equal(obj.attempt, 1);
});

test("logger: error emits to stderr with level=error", () => {
  const out = sink();
  const err = sink();
  const log = createLogger({ stdout: out.stream, stderr: err.stream, component: "relayer" });

  log.error("DEAD_LETTER", { intentHash: "0xabc", attempts: 5 });

  assert.equal(err.lines.length, 1, "error goes to stderr");
  assert.equal(out.lines.length, 0, "nothing written to stdout for error");
  const obj = parseLine(err.lines[0]!);
  assert.equal(obj.level, "error");
  assert.equal(obj.msg, "DEAD_LETTER");
});

test("logger: intentHash is promoted to appear after msg", () => {
  const out = sink();
  const log = createLogger({ stdout: out.stream, stderr: out.stream, component: "relayer" });

  log.info("delivered", { intentHash: "0xdeadbeef", dstTxHash: "0x123" });

  const obj = parseLine(out.lines[0]!);
  const keys = Object.keys(obj);
  const msgIdx = keys.indexOf("msg");
  const hashIdx = keys.indexOf("intentHash");
  assert.ok(msgIdx >= 0, "msg present");
  assert.ok(hashIdx >= 0, "intentHash present");
  assert.ok(hashIdx > msgIdx, `intentHash (${hashIdx}) should come after msg (${msgIdx})`);
  assert.equal(obj.intentHash, "0xdeadbeef");
  assert.equal(obj.dstTxHash, "0x123");
});

test("logger: log line without intentHash in meta has no intentHash field", () => {
  const out = sink();
  const log = createLogger({ stdout: out.stream, stderr: out.stream, component: "relayer" });

  log.info("relayer started", { cursor: 0 });

  const obj = parseLine(out.lines[0]!);
  assert.ok(!("intentHash" in obj), "no intentHash field when not in meta");
});

test("logger: output is valid single-line JSON (no embedded newlines)", () => {
  const out = sink();
  const log = createLogger({ stdout: out.stream, stderr: out.stream, component: "relayer" });

  log.info("test", { msg: "embedded\nnewline" });

  const raw = out.lines[0]!;
  // The written string ends with exactly one newline.
  assert.ok(raw.endsWith("\n"), "line ends with newline");
  // The JSON body itself has no unescaped newlines.
  const jsonBody = raw.trimEnd();
  assert.ok(!jsonBody.includes("\n"), "no unescaped newlines in JSON body");
  // It must parse cleanly.
  assert.doesNotThrow(() => JSON.parse(jsonBody));
});

test("logger: level filter suppresses lines below min level", () => {
  const out = sink();
  const log = createLogger({ stdout: out.stream, stderr: out.stream, component: "relayer", level: "error" });

  log.info("suppressed");
  log.warn("also suppressed");
  log.error("visible", { x: 1 });

  assert.equal(out.lines.length, 1, "only error line passes through");
  const obj = parseLine(out.lines[0]!);
  assert.equal(obj.level, "error");
});

test("logger: component field is included in every line", () => {
  const out = sink();
  const log = createLogger({ stdout: out.stream, stderr: out.stream, component: "solver" });

  log.info("solver started");
  log.warn("tick slow");
  log.error("fatal", {});

  for (const line of out.lines) {
    const obj = parseLine(line);
    assert.equal(obj.component, "solver");
  }
});

test("logger: no meta does not crash", () => {
  const out = sink();
  const log = createLogger({ stdout: out.stream, stderr: out.stream, component: "relayer" });

  assert.doesNotThrow(() => log.info("bare message"));
  assert.equal(out.lines.length, 1);
  const obj = parseLine(out.lines[0]!);
  assert.equal(obj.msg, "bare message");
});
