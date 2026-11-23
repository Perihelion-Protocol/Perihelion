// SPDX-License-Identifier: MIT

/**
 * Issue #1145 — verifies that every cross-chain timing and wire-format
 * constant exported by `@perihelion/sdk` (and re-exported by the solver and
 * relayer) matches `contracts/shared/protocol-constants.json` and satisfies
 * all cross-chain protocol inequalities.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import * as sdkConstants from "../src/constants.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SOURCE_JSON_PATH = resolve(__dirname, "../../contracts/shared/protocol-constants.json");

const sourceData = JSON.parse(readFileSync(SOURCE_JSON_PATH, "utf8")) as {
  timing: Record<string, number>;
  wire: Record<string, number>;
};

test("sdk/src/constants.ts exports every constant from protocol-constants.json", () => {
  for (const [key, expected] of Object.entries(sourceData.timing)) {
    assert.equal(
      (sdkConstants as Record<string, unknown>)[key],
      expected,
      `sdkConstants.${key} mismatch`,
    );
  }

  for (const [key, expected] of Object.entries(sourceData.wire)) {
    assert.equal(
      (sdkConstants as Record<string, unknown>)[key],
      expected,
      `sdkConstants.${key} mismatch`,
    );
  }

  assert.equal(sdkConstants.MAX_DEADLINE_HORIZON_SEC, sdkConstants.MAX_DEADLINE_HORIZON);

  const sdkIndexSrc = readFileSync(resolve(__dirname, "../src/index.ts"), "utf8");
  assert.ok(
    sdkIndexSrc.includes('export * from "./constants.js";'),
    "sdk/src/index.ts must re-export all generated constants from ./constants.js",
  );
});

test("exported SDK constants satisfy all cross-chain timing and wire-format inequalities", () => {
  const {
    MIN_DISPATCH_WINDOW,
    CROSS_CHAIN_LATENCY_BUDGET,
    MIN_CONFIRMATION_GRACE,
    MAX_CONFIRMATION_GRACE,
    MIN_FILL_HEADROOM_SECS,
    MAX_DEADLINE_HORIZON,
    SAFETY_MARGIN,
    FILL_INSTRUCTION_LENGTH,
    FILL_CONFIRMED_LENGTH,
    CANCEL_INTENT_LENGTH,
    MAX_DESTINATION_LEN,
    MAX_DEST_ASSET_LEN,
  } = sdkConstants;

  assert.ok(MIN_DISPATCH_WINDOW > 0);
  assert.ok(CROSS_CHAIN_LATENCY_BUDGET > 0);
  assert.ok(SAFETY_MARGIN > 0);
  assert.ok(CROSS_CHAIN_LATENCY_BUDGET < MIN_DISPATCH_WINDOW);
  assert.ok(MIN_CONFIRMATION_GRACE >= MIN_DISPATCH_WINDOW + CROSS_CHAIN_LATENCY_BUDGET);
  assert.ok(MAX_CONFIRMATION_GRACE >= MIN_CONFIRMATION_GRACE);
  assert.ok(MIN_FILL_HEADROOM_SECS > MIN_DISPATCH_WINDOW);
  assert.ok(MAX_DEADLINE_HORIZON > MIN_FILL_HEADROOM_SECS);
  assert.equal(MAX_DEADLINE_HORIZON, MAX_CONFIRMATION_GRACE);

  assert.equal(MAX_DESTINATION_LEN, 56);
  assert.ok(MAX_DEST_ASSET_LEN >= MAX_DESTINATION_LEN);
  assert.equal(
    FILL_INSTRUCTION_LENGTH,
    1 + 1 + 32 + 4 + MAX_DESTINATION_LEN + MAX_DEST_ASSET_LEN + 16 + 8 + 32 + 8,
  );
  assert.equal(FILL_CONFIRMED_LENGTH, 1 + 1 + 32 + 32 + 16 + 8);
  assert.equal(CANCEL_INTENT_LENGTH, 1 + 1 + 32 + 1);
});

test("solver and relayer consume generated constants from @perihelion/sdk without local drift", () => {
  const solverExecutorSrc = readFileSync(
    resolve(__dirname, "../../solver/src/executor.ts"),
    "utf8",
  );
  assert.ok(
    !solverExecutorSrc.includes("MIN_FILL_HEADROOM_SECS = 60"),
    "solver/src/executor.ts must not contain drifted MIN_FILL_HEADROOM_SECS = 60",
  );
  assert.ok(
    solverExecutorSrc.includes("MIN_FILL_HEADROOM_SECS"),
    "solver/src/executor.ts must import and re-export MIN_FILL_HEADROOM_SECS from @perihelion/sdk",
  );

  const relayerTypesSrc = readFileSync(resolve(__dirname, "../../relayer/src/types.ts"), "utf8");
  for (const name of [
    "FILL_INSTRUCTION_LENGTH",
    "FILL_CONFIRMED_LENGTH",
    "CANCEL_INTENT_LENGTH",
    "CANCEL_REASON_EXPIRED",
    "CANCEL_REASON_ADMIN",
    "CANCEL_REASON_INVALID",
  ]) {
    assert.ok(
      relayerTypesSrc.includes(name),
      `relayer/src/types.ts must import/re-export ${name} from @perihelion/sdk`,
    );
  }
});
