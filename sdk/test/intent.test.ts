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
  MAX_DEADLINE_HORIZON,
  MAX_DEADLINE_HORIZON_SEC,
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
import { PerihelionValidationError, IntentValidationError } from "../src/errors.js";

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

// A deadline comfortably inside MAX_DEADLINE_HORIZON (7 days) so horizon-checked
// validateIntent/buildIntent calls pass regardless of wall-clock time.
const FUTURE_DEADLINE = Math.floor(Date.now() / 1000) + 3600;

function sampleParams() {
  return {
    user: account.address,
    destination: VALID_DESTINATION,
    sourceChainId: 8453,
    sourceAsset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const,
    sourceAmount: "1000000",
    destAsset: VALID_DEST_ASSET,
    minDestAmount: "9900000",
    deadline: FUTURE_DEADLINE, // within MAX_DEADLINE_HORIZON
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

// ---------------------------------------------------------------------------
// Issue #529 — Strict 65-byte, low-s signature acceptance
// ---------------------------------------------------------------------------

test("verifyIntent rejects a 64-byte EIP-2098 compact re-encoding of an otherwise-valid signature", async () => {
  const intent = sampleIntent();
  const client = new PerihelionClient({
    mempoolUrl: "http://localhost",
    chainId: CHAIN_ID,
    verifyingContract: CONTRACT_ADDRESS,
  });
  const wallet = createWalletClient({ account, chain: base, transport: http() });
  const signed = await client.signIntent(wallet, intent);

  // Re-encode the valid 65-byte (r,s,v) signature as a 64-byte EIP-2098
  // compact signature (r ‖ yParityAndS). This recovers to the exact same
  // signer as the original — it's a pure re-encoding — which is precisely
  // why it must be rejected on length alone, matching
  // PerihelionEscrow._verify's `signature.length != 65` guard.
  const hex = signed.signature.slice(2);
  const r = hex.slice(0, 64);
  const s = BigInt(`0x${hex.slice(64, 128)}`);
  const v = parseInt(hex.slice(128, 130), 16);
  const yParity = v - 27;
  const yParityAndS = yParity === 1 ? s | (1n << 255n) : s;
  const compact = `0x${r}${yParityAndS.toString(16).padStart(64, "0")}` as `0x${string}`;
  assert.equal(compact.length, 130); // "0x" + 128 hex chars = 64 bytes

  assert.equal(await verifyIntent(intent, compact, DOMAIN), false);
});

test("verifyIntent rejects a 65-byte signature with a high-s (malleated) value", async () => {
  const intent = sampleIntent();
  const client = new PerihelionClient({
    mempoolUrl: "http://localhost",
    chainId: CHAIN_ID,
    verifyingContract: CONTRACT_ADDRESS,
  });
  const wallet = createWalletClient({ account, chain: base, transport: http() });
  const signed = await client.signIntent(wallet, intent);

  // Construct the mathematically-valid high-s malleated counterpart:
  // same r, s' = n - s, v flipped. Still recovers the correct signer via
  // ecrecover/secp256k1, but must be rejected under EIP-2 low-s enforcement.
  const SECP256K1_N =
    0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
  const hex = signed.signature.slice(2);
  const r = hex.slice(0, 64);
  const s = BigInt(`0x${hex.slice(64, 128)}`);
  const v = parseInt(hex.slice(128, 130), 16);
  const highS = SECP256K1_N - s;
  const flippedV = v === 27 ? 28 : 27;
  const malleated =
    `0x${r}${highS.toString(16).padStart(64, "0")}${flippedV.toString(16).padStart(2, "0")}` as `0x${string}`;
  assert.equal(malleated.length, 132); // "0x" + 130 hex chars = 65 bytes

  assert.equal(await verifyIntent(intent, malleated, DOMAIN), false);
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
      deadline: FUTURE_DEADLINE,
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
      deadline: FUTURE_DEADLINE,
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
      deadline: FUTURE_DEADLINE,
    });
    assert.equal(logged.length, 0, "expected no warning at the V_min boundary");
  } finally {
    console.warn = originalWarn;
  }
});

// ---------------------------------------------------------------------------
// Issue #527 — V_min threshold normalized by sourceDecimals
// ---------------------------------------------------------------------------

