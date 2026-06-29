import assert from "node:assert/strict";
import { test } from "node:test";
import { privateKeyToAccount } from "viem/accounts";
import { createWalletClient, http, zeroAddress } from "viem";
import { base } from "viem/chains";
import {
  buildIntent,
  DEFAULT_V_MIN,
  hashIntent,
  IntentValidationError,
  perihelionDomain,
  randomNonce,
  validateIntent,
  verifyIntent,
} from "../src/intent.js";
import { PerihelionClient } from "../src/client.js";
import { toSmallestUnits, fromSmallestUnits } from "../src/units.js";
import { isStellarAddress, isStellarAsset } from "../src/stellar.js";

const PK = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const account = privateKeyToAccount(PK);

// Sample escrow deployment on Base (chain 8453).
const CHAIN_ID = 8453;
const CONTRACT_ADDRESS = "0x1234567890123456789012345678901234567890" as const;
const DOMAIN = perihelionDomain(CHAIN_ID, CONTRACT_ADDRESS);

// A valid G... Stellar account strkey (56 chars, base32 A-Z/2-7).
const VALID_DESTINATION = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";

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

// --- Issue #63: randomNonce -------------------------------------------------

test("randomNonce uses library conversion and returns a value in [0, 2^256)", () => {
  const nonce = randomNonce();
  const value = BigInt(nonce);
  assert.ok(value >= 0n, "nonce must be non-negative");
  assert.ok(value < 2n ** 256n, "nonce must be below 2^256");
});

test("randomNonce round-trips through BigInt without loss", () => {
  for (let i = 0; i < 5; i++) {
    const nonce = randomNonce();
    assert.equal(BigInt(nonce).toString(), nonce, "BigInt round-trip must be stable");
  }
});

test("randomNonce produces distinct values across calls", () => {
  const nonces = new Set(Array.from({ length: 20 }, () => randomNonce()));
  assert.ok(nonces.size === 20, "all nonces must be distinct");
});

// --- Issue #62: validateIntent / buildIntent validation ---------------------

test("validateIntent accepts a well-formed intent", () => {
  assert.doesNotThrow(() => validateIntent(sampleParams()));
});

test("validateIntent rejects invalid user address", () => {
  assert.throws(
    () => validateIntent({ ...sampleParams(), user: "0xnot-an-address" as `0x${string}` }),
    (err: unknown) => err instanceof IntentValidationError && err.field === "user",
  );
});

test("validateIntent rejects destination that is too short", () => {
  assert.throws(
    () => validateIntent({ ...sampleParams(), destination: "GSHORT" }),
    (err: unknown) => err instanceof IntentValidationError && err.field === "destination",
  );
});

test("validateIntent rejects destination with invalid base32 chars", () => {
  // '1', '8', '9', '0' are not in Stellar's base32 alphabet (A-Z, 2-7).
  const bad = "G1OOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOO1";
  assert.throws(
    () => validateIntent({ ...sampleParams(), destination: bad }),
    (err: unknown) => err instanceof IntentValidationError && err.field === "destination",
  );
});

test("validateIntent rejects non-positive sourceChainId", () => {
  assert.throws(
    () => validateIntent({ ...sampleParams(), sourceChainId: 0 }),
    (err: unknown) => err instanceof IntentValidationError && err.field === "sourceChainId",
  );
  assert.throws(
    () => validateIntent({ ...sampleParams(), sourceChainId: -1 }),
    (err: unknown) => err instanceof IntentValidationError && err.field === "sourceChainId",
  );
});

test("validateIntent rejects invalid sourceAsset address", () => {
  assert.throws(
    () => validateIntent({ ...sampleParams(), sourceAsset: "not-an-address" as `0x${string}` }),
    (err: unknown) => err instanceof IntentValidationError && err.field === "sourceAsset",
  );
});

test("validateIntent rejects non-positive sourceAmount", () => {
  assert.throws(
    () => validateIntent({ ...sampleParams(), sourceAmount: "0" }),
    (err: unknown) => err instanceof IntentValidationError && err.field === "sourceAmount",
  );
  assert.throws(
    () => validateIntent({ ...sampleParams(), sourceAmount: "-1" }),
    (err: unknown) => err instanceof IntentValidationError && err.field === "sourceAmount",
  );
  assert.throws(
    () => validateIntent({ ...sampleParams(), sourceAmount: "01" }),
    (err: unknown) => err instanceof IntentValidationError && err.field === "sourceAmount",
  );
});

test("validateIntent rejects malformed destAsset", () => {
  assert.throws(
    () => validateIntent({ ...sampleParams(), destAsset: "USDC" }),
    (err: unknown) => err instanceof IntentValidationError && err.field === "destAsset",
  );
  assert.throws(
    () => validateIntent({ ...sampleParams(), destAsset: "USDC:not-a-strkey" }),
    (err: unknown) => err instanceof IntentValidationError && err.field === "destAsset",
  );
});

test("validateIntent accepts destAsset native", () => {
  assert.doesNotThrow(() => validateIntent({ ...sampleParams(), destAsset: "native" }));
});

test("validateIntent rejects negative minDestAmount with leading zeros", () => {
  assert.throws(
    () => validateIntent({ ...sampleParams(), minDestAmount: "00" }),
    (err: unknown) => err instanceof IntentValidationError && err.field === "minDestAmount",
  );
  assert.throws(
    () => validateIntent({ ...sampleParams(), minDestAmount: "-1" }),
    (err: unknown) => err instanceof IntentValidationError && err.field === "minDestAmount",
  );
});

test("validateIntent accepts minDestAmount of zero", () => {
  assert.doesNotThrow(() => validateIntent({ ...sampleParams(), minDestAmount: "0" }));
});

test("validateIntent rejects deadline in the past", () => {
  const pastDeadline = Math.floor(Date.now() / 1000) - 1;
  assert.throws(
    () => validateIntent({ ...sampleParams(), deadline: pastDeadline }),
    (err: unknown) => err instanceof IntentValidationError && err.field === "deadline",
  );
});

test("buildIntent throws IntentValidationError for malformed params", () => {
  assert.throws(
    () => buildIntent({ ...sampleParams(), destination: "TOOSHORT" }),
    IntentValidationError,
  );
});
