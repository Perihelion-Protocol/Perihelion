import assert from "node:assert/strict";
import { test } from "node:test";
import { privateKeyToAccount } from "viem/accounts";
import { createWalletClient, http, zeroAddress } from "viem";
import { mainnet } from "viem/chains";
import { buildIntent, DEFAULT_V_MIN, hashIntent, verifyIntent } from "../src/intent.js";
import { PerihelionClient } from "../src/client.js";

const PK = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const account = privateKeyToAccount(PK);

function sampleIntent() {
  return buildIntent({
    user: account.address,
    destination: "GUSERSTELLARADDRESSPLACEHOLDER",
    sourceChainId: 8453,
    sourceAsset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    sourceAmount: "1000000",
    destAsset: "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
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
  assert.equal(hashIntent(sampleIntent()), hashIntent(sampleIntent()));
});

test("verifyIntent accepts a valid signature and rejects a tampered intent", async () => {
  const intent = sampleIntent();
  const client = new PerihelionClient({ mempoolUrl: "http://localhost" });
  const wallet = createWalletClient({ account, chain: mainnet, transport: http() });

  const signed = await client.signIntent(wallet, intent);
  assert.equal(await verifyIntent(intent, signed.signature), true);

  const tampered = { ...intent, sourceAmount: "2000000" };
  assert.equal(await verifyIntent(tampered, signed.signature), false);
});

test("buildIntent warns when sourceAmount is below V_min", () => {
  const logged: string[] = [];
  const warnStub = (msg: string) => logged.push(msg);
  const originalWarn = console.warn;
  console.warn = warnStub as unknown as typeof console.warn;

  try {
    buildIntent({
      user: account.address,
      destination: "GUSERSTELLARADDRESSPLACEHOLDER",
      sourceChainId: 8453,
      sourceAsset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      sourceAmount: "1000", // very small amount
      destAsset: "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
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
      destination: "GUSERSTELLARADDRESSPLACEHOLDER",
      sourceChainId: 8453,
      sourceAsset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      sourceAmount: "100000000", // well above default V_min
      destAsset: "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
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
        destination: "GUSERSTELLARADDRESSPLACEHOLDER",
        sourceChainId: 8453,
        sourceAsset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        sourceAmount: "1000",
        destAsset: "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
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
        destination: "GUSERSTELLARADDRESSPLACEHOLDER",
        sourceChainId: 8453,
        sourceAsset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        sourceAmount: "50000000", // 50 USD
        destAsset: "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
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
