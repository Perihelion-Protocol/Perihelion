/**
 * Tests for the solver structured JSON logger (Issue 1 - solver side).
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { createLogger } from "../src/logger.js";

function sink(): { lines: string[]; stream: { write(s: string): void } } {
  const lines: string[] = [];
  return { lines, stream: { write(s) { lines.push(s); } } };
}

function parse(s: string): Record<string, unknown> {
  return JSON.parse(s.trimEnd());
}

test("solver logger: component is always 'solver'", () => {
  const out = sink();
  const log = createLogger({ stdout: out.stream, stderr: out.stream });
  log.info("started");
  const obj = parse(out.lines[0]!);
  assert.equal(obj.component, "solver");
});

test("solver logger: info emits single JSON line to stdout", () => {
  const out = sink();
  const err = sink();
  const log = createLogger({ stdout: out.stream, stderr: err.stream });
  log.info("filling intent", { intentHash: "0xabc", marginBps: 15 });
  assert.equal(out.lines.length, 1);
  assert.equal(err.lines.length, 0);
  const obj = parse(out.lines[0]!);
  assert.equal(obj.level, "info");
  assert.equal(obj.intentHash, "0xabc");
  assert.equal(obj.marginBps, 15);
});

test("solver logger: error emits to stderr", () => {
  const out = sink();
  const err = sink();
  const log = createLogger({ stdout: out.stream, stderr: err.stream });
  log.error("fill failed", { err: "revert" });
  assert.equal(err.lines.length, 1);
  assert.equal(out.lines.length, 0);
});

test("solver logger: intentHash promoted after msg", () => {
  const out = sink();
  const log = createLogger({ stdout: out.stream, stderr: out.stream });
  log.info("filled", { intentHash: "0x123", settlementTx: "0xabc" });
  const obj = parse(out.lines[0]!);
  const keys = Object.keys(obj);
  const msgIdx = keys.indexOf("msg");
  const hashIdx = keys.indexOf("intentHash");
  assert.ok(hashIdx > msgIdx, "intentHash after msg");
});

test("solver logger: level filter suppresses info when set to warn", () => {
  const out = sink();
  const log = createLogger({ stdout: out.stream, stderr: out.stream, level: "warn" });
  log.info("suppressed");
  log.warn("visible");
  assert.equal(out.lines.length, 1);
  assert.equal(parse(out.lines[0]!).level, "warn");
});

test("solver logger: output is valid parseable JSON", () => {
  const out = sink();
  const log = createLogger({ stdout: out.stream, stderr: out.stream });
  log.info("test", { nested: { a: 1 } });
  assert.doesNotThrow(() => JSON.parse(out.lines[0]!.trimEnd()));
});
