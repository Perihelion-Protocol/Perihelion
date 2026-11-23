// SPDX-License-Identifier: MIT

/**
 * Issue #1145 — CI regression and invariant suite for cross-chain protocol
 * constants codegen (`contracts/shared/protocol-constants.json` ->
 * Solidity, Soroban Rust, TypeScript SDK, solver, and relayer).
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import {
  REPO_ROOT,
  RUST_OUT_PATH,
  SOLIDITY_OUT_PATH,
  SOURCE_PATH,
  TS_OUT_PATH,
  checkConsumerWiring,
  generateOrCheckProtocolConstants,
  loadProtocolConstants,
  renderRust,
  renderSolidity,
  renderTypeScript,
  validateProtocolConstants,
} from "../gen-protocol-constants.mjs";

function cloneConstants(data = loadProtocolConstants()) {
  return JSON.parse(JSON.stringify(data));
}

test("contracts/shared/protocol-constants.json loads and satisfies all protocol inequalities", () => {
  const data = loadProtocolConstants();
  assert.equal(data.timing.MIN_DISPATCH_WINDOW, 1800);
  assert.equal(data.timing.CROSS_CHAIN_LATENCY_BUDGET, 1200);
  assert.equal(data.timing.MIN_CONFIRMATION_GRACE, 3000);
  assert.equal(data.timing.MAX_CONFIRMATION_GRACE, 604800);
  assert.equal(data.timing.MIN_FILL_HEADROOM_SECS, 1920);
  assert.equal(data.timing.MAX_DEADLINE_HORIZON, 604800);
  assert.equal(data.timing.SAFETY_MARGIN, 600);

  assert.equal(data.wire.PROTOCOL_VERSION, 1);
  assert.equal(data.wire.MSG_FILL_INSTRUCTION, 1);
  assert.equal(data.wire.MSG_FILL_CONFIRMED, 2);
  assert.equal(data.wire.MSG_CANCEL_INTENT, 3);
  assert.equal(data.wire.FILL_INSTRUCTION_LENGTH, 227);
  assert.equal(data.wire.FILL_CONFIRMED_LENGTH, 90);
  assert.equal(data.wire.CANCEL_INTENT_LENGTH, 35);
  assert.equal(data.wire.MAX_DESTINATION_LEN, 56);
  assert.equal(data.wire.MAX_DEST_ASSET_LEN, 69);
  assert.equal(data.wire.CANCEL_REASON_EXPIRED, 0);
  assert.equal(data.wire.CANCEL_REASON_ADMIN, 1);
  assert.equal(data.wire.CANCEL_REASON_INVALID, 2);
  assert.equal(data.wire.CANCEL_REASON_LOCAL_TIMEOUT, 255);
});

test("validateProtocolConstants rejects every violated timing inequality", () => {
  // 1. Non-positive timing parameters
  for (const key of ["MIN_DISPATCH_WINDOW", "CROSS_CHAIN_LATENCY_BUDGET", "SAFETY_MARGIN"]) {
    const mutated = cloneConstants();
    mutated.timing[key] = 0;
    assert.throws(() => validateProtocolConstants(mutated), new RegExp(`${key}.*must be > 0`));
  }

  // 2. CROSS_CHAIN_LATENCY_BUDGET >= MIN_DISPATCH_WINDOW
  {
    const mutated = cloneConstants();
    mutated.timing.CROSS_CHAIN_LATENCY_BUDGET = mutated.timing.MIN_DISPATCH_WINDOW;
    assert.throws(
      () => validateProtocolConstants(mutated),
      /CROSS_CHAIN_LATENCY_BUDGET .* must be < MIN_DISPATCH_WINDOW/,
    );
  }

  // 3. MIN_CONFIRMATION_GRACE < MIN_DISPATCH_WINDOW + CROSS_CHAIN_LATENCY_BUDGET
  {
    const mutated = cloneConstants();
    mutated.timing.MIN_CONFIRMATION_GRACE =
      mutated.timing.MIN_DISPATCH_WINDOW + mutated.timing.CROSS_CHAIN_LATENCY_BUDGET - 1;
    assert.throws(
      () => validateProtocolConstants(mutated),
      /MIN_CONFIRMATION_GRACE .* must be >= MIN_DISPATCH_WINDOW .* \+ CROSS_CHAIN_LATENCY_BUDGET/,
    );
  }

  // 4. MAX_CONFIRMATION_GRACE < MIN_CONFIRMATION_GRACE
  {
    const mutated = cloneConstants();
    mutated.timing.MAX_CONFIRMATION_GRACE = mutated.timing.MIN_CONFIRMATION_GRACE - 1;
    assert.throws(
      () => validateProtocolConstants(mutated),
      /MAX_CONFIRMATION_GRACE .* must be >= MIN_CONFIRMATION_GRACE/,
    );
  }

  // 5. MIN_FILL_HEADROOM_SECS <= MIN_DISPATCH_WINDOW (catches the solver = 60 drift)
  {
    const mutated = cloneConstants();
    mutated.timing.MIN_FILL_HEADROOM_SECS = 60;
    assert.throws(
      () => validateProtocolConstants(mutated),
      /MIN_FILL_HEADROOM_SECS \(60\) must be > MIN_DISPATCH_WINDOW \(1800\)/,
    );
  }

  // 6. MAX_DEADLINE_HORIZON <= MIN_FILL_HEADROOM_SECS
  {
    const mutated = cloneConstants();
    mutated.timing.MIN_CONFIRMATION_GRACE = 3000;
    mutated.timing.MAX_CONFIRMATION_GRACE = 3000;
    mutated.timing.MIN_FILL_HEADROOM_SECS = 3000;
    mutated.timing.MAX_DEADLINE_HORIZON = 3000;
    assert.throws(
      () => validateProtocolConstants(mutated),
      /MAX_DEADLINE_HORIZON .* must be > MIN_FILL_HEADROOM_SECS/,
    );
  }

  // 7. MAX_DEADLINE_HORIZON !== MAX_CONFIRMATION_GRACE
  {
    const mutated = cloneConstants();
    mutated.timing.MAX_DEADLINE_HORIZON = mutated.timing.MAX_CONFIRMATION_GRACE + 1;
    assert.throws(
      () => validateProtocolConstants(mutated),
      /MAX_DEADLINE_HORIZON .* must equal MAX_CONFIRMATION_GRACE/,
    );
  }
});

test("validateProtocolConstants rejects every violated wire-format invariant", () => {
  // 1. MAX_DESTINATION_LEN !== 56
  {
    const mutated = cloneConstants();
    mutated.wire.MAX_DESTINATION_LEN = 55;
    assert.throws(
      () => validateProtocolConstants(mutated),
      /MAX_DESTINATION_LEN \(55\) must equal 56/,
    );
  }

  // 2. MAX_DEST_ASSET_LEN < MAX_DESTINATION_LEN
  {
    const mutated = cloneConstants();
    mutated.wire.MAX_DEST_ASSET_LEN = 50;
    assert.throws(
      () => validateProtocolConstants(mutated),
      /MAX_DEST_ASSET_LEN .* must be >= MAX_DESTINATION_LEN/,
    );
  }

  // 3. Mismatched wire message lengths
  for (const key of ["FILL_INSTRUCTION_LENGTH", "FILL_CONFIRMED_LENGTH", "CANCEL_INTENT_LENGTH"]) {
    const mutated = cloneConstants();
    mutated.wire[key] += 1;
    assert.throws(
      () => validateProtocolConstants(mutated),
      new RegExp(`Invalid wire invariant: ${key}`),
    );
  }

  // 4. Duplicate message type discriminants
  {
    const mutated = cloneConstants();
    mutated.wire.MSG_FILL_CONFIRMED = mutated.wire.MSG_FILL_INSTRUCTION;
    assert.throws(
      () => validateProtocolConstants(mutated),
      /MSG_FILL_INSTRUCTION, MSG_FILL_CONFIRMED, and MSG_CANCEL_INTENT must be pairwise distinct/,
    );
  }

  // 5. Duplicate cancel reason codes
  {
    const mutated = cloneConstants();
    mutated.wire.CANCEL_REASON_INVALID = mutated.wire.CANCEL_REASON_ADMIN;
    assert.throws(
      () => validateProtocolConstants(mutated),
      /CANCEL_REASON_\* codes must be pairwise distinct/,
    );
  }
});

test("generated Solidity, Rust, and TypeScript artifacts match checked-in files byte-for-byte", () => {
  const data = loadProtocolConstants(SOURCE_PATH);

  const solOnDisk = readFileSync(SOLIDITY_OUT_PATH, "utf8").replace(/\r\n/g, "\n");
  const rustOnDisk = readFileSync(RUST_OUT_PATH, "utf8").replace(/\r\n/g, "\n");
  const tsOnDisk = readFileSync(TS_OUT_PATH, "utf8").replace(/\r\n/g, "\n");

  assert.equal(solOnDisk, renderSolidity(data));
  assert.equal(rustOnDisk, renderRust(data));
  assert.equal(tsOnDisk, renderTypeScript(data));

  const res = generateOrCheckProtocolConstants({
    check: true,
    repoRoot: REPO_ROOT,
  });
  assert.equal(res.checked, true);
  checkConsumerWiring(REPO_ROOT);
});

test("generateOrCheckProtocolConstants({ check: true }) detects simulated file drift", () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "perihelion-constants-test-"));
  try {
    const tempSourcePath = resolve(tempRoot, "contracts/shared/protocol-constants.json");
    mkdirSync(resolve(tempRoot, "contracts/shared"), { recursive: true });
    writeFileSync(tempSourcePath, readFileSync(SOURCE_PATH, "utf8"), "utf8");

    generateOrCheckProtocolConstants({ check: false, repoRoot: tempRoot });

    // Tamper with generated sdk/src/constants.ts in tempRoot
    const tempTsPath = resolve(tempRoot, "sdk/src/constants.ts");
    const tampered = readFileSync(tempTsPath, "utf8").replace("1_920", "60");
    writeFileSync(tempTsPath, tampered, "utf8");

    assert.throws(
      () => generateOrCheckProtocolConstants({ check: true, repoRoot: tempRoot }),
      /Generated protocol constants are out of date \(sdk\/src\/constants\.ts\)/,
    );
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
