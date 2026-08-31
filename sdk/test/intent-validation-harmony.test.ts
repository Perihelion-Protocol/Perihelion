// SPDX-License-Identifier: MIT

/**
 * Issue #531 — shared edge-case table asserting `parseIntent` (inbound,
 * validate.ts) and `validateIntent` (outbound, intent.ts) agree on
 * `sourceChainId`, `sourceAmount`, and `minDestAmount` — the fields called
 * out in the issue as having drifted (parseIntent used to accept `0`, `-1`,
 * `8453.5` for sourceChainId and `"0"` for amounts, which validateIntent
 * already rejected).
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { validateIntent } from "../src/intent.js";
import { parseIntent } from "../src/validate.js";

const VALID_ADDRESS = "0x1234567890123456789012345678901234567890";
const VALID_DESTINATION = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
const VALID_DEST_ASSET = `USDC:${VALID_DESTINATION}`;
const FUTURE_DEADLINE = Math.floor(Date.now() / 1000) + 3600;

function baseParams() {
  return {
    user: VALID_ADDRESS,
    destination: VALID_DESTINATION,
    sourceChainId: 8453 as unknown,
    sourceAsset: VALID_ADDRESS,
    sourceAmount: "1000000" as unknown,
    destAsset: VALID_DEST_ASSET,
    minDestAmount: "900000" as unknown,
    deadline: FUTURE_DEADLINE,
    nonce: "1",
    preferredSolver: VALID_ADDRESS,
  };
}

/** Runs a field/value override through both validators and returns whether each accepted it. */
function agreementFor(field: "sourceChainId" | "sourceAmount" | "minDestAmount", value: unknown) {
  const params = { ...baseParams(), [field]: value };

  let validateIntentThrew = false;
  try {
    validateIntent(params as unknown as Parameters<typeof validateIntent>[0]);
  } catch {
    validateIntentThrew = true;
  }

  let parseIntentThrew = false;
  try {
    parseIntent(params);
  } catch {
    parseIntentThrew = true;
  }

  return { validateIntentThrew, parseIntentThrew };
}

const SOURCE_CHAIN_ID_CASES: Array<{ value: unknown; valid: boolean }> = [
  { value: 8453, valid: true },
  { value: 1, valid: true },
  { value: 0, valid: false },
  { value: -1, valid: false },
  { value: 8453.5, valid: false },
  { value: NaN, valid: false },
];

const AMOUNT_CASES: Array<{ value: unknown; valid: boolean }> = [
  { value: "1", valid: true },
  { value: "1000000", valid: true },
  { value: "0", valid: false },
  { value: "-1", valid: false },
  { value: "01", valid: false },
  { value: "1.5", valid: false },
];

test("parseIntent and validateIntent agree on every sourceChainId edge case", () => {
  for (const { value, valid } of SOURCE_CHAIN_ID_CASES) {
    const { validateIntentThrew, parseIntentThrew } = agreementFor("sourceChainId", value);
    assert.equal(
      validateIntentThrew,
      parseIntentThrew,
      `sourceChainId=${JSON.stringify(value)}: validateIntent threw=${validateIntentThrew}, parseIntent threw=${parseIntentThrew}`,
    );
    assert.equal(validateIntentThrew, !valid, `sourceChainId=${JSON.stringify(value)} expected valid=${valid}`);
  }
});

test("parseIntent and validateIntent agree on every sourceAmount edge case", () => {
  for (const { value, valid } of AMOUNT_CASES) {
    const { validateIntentThrew, parseIntentThrew } = agreementFor("sourceAmount", value);
    assert.equal(
      validateIntentThrew,
      parseIntentThrew,
      `sourceAmount=${JSON.stringify(value)}: validateIntent threw=${validateIntentThrew}, parseIntent threw=${parseIntentThrew}`,
    );
    assert.equal(validateIntentThrew, !valid, `sourceAmount=${JSON.stringify(value)} expected valid=${valid}`);
  }
});

test("parseIntent and validateIntent agree on every minDestAmount edge case", () => {
  for (const { value, valid } of AMOUNT_CASES) {
    const { validateIntentThrew, parseIntentThrew } = agreementFor("minDestAmount", value);
    assert.equal(
      validateIntentThrew,
      parseIntentThrew,
      `minDestAmount=${JSON.stringify(value)}: validateIntent threw=${validateIntentThrew}, parseIntent threw=${parseIntentThrew}`,
    );
    assert.equal(validateIntentThrew, !valid, `minDestAmount=${JSON.stringify(value)} expected valid=${valid}`);
  }
});
