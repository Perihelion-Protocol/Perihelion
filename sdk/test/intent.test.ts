// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { test } from "node:test";
import { privateKeyToAccount } from "viem/accounts";
import { createWalletClient, http, zeroAddress } from "viem";
import { base } from "viem/chains";
import {
  buildIntent,
  DEFAULT_V_MIN,
  hashIntent,
  I128_MAX,
  MAX_DESTINATION_LEN,
  MAX_DEST_ASSET_LEN,
  perihelionDomain,
  U128_MAX,
  validateAmount,
  validateIntent,
  verifyIntent,
} from "../src/intent.js";
import { PerihelionClient } from "../src/client.js";
import { toSmallestUnits, fromSmallestUnits } from "../src/units.js";
import { isStellarAddress, isStellarAsset } from "../src/stellar.js";
import { PerihelionValidationError } from "../src/errors.js";

const PK = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const account = privateKeyToAccount(PK);

// Sample escrow deployment on Base (chain 8453).
const CHAIN_ID = 8453;
const CONTRACT_ADDRESS = "0x1234567890123456789012345678901234567890" as const;
const DOMAIN = perihelionDomain(CHAIN_ID, CONTRACT_ADDRESS);

// A valid G... Stellar account strkey (56 chars, base32 A-Z/2-7).
const VALID_DESTINATION = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
// A valid Stellar asset: "<CODE>:<G...ISSUER>" using the strkey above as issuer.
const VALID_DEST_ASSET = `USDC:${VALID_DESTINATION}`;

function sampleParams() {
  return {
    user: account.address,
    destination: VALID_DESTINATION,
    sourceChainId: 8453,
    sourceAsset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const,
    sourceAmount: "1000000",
    destAsset: VALID_DEST_ASSET,
    minDestAmount: "9900000",
    deadline: 4102444800, // year 2100
    nonce: "42",
  };
}

function sampleIntent() {
  return buildIntent(sampleParams());
}

test("buildIntent defaults open solver and keeps explicit nonce", () => {
  const intent = sampleIntent();
  assert.equal(intent.preferredSolver, zeroAddress);
  assert.equal(intent.nonce, "42");
});

test("hashIntent is deterministic", () => {
  assert.equal(hashIntent(sampleIntent(), DOMAIN), hashIntent(sampleIntent(), DOMAIN));
});

test("hashIntent differs across chains and contracts", () => {
  const intent = sampleIntent();
  const domainA = perihelionDomain(8453, "0x1111111111111111111111111111111111111111");
  const domainB = perihelionDomain(1, "0x1111111111111111111111111111111111111111");
  const domainC = perihelionDomain(8453, "0x2222222222222222222222222222222222222222");
  assert.notEqual(hashIntent(intent, domainA), hashIntent(intent, domainB));
  assert.notEqual(hashIntent(intent, domainA), hashIntent(intent, domainC));
});

test("verifyIntent accepts a valid signature and rejects a tampered intent", async () => {
  const intent = sampleIntent();
  const client = new PerihelionClient({
    mempoolUrl: "http://localhost",
    chainId: CHAIN_ID,
    verifyingContract: CONTRACT_ADDRESS,
  });
  const wallet = createWalletClient({ account, chain: base, transport: http() });

  const signed = await client.signIntent(wallet, intent);
  assert.equal(await verifyIntent(intent, signed.signature, DOMAIN), true);

  const tampered = { ...intent, sourceAmount: "2000000" };
  assert.equal(await verifyIntent(tampered, signed.signature, DOMAIN), false);
});

test("buildIntent warns when sourceAmount is below V_min", () => {
  const logged: string[] = [];
  const warnStub = (msg: string) => logged.push(msg);
  const originalWarn = console.warn;
  console.warn = warnStub as unknown as typeof console.warn;

  try {
    buildIntent({
      user: account.address,
      destination: VALID_DESTINATION,
      sourceChainId: 8453,
      sourceAsset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      sourceAmount: "1000", // very small amount
      destAsset: VALID_DEST_ASSET,
      minDestAmount: "900",
      deadline: 4102444800,
    });
    assert.ok(logged.length > 0, "expected console.warn to be called");
    assert.ok(logged[0].includes("below the economical minimum"));
  } finally {
    console.warn = originalWarn;
  }
});

test("buildIntent does not warn when sourceAmount is above V_min", () => {
  const logged: string[] = [];
  const warnStub = (msg: string) => logged.push(msg);
  const originalWarn = console.warn;
  console.warn = warnStub as unknown as typeof console.warn;

  try {
    buildIntent({
      user: account.address,
      destination: VALID_DESTINATION,
      sourceChainId: 8453,
      sourceAsset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      sourceAmount: "100000000", // well above default V_min
      destAsset: VALID_DEST_ASSET,
      minDestAmount: "99000000",
      deadline: 4102444800,
    });
    assert.equal(logged.length, 0, "expected no warning for amount above V_min");
  } finally {
    console.warn = originalWarn;
  }
});

