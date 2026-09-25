// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { test } from "node:test";
import { scValToNative } from "@stellar/stellar-sdk";
import { FatalError } from "../src/relayer.js";
import { SorobanDestinationDelivery } from "../src/soroban-delivery.js";

const SIGNER_SECRET = "SATIFRDTRKIU6OIU3FURVUO2NIVO5KVH6GQIAGBFPMV4UE4WOXYK5PBW";
const CONTRACT_ID = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";
const INTENT_HASH = "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

function makeDelivery(): SorobanDestinationDelivery {
  return new SorobanDestinationDelivery({
    rpcUrl: "https://soroban.example",
    networkPassphrase: "Test SDF Network ; September 2015",
    settlementContractId: CONTRACT_ID,
    signerSecret: SIGNER_SECRET,
  });
}

test("Soroban delivery encodes intent hashes as 32 raw bytes", () => {
  const delivery = makeDelivery();
  const scVal = (delivery as unknown as { intentHashScVal(hash: string): unknown })
    .intentHashScVal(INTENT_HASH);
  const native = scValToNative(scVal as Parameters<typeof scValToNative>[0]);

  assert.deepEqual(Buffer.from(native as Uint8Array), Buffer.from(INTENT_HASH.slice(2), "hex"));
});

test("Soroban delivery rejects invalid intent hash lengths", () => {
  const delivery = makeDelivery();
  assert.throws(
    () => (delivery as unknown as { intentHashScVal(hash: string): unknown })
      .intentHashScVal("0x1234"),
    FatalError,
  );
});

test("Soroban delivery preserves FatalError", async () => {
  const delivery = makeDelivery();
  const fatal = new FatalError("permanent delivery failure");
  (delivery as unknown as { isEntryArchived(): Promise<boolean> }).isEntryArchived = async () => {
    throw fatal;
  };

  await assert.rejects(() => delivery.deliver({} as never), (error) => error === fatal);
});

test("Soroban delivery preserves the cause of ordinary errors", async () => {
  const delivery = makeDelivery();
  const original = new Error("temporary RPC failure");
  (delivery as unknown as { isEntryArchived(): Promise<boolean> }).isEntryArchived = async () => {
    throw original;
  };

  await assert.rejects(
    () => delivery.deliver({} as never),
    (error: unknown) => error instanceof Error && error.cause === original,
  );
});