test("buildIntent warns for a 6-decimal (USDC) amount just below the default V_min", () => {
  const logged: string[] = [];
  const originalWarn = console.warn;
  console.warn = ((msg: string) => logged.push(msg)) as typeof console.warn;

  try {
    buildIntent(
      {
        user: account.address,
        destination: VALID_DESTINATION,
        sourceChainId: 8453,
        sourceAsset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        sourceAmount: "9999999", // $9.999999 at 6dp — just under the $10 default V_min
        destAsset: VALID_DEST_ASSET,
        minDestAmount: "9000000",
        deadline: 4102444800,
      },
      { sourceDecimals: 6 }
    );
    assert.ok(logged.length > 0, "expected warning just below V_min for a 6-decimal asset");
  } finally {
    console.warn = originalWarn;
  }
});

test("buildIntent warns for the economically-equivalent 18-decimal (WETH) amount", () => {
  const logged: string[] = [];
  const originalWarn = console.warn;
  console.warn = ((msg: string) => logged.push(msg)) as typeof console.warn;

  try {
    buildIntent(
      {
        user: account.address,
        destination: VALID_DESTINATION,
        sourceChainId: 8453,
        sourceAsset: "0x4200000000000000000000000000000000000006", // 18dp asset (e.g. WETH)
        // 9.999999 in 18-decimal units — economically identical to "9999999" at 6dp.
        // A raw-unit comparison against vMin would wrongly skip this: the raw
        // value (9.999999e18) is far larger than vMin's raw value (1e7).
        sourceAmount: "9999999000000000000",
        destAsset: VALID_DEST_ASSET,
        minDestAmount: "9000000",
        deadline: 4102444800,
      },
      { sourceDecimals: 18 }
    );
    assert.ok(
      logged.length > 0,
      "expected warning: sourceAmount must be normalized by sourceDecimals before comparing to V_min"
    );
  } finally {
    console.warn = originalWarn;
  }
});

test("buildIntent does not warn at the exact V_min boundary for an 18-decimal asset", () => {
  const logged: string[] = [];
  const originalWarn = console.warn;
  console.warn = ((msg: string) => logged.push(msg)) as typeof console.warn;

  try {
    buildIntent(
      {
        user: account.address,
        destination: VALID_DESTINATION,
        sourceChainId: 8453,
        sourceAsset: "0x4200000000000000000000000000000000000006",
        // Exactly $10 in 18-decimal units — boundary is exclusive, so no warning.
        sourceAmount: "10000000000000000000",
        destAsset: VALID_DEST_ASSET,
        minDestAmount: "9000000",
        deadline: 4102444800,
      },
      { sourceDecimals: 18 }
    );
    assert.equal(logged.length, 0, "expected no warning at the V_min boundary for an 18-decimal asset");
  } finally {
    console.warn = originalWarn;
  }
});

test("buildIntent does not warn for an 18-decimal amount comfortably above V_min", () => {
  const logged: string[] = [];
  const originalWarn = console.warn;
  console.warn = ((msg: string) => logged.push(msg)) as typeof console.warn;

  try {
    buildIntent(
      {
        user: account.address,
        destination: VALID_DESTINATION,
        sourceChainId: 8453,
        sourceAsset: "0x4200000000000000000000000000000000000006",
        sourceAmount: "1000000000000000000000", // 1000 token-units @ 18dp — normalizes to $1000
        destAsset: VALID_DEST_ASSET,
        minDestAmount: "900000",
        deadline: 4102444800,
      },
      { sourceDecimals: 18 }
    );
    // 1e21 raw @ 18dp normalizes to $1000, well above the $10 default V_min.
    assert.equal(logged.length, 0, "expected no warning for an 18-decimal amount well above V_min");
  } finally {
    console.warn = originalWarn;
  }
});

// ---------------------------------------------------------------------------
// Issue #526 — validateIntent performs checksum-aware destination/destAsset validation
// ---------------------------------------------------------------------------

