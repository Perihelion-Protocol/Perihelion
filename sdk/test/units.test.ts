// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { toSmallestUnits, fromSmallestUnits, evmAddressToBytes32 } from "../src/units.js";

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

// ---------------------------------------------------------------------------
// Issue #946 — evmAddressToBytes32 must left-pad the address (bytes 12-31)
// so the EVM escrow's `_decodeFillConfirmed` accepts the `solver_evm` word.
// ---------------------------------------------------------------------------

test("evmAddressToBytes32 returns exactly 32 bytes", () => {
  const out = evmAddressToBytes32("0x00000000000000000000000000000000000000aa");
  assert.equal(out.length, 32);
});

test("evmAddressToBytes32 zero-pads the first 12 bytes and copies the address into the last 20", () => {
  const addr = "0x1234567890abcdef1234567890abcdef12345678";
  const out = evmAddressToBytes32(addr);
  assert.equal(out.length, 32);
  for (let i = 0; i < 12; i++) {
    assert.equal(out[i], 0, `byte ${i} should be zero`);
  }
  const expectedTail = Buffer.from(addr.slice(2), "hex");
  assert.deepEqual(out.subarray(12), expectedTail);
});

test("evmAddressToBytes32 produces the golden vector for 0x...aa", () => {
  const out = evmAddressToBytes32("0x00000000000000000000000000000000000000aa");
  assert.equal(
    "0x" + out.toString("hex"),
    "0x00000000000000000000000000000000000000000000000000000000000000aa",
  );
});

test("evmAddressToBytes32 matches the solver_evm word in the shared wire vector", () => {
  const vectorPath = fileURLToPath(
    new URL("../../contracts/shared/wire-vectors/fill_confirmed.hex", import.meta.url),
  );
  const hex = readFileSync(vectorPath, "utf8").trim().replace(/^0x/, "");
  const vector = Buffer.from(hex, "hex");
  // solver_evm occupies bytes 34-65 of the FillConfirmed message.
  const solverWord = vector.subarray(34, 66);
  const addr = "0x" + solverWord.subarray(12).toString("hex");
  const out = evmAddressToBytes32(addr);
  assert.deepEqual(out, solverWord);
  // Sanity: the upper 12 bytes must be zero, as the EVM decoder requires.
  assert.deepEqual(solverWord.subarray(0, 12), Buffer.alloc(12));
});