test("buildIntent does not warn when sourceAmount equals V_min", () => {
  const logged: string[] = [];
  const originalWarn = console.warn;
  console.warn = ((msg: string) => logged.push(msg)) as typeof console.warn;

  try {
    buildIntent({
      user: account.address,
      destination: VALID_DESTINATION,
      sourceChainId: 8453,
      sourceAsset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      sourceAmount: DEFAULT_V_MIN,
      destAsset: VALID_DEST_ASSET,
      minDestAmount: "9000000",
      deadline: 4102444800,
    });
    assert.equal(logged.length, 0, "expected no warning at the V_min boundary");
  } finally {
    console.warn = originalWarn;
  }
});

test("buildIntent respects suppressWarning option", () => {
  const logged: string[] = [];
  const warnStub = (msg: string) => logged.push(msg);
  const originalWarn = console.warn;
  console.warn = warnStub as unknown as typeof console.warn;

  try {
    buildIntent(
      {
        user: account.address,
        destination: VALID_DESTINATION,
        sourceChainId: 8453,
        sourceAsset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        sourceAmount: "1000",
        destAsset: VALID_DEST_ASSET,
        minDestAmount: "900",
        deadline: 4102444800,
      },
      { suppressWarning: true }
    );
    assert.equal(logged.length, 0, "expected no warning when suppressWarning is true");
  } finally {
    console.warn = originalWarn;
  }
});

test("buildIntent respects custom vMin option", () => {
  const logged: string[] = [];
  const warnStub = (msg: string) => logged.push(msg);
  const originalWarn = console.warn;
  console.warn = warnStub as unknown as typeof console.warn;

  try {
    buildIntent(
      {
        user: account.address,
        destination: VALID_DESTINATION,
        sourceChainId: 8453,
        sourceAsset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        sourceAmount: "50000000", // 50 USD
        destAsset: VALID_DEST_ASSET,
        minDestAmount: "49000000",
        deadline: 4102444800,
      },
      { vMin: "100000000" } // 100 USD minimum
    );
    assert.ok(logged.length > 0, "expected warning with custom vMin");
  } finally {
    console.warn = originalWarn;
  }
});

// V_min boundary: sourceAmount exactly equal to vMin must not trigger a warning.
test("buildIntent does not warn when sourceAmount equals vMin exactly", () => {
  const logged: string[] = [];
  const warnStub = (msg: string) => logged.push(msg);
  const originalWarn = console.warn;
  console.warn = warnStub as unknown as typeof console.warn;

  try {
    buildIntent(
      {
        user: account.address,
        destination: VALID_DESTINATION,
        sourceChainId: 8453,
        sourceAsset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        // sourceAmount === DEFAULT_V_MIN: at the boundary, no warning should fire.
        sourceAmount: DEFAULT_V_MIN,
        destAsset: VALID_DEST_ASSET,
        minDestAmount: "9900000",
        deadline: 4102444800,
      }
    );
    assert.equal(logged.length, 0, "expected no warning when sourceAmount === vMin (boundary is exclusive)");
  } finally {
    console.warn = originalWarn;
  }
});

// ---------------------------------------------------------------------------
// Issue #57 — Amount boundary conformance vectors
//
// These tests assert the exact boundary conditions documented in
// docs/intent-spec.md §Amount Field Specification.
// ---------------------------------------------------------------------------

// --- validateAmount unit tests ---------------------------------------------

test("validateAmount: zero is rejected", () => {
  assert.throws(() => validateAmount("0", "sourceAmount"), PerihelionValidationError);
});

test("validateAmount: 1 is accepted", () => {
  assert.doesNotThrow(() => validateAmount("1", "sourceAmount"));
});

test("validateAmount: i128::MAX is accepted for minDestAmount", () => {
  assert.doesNotThrow(() => validateAmount(I128_MAX.toString(), "minDestAmount", I128_MAX));
});

test("validateAmount: i128::MAX + 1 is rejected for minDestAmount", () => {
  assert.throws(
    () => validateAmount((I128_MAX + 1n).toString(), "minDestAmount", I128_MAX),
    PerihelionValidationError
  );
});

test("validateAmount: u128::MAX is accepted for sourceAmount", () => {
  assert.doesNotThrow(() => validateAmount(U128_MAX.toString(), "sourceAmount", U128_MAX));
});

test("validateAmount: u128::MAX + 1 is rejected for sourceAmount", () => {
  assert.throws(
    () => validateAmount((U128_MAX + 1n).toString(), "sourceAmount", U128_MAX),
    PerihelionValidationError
  );
});

test("validateAmount: negative string is rejected", () => {
  assert.throws(() => validateAmount("-1", "sourceAmount"), PerihelionValidationError);
});

// --- buildIntent enforces amount bounds ------------------------------------