test("validateIntent rejects a destination with an invalid CRC-16 checksum", () => {
  // Same strkey shape/length/version as VALID_DESTINATION but with the final
  // character flipped, which corrupts the checksum while leaving the shape valid.
  const lastChar = VALID_DESTINATION.at(-1);
  const badChecksumDestination =
    VALID_DESTINATION.slice(0, -1) + (lastChar === "A" ? "B" : "A");

  try {
    validateIntent({
      user: account.address,
      destination: badChecksumDestination,
      sourceChainId: 8453,
      sourceAsset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      sourceAmount: "1000000",
      destAsset: VALID_DEST_ASSET,
      minDestAmount: "900000",
      deadline: 4102444800,
    });
    assert.fail("expected validateIntent to throw for a bad destination checksum");
  } catch (err) {
    assert.ok(err instanceof PerihelionValidationError);
    assert.equal((err as PerihelionValidationError).field, "destination");
  }
});

test("validateIntent rejects a destAsset whose issuer has an invalid CRC-16 checksum", () => {
  const lastChar = VALID_DESTINATION.at(-1);
  const badChecksumIssuer =
    VALID_DESTINATION.slice(0, -1) + (lastChar === "A" ? "B" : "A");

  try {
    validateIntent({
      user: account.address,
      destination: VALID_DESTINATION,
      sourceChainId: 8453,
      sourceAsset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      sourceAmount: "1000000",
      destAsset: `USDC:${badChecksumIssuer}`,
      minDestAmount: "900000",
      deadline: 4102444800,
    });
    assert.fail("expected validateIntent to throw for a bad destAsset issuer checksum");
  } catch (err) {
    assert.ok(err instanceof PerihelionValidationError);
    assert.equal((err as PerihelionValidationError).field, "destAsset");
  }
});

test("buildIntent rejects a destination with an invalid checksum via validateIntent, not a separate check", () => {
  const lastChar = VALID_DESTINATION.at(-1);
  const badChecksumDestination =
    VALID_DESTINATION.slice(0, -1) + (lastChar === "A" ? "B" : "A");

  try {
    buildIntent({
      user: account.address,
      destination: badChecksumDestination,
      sourceChainId: 8453,
      sourceAsset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      sourceAmount: "1000000",
      destAsset: VALID_DEST_ASSET,
      minDestAmount: "900000",
      deadline: 4102444800,
    });
    assert.fail("expected buildIntent to throw for a bad destination checksum");
  } catch (err) {
    assert.ok(err instanceof PerihelionValidationError);
    assert.equal((err as PerihelionValidationError).field, "destination");
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
        deadline: FUTURE_DEADLINE,
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
        deadline: FUTURE_DEADLINE,
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
        deadline: FUTURE_DEADLINE,
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
        deadline: FUTURE_DEADLINE,
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
        deadline: FUTURE_DEADLINE,
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
          deadline: FUTURE_DEADLINE,
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
        deadline: FUTURE_DEADLINE,
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
        deadline: FUTURE_DEADLINE,
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
      deadline: FUTURE_DEADLINE,
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
        deadline: FUTURE_DEADLINE,
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
      deadline: FUTURE_DEADLINE,
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
        deadline: FUTURE_DEADLINE,
      }),
    PerihelionValidationError
  );
});

// ---------------------------------------------------------------------------
// Issue #524 — destAsset/destination validation consistency
//
// DEST_ASSET_RE (uppercase-only) was replaced with the checksum-aware
// isStellarAsset/isStellarAddress, which is also what parseIntent uses. These
// regression tests pin the acceptance criteria: one validator per field, used
// by both validateIntent and parseIntent, consistent on lowercase codes, and
// strict on corrupted issuer checksums.
// ---------------------------------------------------------------------------

test("#524 validateIntent accepts a lowercase alphanum4 asset code", () => {
  assert.doesNotThrow(() =>
    validateIntent({
      user: account.address,
      destination: VALID_DESTINATION,
      sourceChainId: 8453,
      sourceAsset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      sourceAmount: "1000000",
      destAsset: `usdc:${VALID_DESTINATION}`,
      minDestAmount: "900000",
      deadline: FUTURE_DEADLINE,
    })
  );
});

