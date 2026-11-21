// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import test from "node:test";

import { BackoffState, FatalError, createLogger } from "../src/index.js";

test("shared backoff resets after success", () => {
  const backoff = new BackoffState({ pollIntervalMs: 100, maxJitterMs: 0 }, () => 0);
  backoff.recordFailure();
  assert.equal(backoff.nextDelay(), 200);
  backoff.recordSuccess();
  assert.equal(backoff.nextDelay(), 100);
});

test("shared logger keeps component and intent correlation", () => {
  const lines: string[] = [];
  const log = createLogger({ component: "solver", stdout: { write: (line) => lines.push(line) } });
  log.info("filled", { intentHash: "0xabc", result: "ok" });
  assert.deepEqual(JSON.parse(lines[0]!), {
    ts: JSON.parse(lines[0]!).ts,
    level: "info",
    component: "solver",
    msg: "filled",
    intentHash: "0xabc",
    result: "ok",
  });
});

test("FatalError preserves its cause", () => {
  const cause = new Error("rpc");
  const error = new FatalError("fatal", cause);
  assert.equal(error.cause, cause);
});
