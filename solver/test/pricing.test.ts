// SPDX-License-Identifier: MIT

import { test } from "node:test";
import assert from "node:assert/strict";
import { RATE_SCALE } from "../src/quote.js";
import { parseRateTable, priceOracleFromEnv, staticPriceOracle } from "../src/pricing.js";

test("parseRateTable: parses exact decimal rates scaled by RATE_SCALE", () => {
  const table = parseRateTable("A>B=1, native>USDC:GISSUER=0.1234");
  assert.equal(table.get("A>B"), RATE_SCALE);
  assert.equal(table.get("native>USDC:GISSUER"), 1234n * 10n ** 14n);
});

test("parseRateTable: rejects malformed, non-positive and duplicate entries", () => {
  assert.throws(() => parseRateTable("A-B=1"), /must be SOURCE>DEST=RATE/);
  assert.throws(() => parseRateTable("A>B=abc"), /invalid rate/);
  assert.throws(() => parseRateTable("A>B=0"), /non-positive rate/);
  assert.throws(() => parseRateTable("A>B=1,A>B=2"), /configured more than once/);
});

test("staticPriceOracle: returns configured rate and refuses unknown corridors", async () => {
  const oracle = staticPriceOracle(parseRateTable("A>B=2"));
  assert.equal(await oracle("A", "B"), 2n * RATE_SCALE);
  await assert.rejects(() => oracle("B", "A"), /no configured rate for corridor B -> A/);
});

test("priceOracleFromEnv: undefined when unset, oracle when configured", () => {
  assert.equal(priceOracleFromEnv({}), undefined);
  assert.equal(priceOracleFromEnv({ PERIHELION_PRICE_RATES: "  " }), undefined);
  assert.equal(typeof priceOracleFromEnv({ PERIHELION_PRICE_RATES: "A>B=1" }), "function");
});
