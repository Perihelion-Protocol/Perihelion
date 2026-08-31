// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { test } from "node:test";
import { toSmallestUnits, fromSmallestUnits } from "../src/units.js";

// ---------------------------------------------------------------------------
// Issue #533 — fromSmallestUnits mishandles negative input and lacks string
// validation, e.g. fromSmallestUnits("-1500000", 6) used to produce the
// malformed string "1.-5" because BigInt's `%` retains the sign of the
// dividend.
// ---------------------------------------------------------------------------

test("fromSmallestUnits formats a negative amount with a single leading sign", () => {
  assert.equal(fromSmallestUnits("-1500000", 6), "-1.5");
});

test("fromSmallestUnits formats a negative whole-number amount", () => {
  assert.equal(fromSmallestUnits("-1000000", 6), "-1");
});

test("fromSmallestUnits formats a negative fractional-only amount (< 1 unit)", () => {
  assert.equal(fromSmallestUnits("-500000", 6), "-0.5");
});

test("fromSmallestUnits never emits a negative zero", () => {
  assert.equal(fromSmallestUnits("-0", 6), "0");
  assert.equal(fromSmallestUnits("0", 6), "0");
});

test("fromSmallestUnits formats positive amounts unaffected by the sign fix", () => {
  assert.equal(fromSmallestUnits("1500000", 6), "1.5");
  assert.equal(fromSmallestUnits("1000000", 6), "1");
  assert.equal(fromSmallestUnits("1", 7), "0.0000001");
});

test("fromSmallestUnits rejects malformed input with a clear, named error (not a raw SyntaxError)", () => {
  for (const bad of ["1.5", "abc", "", "0x1", "1_000", "--1", "1-"]) {
    assert.throws(
      () => fromSmallestUnits(bad, 6),
      (err: unknown) => err instanceof Error && !(err instanceof SyntaxError) && /invalid amount/.test(err.message),
      `expected a clear error for ${JSON.stringify(bad)}`,
    );
  }
});

test("fromSmallestUnits rejects an invalid decimals argument", () => {
  assert.throws(() => fromSmallestUnits("100", -1), /decimals/);
  assert.throws(() => fromSmallestUnits("100", 1.5), /decimals/);
  assert.throws(() => fromSmallestUnits("100", 37), /decimals/);
});

// ---------------------------------------------------------------------------
// Round-tripping with toSmallestUnits
// ---------------------------------------------------------------------------

test("fromSmallestUnits round-trips exactly with toSmallestUnits across a range of amounts and decimals", () => {
  const cases: Array<[string, number]> = [
    ["0", 6],
    ["1", 6],
    ["1.5", 6],
    ["0.000001", 6],
    ["123456789.987654", 6],
    ["0.9900000", 7],
    ["100", 0],
    ["1", 18],
    ["0.000000000000000001", 18],
  ];
  for (const [human, decimals] of cases) {
    const smallest = toSmallestUnits(human, decimals);
    const back = fromSmallestUnits(smallest, decimals);
    // Both sides should agree on the canonical (trailing-zero-stripped) form.
    assert.equal(
      toSmallestUnits(back, decimals),
      smallest,
      `round-trip mismatch for ${human} @ ${decimals}dp (got ${back})`,
    );
  }
});

test("fromSmallestUnits negative output round-trips back through Math.abs + toSmallestUnits", () => {
  const smallest = "-1500000";
  const human = fromSmallestUnits(smallest, 6);
  assert.equal(human, "-1.5");
  assert.equal(toSmallestUnits(human.slice(1), 6), smallest.slice(1));
});