test("#524 validateIntent accepts a lowercase alphanum12 asset code", () => {
  assert.doesNotThrow(() =>
    validateIntent({
      user: account.address,
      destination: VALID_DESTINATION,
      sourceChainId: 8453,
      sourceAsset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      sourceAmount: "1000000",
      destAsset: `myrandomtok1:${VALID_DESTINATION}`,
      minDestAmount: "900000",
      deadline: FUTURE_DEADLINE,
    })
  );
});

test("#524 buildIntent accepts a lowercase asset code", () => {
  assert.doesNotThrow(() =>
    buildIntent(
      {
        user: account.address,
        destination: VALID_DESTINATION,
        sourceChainId: 8453,
        sourceAsset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        sourceAmount: "100000000",
        destAsset: `usdc:${VALID_DESTINATION}`,
        minDestAmount: "99000000",
        deadline: FUTURE_DEADLINE,
      },
      { suppressWarning: true }
    )
  );
});

test("#524 validateIntent rejects an issuer strkey with a corrupted checksum", () => {
  // GB5... is the same base32 shape as the valid issuer but has a corrupted
  // CRC-16 checksum; the old DEST_ASSET_RE accepted it because it only checked
  // the character class, while isStellarAsset must catch it.
  const corruptIssuer = "GB5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
  assert.throws(
    () =>
      validateIntent({
        user: account.address,
        destination: VALID_DESTINATION,
        sourceChainId: 8453,
        sourceAsset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        sourceAmount: "1000000",
        destAsset: `USDC:${corruptIssuer}`,
        minDestAmount: "900000",
        deadline: FUTURE_DEADLINE,
      }),
    PerihelionValidationError
  );
});

test("#524 validateIntent rejects a corrupted-checksum destination strkey", () => {
  const corruptDest = "GB5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
  assert.throws(
    () =>
      validateIntent({
        user: account.address,
        destination: corruptDest,
        sourceChainId: 8453,
        sourceAsset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        sourceAmount: "1000000",
        destAsset: VALID_DEST_ASSET,
        minDestAmount: "900000",
        deadline: FUTURE_DEADLINE,
      }),
    PerihelionValidationError
  );
});

test("#524 validateIntent rejects a destAsset with a lowercase issuer code char-class miss", () => {
  // Code length 13 is invalid regardless of case; both validators must agree.
  assert.throws(
    () =>
      validateIntent({
        user: account.address,
        destination: VALID_DESTINATION,
        sourceChainId: 8453,
        sourceAsset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        sourceAmount: "1000000",
        destAsset: `usdc:${VALID_DESTINATION}:extra`,
        minDestAmount: "900000",
        deadline: FUTURE_DEADLINE,
      }),
    PerihelionValidationError
  );
});

// ---------------------------------------------------------------------------
// Issue #522 — IntentValidationError is instanceof PerihelionError
// ---------------------------------------------------------------------------

test("#522 validateIntent throws IntentValidationError for invalid user", () => {
  const params = { ...sampleParams(), user: "not-an-address" as unknown as `0x${string}` };
  let caught: unknown;
  try {
    validateIntent(params);
  } catch (e) {
    caught = e;
  }
  assert.ok(caught instanceof IntentValidationError, "should be IntentValidationError");
  assert.ok(caught instanceof PerihelionValidationError, "should be PerihelionValidationError");
  assert.equal((caught as IntentValidationError).field, "user");
});

test("#522 validateIntent throws IntentValidationError for invalid destination", () => {
  const params = { ...sampleParams(), destination: "NOTASTELLARADDRESS" };
  let caught: unknown;
  try {
    validateIntent(params);
  } catch (e) {
    caught = e;
  }
  assert.ok(caught instanceof IntentValidationError);
  assert.equal((caught as IntentValidationError).field, "destination");
});

test("#522 validateIntent throws IntentValidationError for invalid deadline", () => {
  const params = { ...sampleParams(), deadline: Math.floor(Date.now() / 1000) - 1 };
  let caught: unknown;
  try {
    validateIntent(params);
  } catch (e) {
    caught = e;
  }
  assert.ok(caught instanceof IntentValidationError);
  assert.equal((caught as IntentValidationError).field, "deadline");
});

