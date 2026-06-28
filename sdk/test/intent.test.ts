import assert from "node:assert/strict";
import { test } from "node:test";
import { privateKeyToAccount } from "viem/accounts";
import { createWalletClient, http, zeroAddress } from "viem";
import { base } from "viem/chains";
import { buildIntent, DEFAULT_V_MIN, hashIntent, perihelionDomain, verifyIntent, isExpired } from "../src/intent.js";
import { PerihelionClient } from "../src/client.js";
import { toSmallestUnits, fromSmallestUnits } from "../src/units.js";
import { isStellarAddress, isStellarAsset } from "../src/stellar.js";

const PK = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const account = privateKeyToAccount(PK);

// Sample escrow deployment on Base (chain 8453).
const CHAIN_ID = 8453;
const CONTRACT_ADDRESS = "0x1234567890123456789012345678901234567890" as const;
const DOMAIN = perihelionDomain(CHAIN_ID, CONTRACT_ADDRESS);

// A known-valid Stellar G... strkey (USDC issuer on Stellar mainnet).
const VALID_STELLAR_ADDRESS = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
const VALID_DEST_ASSET = `USDC:${VALID_STELLAR_ADDRESS}`;

function sampleIntent() {
  return buildIntent({
    user: account.address,
    destination: VALID_STELLAR_ADDRESS,
    sourceChainId: 8453,
    sourceAsset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    sourceAmount: "1000000",
    destAsset: VALID_DEST_ASSET,
    minDestAmount: "9900000",
    deadline: 4102444800, // year 2100
    nonce: "42",
  });
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
      destination: VALID_STELLAR_ADDRESS,
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
      destination: VALID_STELLAR_ADDRESS,
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
        destination: VALID_STELLAR_ADDRESS,
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
        destination: VALID_STELLAR_ADDRESS,
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

// ── #71: toSmallestUnits / fromSmallestUnits ─────────────────────────────────

test("toSmallestUnits converts 6-decimal EVM amount correctly", () => {
  assert.equal(toSmallestUnits("1", 6), "1000000");
  assert.equal(toSmallestUnits("100", 6), "100000000");
  assert.equal(toSmallestUnits("1.5", 6), "1500000");
  assert.equal(toSmallestUnits("0.000001", 6), "1");
});

test("toSmallestUnits converts 7-decimal Stellar amount correctly", () => {
  assert.equal(toSmallestUnits("1", 7), "10000000");
  assert.equal(toSmallestUnits("0.99", 7), "9900000");
  assert.equal(toSmallestUnits("0.0000001", 7), "1");
});

test("toSmallestUnits 6→7 corridor: 1 unit source = 10× dest", () => {
  const source = toSmallestUnits("1", 6);  // 1000000
  const dest = toSmallestUnits("1", 7);    // 10000000
  assert.equal(BigInt(dest), BigInt(source) * 10n);
});

test("toSmallestUnits throws on invalid input", () => {
  assert.throws(() => toSmallestUnits("-1", 6), /invalid amount/);
  assert.throws(() => toSmallestUnits("abc", 6), /invalid amount/);
  assert.throws(() => toSmallestUnits("1.1234567", 6), /more than 6 decimal places/);
});

test("fromSmallestUnits round-trips with toSmallestUnits", () => {
  assert.equal(fromSmallestUnits(toSmallestUnits("1.5", 6), 6), "1.5");
  assert.equal(fromSmallestUnits(toSmallestUnits("0.99", 7), 7), "0.99");
  assert.equal(fromSmallestUnits("1000000", 6), "1");
  assert.equal(fromSmallestUnits("0", 6), "0");
});

// ── #69: isExpired clock skew ────────────────────────────────────────────────

test("isExpired returns true when deadline is in the past", () => {
  const intent = sampleIntent();
  const expired = { ...intent, deadline: 1000 };
  assert.equal(isExpired(expired, 2000), true);
});

test("isExpired returns false when deadline is in the future", () => {
  const intent = sampleIntent();
  assert.equal(isExpired(intent, Math.floor(Date.now() / 1000)), false);
});

test("isExpired with positive clockSkew requires now to exceed deadline+skew", () => {
  // Formula: expired = deadline <= now - skew
  // skew=+30: expired when now >= deadline + 30
  // deadline=1000, now=1029: 1000 <= 1029-30=999? No → not expired.
  // deadline=1000, now=1030: 1000 <= 1030-30=1000? Yes → expired.
  const intent = { ...sampleIntent(), deadline: 1000 };
  assert.equal(isExpired(intent, 1029, 30), false, "not expired until now > deadline+skew");
  assert.equal(isExpired(intent, 1030, 30), true, "expired when now reaches deadline+skew");
});

test("isExpired with negative clockSkew expires when now reaches deadline-|skew|", () => {
  // skew=-30: expired when deadline <= now - (-30) = now + 30, i.e. when now >= deadline - 30
  // deadline=1000, now=969: 1000 <= 969+30=999? No → not expired.
  // deadline=1000, now=970: 1000 <= 970+30=1000? Yes → expired.
  const intent = { ...sampleIntent(), deadline: 1000 };
  assert.equal(isExpired(intent, 969, -30), false, "not yet expired within grace window");
  assert.equal(isExpired(intent, 970, -30), true, "expired once grace window exceeded");
});

// ── #68: waitForSettlement onStatus + lastStatus in error ────────────────────

test("waitForSettlement calls onStatus on each new status", async () => {
  const statuses: string[] = [];
  const responses = [
    { status: "pending" },
    { status: "claimed" },
    { status: "settling" },
    { status: "settled" },
  ];
  let call = 0;
  const mockFetch = async (url: string) => ({
    ok: true,
    json: async () => responses[call++ % responses.length],
  });

  const client = new PerihelionClient({
    mempoolUrl: "http://localhost",
    chainId: CHAIN_ID,
    verifyingContract: CONTRACT_ADDRESS,
    fetch: mockFetch as unknown as typeof fetch,
  });

  const result = await client.waitForSettlement("0xabc" as `0x${string}`, {
    intervalMs: 0,
    onStatus: (s) => statuses.push(s),
  });

  assert.equal(result.status, "settled");
  assert.deepEqual(statuses, ["pending", "claimed", "settling", "settled"]);
});

test("waitForSettlement includes lastStatus in timeout error", async () => {
  const mockFetch = async () => ({
    ok: true,
    json: async () => ({ status: "claimed" }),
  });

  const client = new PerihelionClient({
    mempoolUrl: "http://localhost",
    chainId: CHAIN_ID,
    verifyingContract: CONTRACT_ADDRESS,
    fetch: mockFetch as unknown as typeof fetch,
  });

  try {
    await client.waitForSettlement("0xabc" as `0x${string}`, {
      intervalMs: 0,
      timeoutMs: 1,
    });
    assert.fail("should have thrown");
  } catch (err: unknown) {
    const e = err as Error & { lastStatus?: string };
    assert.ok(e.message.includes("claimed"), "error message should include last status");
    assert.equal(e.lastStatus, "claimed");
  }
});

// ── #70: isStellarAddress / isStellarAsset ───────────────────────────────────

test("isStellarAddress accepts valid G... strkey", () => {
  assert.equal(isStellarAddress(VALID_STELLAR_ADDRESS), true);
});

test("isStellarAddress rejects invalid inputs", () => {
  assert.equal(isStellarAddress("GUSERSTELLARADDRESSPLACEHOLDER"), false);
  assert.equal(isStellarAddress("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"), false);
  assert.equal(isStellarAddress(""), false);
  assert.equal(isStellarAddress("not-a-strkey"), false);
  // Tampered checksum (last char changed)
  const tampered = VALID_STELLAR_ADDRESS.slice(0, -1) + (VALID_STELLAR_ADDRESS.endsWith("N") ? "A" : "N");
  assert.equal(isStellarAddress(tampered), false);
});

test("isStellarAsset accepts valid asset identifiers", () => {
  assert.equal(isStellarAsset("native"), true);
  assert.equal(isStellarAsset(VALID_DEST_ASSET), true);
  assert.equal(isStellarAsset(`XLM:${VALID_STELLAR_ADDRESS}`), true);
});

test("isStellarAsset rejects invalid asset identifiers", () => {
  assert.equal(isStellarAsset(""), false);
  assert.equal(isStellarAsset("USDC"), false);
  assert.equal(isStellarAsset("USDC:notastrkey"), false);
  assert.equal(isStellarAsset("TOOLONGCODE1234:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN"), false);
  assert.equal(isStellarAsset(":GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN"), false);
});

test("buildIntent throws on invalid destination", () => {
  assert.throws(
    () =>
      buildIntent({
        user: account.address,
        destination: "GUSERSTELLARADDRESSPLACEHOLDER",
        sourceChainId: 8453,
        sourceAsset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        sourceAmount: "1000000",
        destAsset: VALID_DEST_ASSET,
        minDestAmount: "9900000",
        deadline: 4102444800,
      }),
    /invalid destination/,
  );
});

test("buildIntent throws on invalid destAsset", () => {
  assert.throws(
    () =>
      buildIntent({
        user: account.address,
        destination: VALID_STELLAR_ADDRESS,
        sourceChainId: 8453,
        sourceAsset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        sourceAmount: "1000000",
        destAsset: "USDC:notanissuer",
        minDestAmount: "9900000",
        deadline: 4102444800,
      }),
    /invalid destAsset/,
  );
});
