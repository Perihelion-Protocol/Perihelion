// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { test } from "node:test";
import { createPublicClient, custom, encodeAbiParameters, type Hex } from "viem";
import { base } from "viem/chains";
import type { PublicClient } from "viem";
import {
  buildIntent,
  ERC6492_MAGIC_SUFFIX,
  isErc6492Signature,
  perihelionDomain,
  verifyIntent,
} from "../src/intent.js";

// A valid G... Stellar account strkey, reused from the intent tests.
const VALID_DESTINATION = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
const COUNTERFACTUAL = "0x00000000000000000000000000000000000000c1" as const;
const DOMAIN = perihelionDomain(8453, "0x1234567890123456789012345678901234567890");

const intent = buildIntent({
  user: COUNTERFACTUAL,
  destination: VALID_DESTINATION,
  sourceChainId: 8453,
  sourceAsset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  sourceAmount: "10000000",
  destAsset: `USDC:${VALID_DESTINATION}`,
  minDestAmount: "9900000",
  deadline: Math.floor(Date.now() / 1000) + 3600,
  nonce: "42",
});

// ERC-6492 wrapper: abi.encode(factory, factoryCalldata, innerSig) ‖ MAGIC.
const WRAPPED: Hex = `${encodeAbiParameters(
  [{ type: "address" }, { type: "bytes" }, { type: "bytes" }],
  ["0x00000000000000000000000000000000000000fa", "0xdeadbeef", `0x${"11".repeat(65)}`],
)}${ERC6492_MAGIC_SUFFIX.slice(2)}` as Hex;

/**
 * A public client whose `eth_call` answers with `ethCallResult`. The ERC-6492 path
 * validates an undeployed account with a deployless `eth_call` that returns a bool,
 * so this drives the validator's verdict without a live node.
 */
function fakeClient(ethCallResult: () => Hex): PublicClient {
  return createPublicClient({
    chain: base,
    transport: custom({
      async request({ method }: { method: string }) {
        if (method === "eth_chainId") return "0x2105";
        if (method === "eth_getCode") return "0x";
        if (method === "eth_call") return ethCallResult();
        throw new Error(`unexpected RPC ${method}`);
      },
    }),
  }) as unknown as PublicClient;
}

const TRUE_RESULT: Hex = `0x${"0".repeat(63)}1`;
const FALSE_RESULT: Hex = `0x${"0".repeat(64)}`;

test("isErc6492Signature detects the magic suffix only", () => {
  assert.equal(isErc6492Signature(WRAPPED), true);
  assert.equal(isErc6492Signature(WRAPPED.toUpperCase().replace("0X", "0x") as Hex), true);
  assert.equal(isErc6492Signature(`0x${"ab".repeat(65)}`), false);
  assert.equal(isErc6492Signature("0x"), false);
});

test("ERC-6492 signature without a client fails closed", async () => {
  assert.equal(await verifyIntent(intent, WRAPPED, DOMAIN), false);
});

test("ERC-6492 signature for an undeployed account is accepted when the validator agrees", async () => {
  const client = fakeClient(() => TRUE_RESULT);
  assert.equal(await verifyIntent(intent, WRAPPED, DOMAIN, { client }), true);
});

test("ERC-6492 signature is rejected when the validator says it is invalid", async () => {
  const client = fakeClient(() => FALSE_RESULT);
  assert.equal(await verifyIntent(intent, WRAPPED, DOMAIN, { client }), false);
});

test("ERC-6492 verification errors are treated as an invalid signature", async () => {
  const client = fakeClient(() => {
    throw new Error("RPC down");
  });
  assert.equal(await verifyIntent(intent, WRAPPED, DOMAIN, { client }), false);
});