test("#522 all validateIntent errors are instanceof PerihelionError", () => {
  const invalidCases = [
    { ...sampleParams(), user: "bad" as unknown as `0x${string}` },
    { ...sampleParams(), destination: "BADADDRESS" },
    { ...sampleParams(), sourceChainId: -1 },
    { ...sampleParams(), sourceAmount: "0" },
    { ...sampleParams(), minDestAmount: "0" },
    { ...sampleParams(), deadline: Math.floor(Date.now() / 1000) - 1 },
  ];
  for (const params of invalidCases) {
    let caught: unknown;
    try {
      validateIntent(params);
    } catch (e) {
      caught = e;
    }
    assert.ok(
      caught instanceof IntentValidationError,
      `expected IntentValidationError for params: ${JSON.stringify(params)}`,
    );
  }
});

// ---------------------------------------------------------------------------
// Issue #523 — MAX_DEADLINE_HORIZON_SEC constant and upper-bound enforcement
// ---------------------------------------------------------------------------

test("#523 MAX_DEADLINE_HORIZON_SEC equals 604_800 (7 days in seconds)", () => {
  assert.equal(MAX_DEADLINE_HORIZON_SEC, 604_800);
});

test("#523 MAX_DEADLINE_HORIZON_SEC equals MAX_DEADLINE_HORIZON (alias check)", () => {
  assert.equal(MAX_DEADLINE_HORIZON_SEC, MAX_DEADLINE_HORIZON);
});

test("#523 validateIntent accepts deadline exactly at MAX_DEADLINE_HORIZON_SEC boundary", () => {
  const now = Math.floor(Date.now() / 1000);
  const params = { ...sampleParams(), deadline: now + MAX_DEADLINE_HORIZON_SEC };
  assert.doesNotThrow(() => validateIntent(params, now));
});

test("#523 validateIntent rejects deadline one second beyond MAX_DEADLINE_HORIZON_SEC", () => {
  const now = Math.floor(Date.now() / 1000);
  const params = { ...sampleParams(), deadline: now + MAX_DEADLINE_HORIZON_SEC + 1 };
  let caught: unknown;
  try {
    validateIntent(params, now);
  } catch (e) {
    caught = e;
  }
  assert.ok(caught instanceof IntentValidationError, "expected IntentValidationError");
  assert.equal((caught as IntentValidationError).field, "deadline");
  assert.ok(
    (caught as IntentValidationError).message.includes(`${MAX_DEADLINE_HORIZON_SEC}`),
    "error message should mention MAX_DEADLINE_HORIZON_SEC value",
  );
});

test("#523 validateIntent rejects deadline far in the future (10 days)", () => {
  const now = Math.floor(Date.now() / 1000);
  const tenDays = 10 * 24 * 60 * 60;
  assert.throws(
    () => validateIntent({ ...sampleParams(), deadline: now + tenDays }, now),
    IntentValidationError,
  );
});

test("#523 buildIntent rejects deadline beyond MAX_DEADLINE_HORIZON_SEC", () => {
  const now = Math.floor(Date.now() / 1000);
  assert.throws(
    () =>
      buildIntent(
        { ...sampleParams(), deadline: now + MAX_DEADLINE_HORIZON_SEC + 1 },
      ),
    IntentValidationError,
  );
});

test("#523 buildIntent accepts deadline at exact MAX_DEADLINE_HORIZON_SEC boundary", () => {
  const now = Math.floor(Date.now() / 1000);
  // Pass the same `now` via the validateIntent call; buildIntent uses wall clock
  // internally, so we can't inject it. Use a deadline slightly inside the window
  // but which will be inside MAX_DEADLINE_HORIZON_SEC at any reasonable wall-clock drift.
  const deadline = now + MAX_DEADLINE_HORIZON_SEC - 5; // 5s inside the window
  assert.doesNotThrow(() =>
    buildIntent(
      {
        user: account.address,
        destination: VALID_DESTINATION,
        sourceChainId: 8453,
        sourceAsset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        sourceAmount: "1000000",
        destAsset: VALID_DEST_ASSET,
        minDestAmount: "9900000",
        deadline,
      },
      { suppressWarning: true },
    ),
  );
});

// ---------------------------------------------------------------------------
// Issue #525 — strict CRC-16 checksum validation for destination strkeys
// ---------------------------------------------------------------------------