test("buildIntent rejects sourceAmount of zero", () => {
  assert.throws(
    () =>
      buildIntent({
        user: account.address,
        destination: VALID_DESTINATION,
        sourceChainId: 8453,
        sourceAsset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        sourceAmount: "0",
        destAsset: "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
        minDestAmount: "1",
        deadline: 4102444800,
      }),
    // Zero fails the positive-integer format check before the range check,
    // so it surfaces as a PerihelionValidationError rather than a RangeError.
    PerihelionValidationError
  );
});

test("buildIntent rejects minDestAmount exceeding i128::MAX", () => {
  assert.throws(
    () =>
      buildIntent({
        user: account.address,
        destination: VALID_DESTINATION,
        sourceChainId: 8453,
        sourceAsset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        sourceAmount: "1000000",
        destAsset: "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
        minDestAmount: (I128_MAX + 1n).toString(),
        deadline: 4102444800,
      }),
    PerihelionValidationError
  );
});

test("buildIntent rejects sourceAmount exceeding u128::MAX", () => {
  assert.throws(
    () =>
      buildIntent(
        {
          user: account.address,
          destination: VALID_DESTINATION,
          sourceChainId: 8453,
          sourceAsset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
          sourceAmount: (U128_MAX + 1n).toString(),
          destAsset: "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
          minDestAmount: "1",
          deadline: 4102444800,
        },
        { suppressWarning: true }
      ),
    PerihelionValidationError
  );
});

test("buildIntent accepts sourceAmount = u128::MAX (exact boundary)", () => {
  assert.doesNotThrow(() =>
    buildIntent(
      {
        user: account.address,
        destination: VALID_DESTINATION,
        sourceChainId: 8453,
        sourceAsset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        sourceAmount: U128_MAX.toString(),
        destAsset: "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
        minDestAmount: "1",
        deadline: 4102444800,
      },
      { suppressWarning: true }
    )
  );
});

test("buildIntent accepts minDestAmount = i128::MAX (exact boundary)", () => {
  assert.doesNotThrow(() =>
    buildIntent(
      {
        user: account.address,
        destination: VALID_DESTINATION,
        sourceChainId: 8453,
        sourceAsset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        sourceAmount: I128_MAX.toString(),
        destAsset: "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
        minDestAmount: I128_MAX.toString(),
        deadline: 4102444800,
      },
      { suppressWarning: true }
    )
  );
});

// ---------------------------------------------------------------------------
// Issue #298 — Length bound enforcement
// ---------------------------------------------------------------------------

test("SDK constants match contract bounds", () => {
  // PerihelionEscrow.sol defines MAX_DESTINATION_LEN = 56 and MAX_DEST_ASSET_LEN = 69.
  // These values must match the SDK's exported constants to ensure consistent validation.
  assert.equal(MAX_DESTINATION_LEN, 56);
  assert.equal(MAX_DEST_ASSET_LEN, 69);
});

test("validateIntent enforces MAX_DESTINATION_LEN byte limit", () => {
  // Valid G... strkey is exactly 56 ASCII bytes and should pass.
  assert.doesNotThrow(() =>
    validateIntent({
      user: account.address,
      destination: VALID_DESTINATION, // 56 ASCII bytes
      sourceChainId: 8453,
      sourceAsset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      sourceAmount: "1000000",
      destAsset: "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
      minDestAmount: "900000",
      deadline: 4102444800,
    })
  );
});

test("validateIntent rejects destination exceeding MAX_DESTINATION_LEN", () => {
  // A non-ASCII character (e.g. emoji) takes 4 UTF-8 bytes, causing overflow.
  const oversizedDestination = VALID_DESTINATION + "💀"; // 56 + 4 = 60 bytes
  assert.throws(
    () =>
      validateIntent({
        user: account.address,
        destination: oversizedDestination,
        sourceChainId: 8453,
        sourceAsset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        sourceAmount: "1000000",
        destAsset: "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
        minDestAmount: "900000",
        deadline: 4102444800,
      }),
    PerihelionValidationError
  );
});

test("validateIntent enforces MAX_DEST_ASSET_LEN byte limit", () => {
  // Valid destAsset is at most 69 ASCII bytes and should pass.
  assert.doesNotThrow(() =>
    validateIntent({
      user: account.address,
      destination: VALID_DESTINATION,
      sourceChainId: 8453,
      sourceAsset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      sourceAmount: "1000000",
      destAsset: VALID_DEST_ASSET, // 69 ASCII bytes (12 + 1 + 56)
      minDestAmount: "900000",
      deadline: 4102444800,
    })
  );
});

test("validateIntent rejects destAsset exceeding MAX_DEST_ASSET_LEN", () => {
  // A non-ASCII character in the code causes overflow.
  const oversizedAsset = "X".repeat(12) + ":" + VALID_DESTINATION + "💀"; // 12 + 1 + 56 + 4 = 73 bytes
  assert.throws(
    () =>
      validateIntent({
        user: account.address,
        destination: VALID_DESTINATION,
        sourceChainId: 8453,
        sourceAsset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        sourceAmount: "1000000",
        destAsset: oversizedAsset,
        minDestAmount: "900000",
        deadline: 4102444800,
      }),
    PerihelionValidationError
  );
});
