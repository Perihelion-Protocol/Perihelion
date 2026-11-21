// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { test } from "node:test";
import { nativeToScVal, scValToNative, scvU32, scvVoid } from "@stellar/stellar-sdk";
import { FatalError } from "../src/relayer.js";
import { SorobanDestinationDelivery, deliveryGuid } from "../src/soroban-delivery.js";
import type { BridgeMessage } from "../src/types.js";

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

test("Soroban delivery encodes the intent deadline in the FillInstruction", () => {
  const delivery = makeDelivery();
  const deadline = 1_700_000_123n;
  const message = {
    srcEid: 1,
    dstEid: 2,
    intentHash: INTENT_HASH,
    messageType: 0,
    solver: "0x0000000000000000000000000000000000000001",
    recipient: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    destAsset: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
    amount: "1000",
    nonce: 7,
    deadline,
  };

  const scVal = (delivery as unknown as {
    appendLzReceiveCall(args: {
      message: unknown;
      guid: string;
      payload: Uint8Array;
    }): { operations(): Array<{ body(): { invokeHostFunction(): { invokeContractOp(): { contractAddress(): unknown; functionName(): unknown; args(): unknown[] } } } }> };
  }).appendLzReceiveCall({
    message,
    guid: "0x" + "11".repeat(32),
    payload: new Uint8Array([1, 2, 3]),
  });

  const op = scVal.operations()[0]!.body().invokeHostFunction().invokeContractOp();
  const args = op.args();
  const decoded = scValToNative(args[args.length - 1] as Parameters<typeof scValToNative>[0]) as {
    deadline: bigint;
  };

  assert.equal(decoded.deadline, deadline);
  assert.notEqual(decoded.deadline, 0n);
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

function makeCancelMessage(reason: number): BridgeMessage {
  return {
    intentHash: INTENT_HASH,
    kind: "cancel",
    reason,
  } as unknown as BridgeMessage;
}

function cancelInstructionArgs(delivery: SorobanDestinationDelivery, message: BridgeMessage): xdr.ScVal[] {
  return (delivery as unknown as { buildCancelInstruction(message: BridgeMessage): xdr.ScVal[] })
    .buildCancelInstruction(message);
}

function mapEntryValue(entries: xdr.ScVal[], key: string): unknown {
  const map = entries[0];
  const scMap = map.map() ?? [];
  const entry = scMap.find((e) => e.key().sym().toString() === key);
  assert.ok(entry, `missing map entry ${key}`);
  return scValToNative(entry.val());
}

test("Soroban delivery encodes the CancelIntent reason for each code", () => {
  const delivery = makeDelivery();
  const cases: Array<[number, number]> = [
    [0, 0], // EXPIRED
    [1, 1], // ADMIN
    [2, 2], // INVALID
  ];

  for (const [reason, expected] of cases) {
    const args = cancelInstructionArgs(delivery, makeCancelMessage(reason));
    assert.equal(mapEntryValue(args, "reason"), expected, `reason ${reason} must be preserved`);
  }
});

test("Soroban delivery rejects a CancelIntent with an unknown reason", () => {
  const delivery = makeDelivery();
  assert.throws(() => cancelInstructionArgs(delivery, makeCancelMessage(3)), FatalError);
});

test("Soroban delivery fails when the peer lookup fails instead of guessing Origin.sender", async () => {
  const delivery = makeDelivery();
  const lookupError = new Error("peer lookup failed");
  (delivery as unknown as { getPeer(): Promise<unknown> }).getPeer = async () => {
    throw lookupError;
  };
  const append = (delivery as unknown as {
    appendLzReceiveCall(args: unknown[], message: BridgeMessage): Promise<void>;
  }).appendLzReceiveCall.bind(delivery);

  await assert.rejects(
    () => append([], { intentHash: INTENT_HASH, kind: "lzReceive" } as unknown as BridgeMessage),
    (error: unknown) => error instanceof Error,
  );
});

test("Soroban delivery encodes EVM addresses left-padded in Origin.sender", () => {
  const delivery = makeDelivery();
  const encoded = (delivery as unknown as { evmAddressToBytes32(address?: string): Buffer })
    .evmAddressToBytes32("0x0000000000000000000000000000000000000001");
  const expected = Buffer.alloc(32);
  expected[31] = 0x01;
  assert.deepEqual(encoded, expected);
});

const RAW_PAYLOAD = `0x${"07".repeat(90)}` as const;

test("deliveryGuid is a non-zero 32-byte value derived per message", () => {
  const guid = deliveryGuid({ srcEid: 40_000, nonce: 7, rawPayload: RAW_PAYLOAD });
  assert.equal(guid.length, 32);
  assert.ok(guid.some((byte) => byte !== 0), "GUID must not be all zeros");
});

test("deliveryGuid differs across nonces and payloads", () => {
  const base = deliveryGuid({ srcEid: 40_000, nonce: 7, rawPayload: RAW_PAYLOAD });
  const nextNonce = deliveryGuid({ srcEid: 40_000, nonce: 8, rawPayload: RAW_PAYLOAD });
  const otherPayload = deliveryGuid({ srcEid: 40_000, nonce: 7, rawPayload: `0x${"08".repeat(90)}` });
  assert.notDeepEqual(base, nextNonce);
  assert.notDeepEqual(base, otherPayload);
});

test("deliveryGuid uses the message's own GUID when one is recorded", () => {
  const own = `0x${"ab".repeat(32)}` as const;
  const guid = deliveryGuid({ srcEid: 1, nonce: 1, rawPayload: RAW_PAYLOAD, guid: own });
  assert.deepEqual(guid, Buffer.from("ab".repeat(32), "hex"));
});

test("deliveryGuid ignores an all-zero recorded GUID", () => {
  const zero = `0x${"00".repeat(32)}` as const;
  const guid = deliveryGuid({ srcEid: 1, nonce: 1, rawPayload: RAW_PAYLOAD, guid: zero });
  assert.ok(guid.some((byte) => byte !== 0));
});
