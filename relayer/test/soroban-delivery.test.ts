// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { test } from "node:test";
import { nativeToScVal, scValToNative, xdr } from "@stellar/stellar-sdk";
import { PerihelionSettlementClient } from "@perihelion/sdk";
import { FatalError } from "../src/relayer.js";
import {
  IntentStatus,
  SorobanDestinationDelivery,
  decodeIntentStatus,
} from "../src/soroban-delivery.js";
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
  const scVal = (delivery as unknown as { intentHashScVal(hash: string): unknown }).intentHashScVal(
    INTENT_HASH,
  );
  const native = scValToNative(scVal as Parameters<typeof scValToNative>[0]);

  assert.deepEqual(Buffer.from(native as Uint8Array), Buffer.from(INTENT_HASH.slice(2), "hex"));
});

test("Soroban delivery rejects invalid intent hash lengths", () => {
  const delivery = makeDelivery();
  assert.throws(
    () =>
      (delivery as unknown as { intentHashScVal(hash: string): unknown }).intentHashScVal("0x1234"),
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

  const scVal = (
    delivery as unknown as {
      appendLzReceiveCall(args: { message: unknown; guid: string; payload: Uint8Array }): {
        operations(): Array<{
          body(): {
            invokeHostFunction(): {
              invokeContractOp(): {
                contractAddress(): unknown;
                functionName(): unknown;
                args(): unknown[];
              };
            };
          };
        }>;
      };
    }
  ).appendLzReceiveCall({
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

  await assert.rejects(
    () => delivery.deliver({} as never),
    (error) => error === fatal,
  );
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

function cancelInstructionArgs(
  delivery: SorobanDestinationDelivery,
  message: BridgeMessage,
): xdr.ScVal[] {
  return (
    delivery as unknown as { buildCancelInstruction(message: BridgeMessage): xdr.ScVal[] }
  ).buildCancelInstruction(message);
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
  const append = (
    delivery as unknown as {
      appendLzReceiveCall(args: unknown[], message: BridgeMessage): Promise<void>;
    }
  ).appendLzReceiveCall.bind(delivery);

  await assert.rejects(
    () => append([], { intentHash: INTENT_HASH, kind: "lzReceive" } as unknown as BridgeMessage),
    (error: unknown) => error instanceof Error,
  );
});

test("Soroban delivery encodes EVM addresses left-padded in Origin.sender", () => {
  const delivery = makeDelivery();
  const encoded = (
    delivery as unknown as { evmAddressToBytes32(address?: string): Buffer }
  ).evmAddressToBytes32("0x0000000000000000000000000000000000000001");
  const expected = Buffer.alloc(32);
  expected[31] = 0x01;
  assert.deepEqual(encoded, expected);
});

test("Soroban delivery delegates isDelivered and getPeer to PerihelionSettlementClient without calling getAccount", async () => {
  const delivery = makeDelivery();
  let getAccountCalls = 0;
  const simulatedMethods: string[] = [];
  let currentRetval: xdr.ScVal = xdr.ScVal.scvVoid();

  const stubRpc = {
    getAccount: async () => {
      getAccountCalls += 1;
      throw new Error("getAccount must not be called for view reads");
    },
    simulateTransaction: async (tx: {
      operations: Array<{
        func: {
          invokeContract(): {
            functionName(): Buffer | string;
          };
        };
      }>;
    }) => {
      const fnName = tx.operations[0]!.func.invokeContract().functionName().toString();
      simulatedMethods.push(fnName);
      return {
        result: {
          retval: currentRetval,
          auth: [],
        },
      };
    },
  };

  (delivery as unknown as { rpc: unknown }).rpc = stubRpc;
  assert.ok(
    (delivery as unknown as { settlementClient: unknown }).settlementClient instanceof
      PerihelionSettlementClient,
    "SorobanDestinationDelivery must instantiate PerihelionSettlementClient",
  );

  // 1. Unregistered intent (scvVoid -> undefined)
  currentRetval = xdr.ScVal.scvVoid();
  assert.equal(
    await delivery.isDelivered({ intentHash: INTENT_HASH, messageType: "FillInstruction" }),
    false,
  );
  assert.equal(
    await delivery.isDelivered({ intentHash: INTENT_HASH, messageType: "FillConfirmed" }),
    false,
  );
  assert.equal(
    await delivery.isDelivered({ intentHash: INTENT_HASH, messageType: "CancelIntent" }),
    false,
  );

  // 2. Locked intent (scvU32(0) -> IntentStatus.Locked)
  currentRetval = xdr.ScVal.scvU32(IntentStatus.Locked);
  assert.equal(
    await delivery.isDelivered({ intentHash: INTENT_HASH, messageType: "FillInstruction" }),
    true,
  );
  assert.equal(
    await delivery.isDelivered({ intentHash: INTENT_HASH, messageType: "FillConfirmed" }),
    false,
  );

  // 3. Filled & ConfirmationSent intents
  currentRetval = xdr.ScVal.scvU32(IntentStatus.Filled);
  assert.equal(
    await delivery.isDelivered({ intentHash: INTENT_HASH, messageType: "FillConfirmed" }),
    true,
  );
  currentRetval = xdr.ScVal.scvU32(IntentStatus.ConfirmationSent);
  assert.equal(
    await delivery.isDelivered({ intentHash: INTENT_HASH, messageType: "FillConfirmed" }),
    true,
  );

  // 4. Cancelled intent
  currentRetval = xdr.ScVal.scvU32(IntentStatus.Cancelled);
  assert.equal(
    await delivery.isDelivered({ intentHash: INTENT_HASH, messageType: "CancelIntent" }),
    true,
  );

  // 5. getPeer delegates through PerihelionSettlementClient without calling getAccount
  const expectedPeer = Buffer.alloc(32, 0x42);
  currentRetval = xdr.ScVal.scvBytes(expectedPeer);
  const peer = await (
    delivery as unknown as { getPeer(srcEid: number): Promise<Buffer | null> }
  ).getPeer(30184);
  assert.deepEqual(peer, expectedPeer);

  assert.equal(getAccountCalls, 0, "rpc.getAccount must never be called on view queries");
  assert.ok(simulatedMethods.includes("status"));
  assert.ok(simulatedMethods.includes("get_peer"));
  assert.equal(decodeIntentStatus(xdr.ScVal.scvU32(1)), IntentStatus.Filled);
});
