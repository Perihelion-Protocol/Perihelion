// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { test } from "node:test";
import { SolverMetrics } from "../src/metrics.js";

const ASSET = "USDC:GA5Z";

test("initial snapshot has empty corridors and zero fees", () => {
  const m = new SolverMetrics();
  const snap = m.snapshot();
  assert.deepEqual(snap.corridors, {});
  assert.equal(snap.totalFeesWei, 0n);
  assert.deepEqual(snap.skipReasons, {});
});

test("recordFillAttempt increments fillsAttempted", () => {
  const m = new SolverMetrics();
  m.recordFillAttempt(ASSET);
  m.recordFillAttempt(ASSET);
  assert.equal(m.snapshot().corridors[ASSET]?.fillsAttempted, 2);
});

test("recordFillWon increments fillsWon and computes profit", () => {
  const m = new SolverMetrics();
  // 10_000_000 units at 100 bps margin → profit = 10_000_000 * 100 / 10_000 = 100_000
  m.recordFillWon(ASSET, 10_000_000n, 100);
  const c = m.snapshot().corridors[ASSET]!;
  assert.equal(c.fillsWon, 1);
  assert.equal(c.realizedProfitSmallestUnits, 100_000n);
});

test("realized profit accumulates over multiple fills", () => {
  const m = new SolverMetrics();
  m.recordFillWon(ASSET, 10_000_000n, 100); // 100_000
  m.recordFillWon(ASSET, 5_000_000n, 200);  // 100_000
  assert.equal(
    m.snapshot().corridors[ASSET]?.realizedProfitSmallestUnits,
    200_000n,
  );
});

test("recordFillLost increments fillsLost", () => {
  const m = new SolverMetrics();
  m.recordFillLost(ASSET, "revert");
  assert.equal(m.snapshot().corridors[ASSET]?.fillsLost, 1);
});

test("recordSkip counts by reason", () => {
  const m = new SolverMetrics();
  m.recordSkip("intent expired");
  m.recordSkip("intent expired");
  m.recordSkip("insufficient inventory");
  const snap = m.snapshot();
  assert.equal(snap.skipReasons["intent expired"], 2);
  assert.equal(snap.skipReasons["insufficient inventory"], 1);
});

test("recordFee accumulates", () => {
  const m = new SolverMetrics();
  m.recordFee(1_000n);
  m.recordFee(2_000n);
  assert.equal(m.snapshot().totalFeesWei, 3_000n);
  assert.equal(m.snapshot().sourceGasWei, 3_000n);
});

test("recordFees tracks source gas, lz fee, and stellar fees separately", () => {
  const m = new SolverMetrics();
  m.recordFees({
    sourceGasWei: 50_000n,
    lzFeeWei: 12_000n,
    stellarFeeStroops: 10_000n,
  });
  const snap = m.snapshot();
  assert.equal(snap.sourceGasWei, 50_000n);
  assert.equal(snap.lzFeeWei, 12_000n);
  assert.equal(snap.stellarFeeStroops, 10_000n);
  assert.equal(snap.totalFeesWei, 62_000n);

  const text = m.toPrometheusText();
  assert.ok(text.includes("# HELP solver_source_gas_wei"));
  assert.ok(text.includes("# TYPE solver_source_gas_wei counter"));
  assert.ok(text.includes("solver_source_gas_wei 50000"));
  assert.ok(text.includes("# HELP solver_lz_fee_wei"));
  assert.ok(text.includes("# TYPE solver_lz_fee_wei counter"));
  assert.ok(text.includes("solver_lz_fee_wei 12000"));
  assert.ok(text.includes("# HELP solver_stellar_fee_stroops"));
  assert.ok(text.includes("# TYPE solver_stellar_fee_stroops counter"));
  assert.ok(text.includes("solver_stellar_fee_stroops 10000"));
});

test("toPrometheusText includes expected metric names", () => {
  const m = new SolverMetrics();
  m.recordFillAttempt(ASSET);
  m.recordFillWon(ASSET, 10_000_000n, 50);
  m.recordFillLost(ASSET, "revert");
  m.recordSkip("intent expired");
  m.recordFee(500n);
  const text = m.toPrometheusText();
  assert.ok(text.includes("solver_fills_attempted"));
  assert.ok(text.includes("solver_fills_won"));
  assert.ok(text.includes("solver_fills_lost"));
  assert.ok(text.includes("solver_realized_profit_units"));
  assert.ok(text.includes("solver_fees_total_wei"));
  assert.ok(text.includes(`solver_skips_total{reason="intent expired"}`));
});

test("snapshot is a defensive copy (mutations don't affect later snapshots)", () => {
  const m = new SolverMetrics();
  m.recordFillAttempt(ASSET);
  const snap1 = m.snapshot();
  snap1.corridors[ASSET]!.fillsAttempted = 999;
  const snap2 = m.snapshot();
  assert.equal(snap2.corridors[ASSET]?.fillsAttempted, 1);
});

test("toPrometheusText includes HELP and TYPE lines for all series", () => {
  const m = new SolverMetrics();
  const text = m.toPrometheusText();
  assert.ok(text.includes("# HELP solver_fills_attempted"));
  assert.ok(text.includes("# TYPE solver_fills_attempted counter"));
  assert.ok(text.includes("# HELP solver_fees_total_wei"));
  assert.ok(text.includes("# TYPE solver_fees_total_wei counter"));
  assert.ok(text.includes("# HELP solver_skips_total"));
  assert.ok(text.includes("# TYPE solver_skips_total counter"));
});

test("toPrometheusText properly escapes quotes, backslashes, and newlines in label values", () => {
  const m = new SolverMetrics();
  m.recordSkip('error: "unexpected"\nline 2\\path');
  const text = m.toPrometheusText();
  assert.ok(text.includes('reason="error: \\"unexpected\\"\\nline 2\\\\path"'));
});

test("skipReasons cardinality is bounded", () => {
  const m = new SolverMetrics();
  for (let i = 0; i < 150; i++) {
    m.recordSkip(`reason_${i}`);
  }
  const snap = m.snapshot();
  assert.ok(Object.keys(snap.skipReasons).length <= 101);
  assert.ok(snap.skipReasons["other"] !== undefined);
});