test("#525 validateIntent rejects destination with single-character transcription error", () => {
  // VALID_DESTINATION starts with GA5Z... We change one base32 char to produce
  // a string of the right length and char-class but with an invalid checksum.
  // Changing 'A' at position 1 to 'B' (GA → GB) corrupts the checksum.
  const corrupted = "G" + "B" + VALID_DESTINATION.slice(2);
  assert.equal(corrupted.length, 56, "corrupted key should still be 56 chars");
  assert.throws(
    () =>
      validateIntent({
        user: account.address,
        destination: corrupted,
        sourceChainId: 8453,
        sourceAsset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        sourceAmount: "1000000",
        destAsset: VALID_DEST_ASSET,
        minDestAmount: "900000",
        deadline: FUTURE_DEADLINE,
      }),
    IntentValidationError,
  );
});

test("#525 validateIntent rejects destination with last-character corruption", () => {
  // Change the final character, which is part of the CRC checksum encoding.
  const lastChar = VALID_DESTINATION[55]!;
  const altChar = lastChar === "A" ? "B" : "A";
  const corrupted = VALID_DESTINATION.slice(0, 55) + altChar;
  assert.throws(
    () =>
      validateIntent({
        user: account.address,
        destination: corrupted,
        sourceChainId: 8453,
        sourceAsset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        sourceAmount: "1000000",
        destAsset: VALID_DEST_ASSET,
        minDestAmount: "900000",
        deadline: FUTURE_DEADLINE,
      }),
    IntentValidationError,
  );
});

test("#525 validateIntent rejects destination with middle-character corruption", () => {
  // Change a character in the middle of the payload (not the CRC bytes) to corrupt
  // the checksum without changing the overall length or character class.
  const mid = 28;
  const ch = VALID_DESTINATION[mid]!;
  const altCh = ch === "A" ? "B" : "A";
  const corrupted = VALID_DESTINATION.slice(0, mid) + altCh + VALID_DESTINATION.slice(mid + 1);
  assert.throws(
    () =>
      validateIntent({
        user: account.address,
        destination: corrupted,
        sourceChainId: 8453,
        sourceAsset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        sourceAmount: "1000000",
        destAsset: VALID_DEST_ASSET,
        minDestAmount: "900000",
        deadline: FUTURE_DEADLINE,
      }),
    IntentValidationError,
  );
});

test("#525 validateIntent accepts unchanged VALID_DESTINATION (CRC correct)", () => {
  assert.doesNotThrow(() =>
    validateIntent({
      user: account.address,
      destination: VALID_DESTINATION,
      sourceChainId: 8453,
      sourceAsset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      sourceAmount: "1000000",
      destAsset: VALID_DEST_ASSET,
      minDestAmount: "900000",
      deadline: FUTURE_DEADLINE,
    }),
  );
});

test("#525 validateIntent rejects destination with C... prefix and corrupted checksum", () => {
  // Construct a C... destination with an invalid checksum by replacing G with C
  // and changing another character to corrupt the checksum for the 0x10 version byte.
  // Since we're not constructing a truly valid C address, any C... that isn't a valid
  // Soroban contract address (correct version byte 0x10) will fail.
  const fakeC = "C" + VALID_DESTINATION.slice(1); // valid length/charset but wrong checksum for C
  assert.throws(
    () =>
      validateIntent({
        user: account.address,
        destination: fakeC,
        sourceChainId: 8453,
        sourceAsset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        sourceAmount: "1000000",
        destAsset: VALID_DEST_ASSET,
        minDestAmount: "900000",
        deadline: FUTURE_DEADLINE,
      }),
    IntentValidationError,
  );
});

test("#525 validateIntent rejects destination with invalid char in base32", () => {
  // Insert a '1' which is not in the Stellar base32 alphabet (uses 2-7, not 1).
  const withOne = "G" + "1" + VALID_DESTINATION.slice(2);
  assert.throws(
    () =>
      validateIntent({
        user: account.address,
        destination: withOne,
        sourceChainId: 8453,
        sourceAsset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        sourceAmount: "1000000",
        destAsset: VALID_DEST_ASSET,
        minDestAmount: "900000",
        deadline: FUTURE_DEADLINE,
      }),
    IntentValidationError,
  );
});
