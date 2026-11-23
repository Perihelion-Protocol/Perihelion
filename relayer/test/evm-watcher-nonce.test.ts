// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { test } from "node:test";
import { encodeAbiParameters, encodeEventTopics, parseAbiParameters, type Hex } from "viem";
import { EVMSourceWatcher } from "../src/evm-watcher.js";

const ENDPOINT = "0x3333333333333333333333333333333333333333";
const ESCROW = "0x2222222222222222222222222222222222222222";

const PACKET_SENT_ABI = [
  {
    type: "event",
    name: "PacketSent",
    inputs: [
      { name: "encodedPayload", type: "bytes", indexed: false },
      { name: "options", type: "bytes", indexed: false },
      { name: "sendLibrary", type: "address", indexed: false },
    ],
  },
] as const;

/** version (1) | nonce (8) | srcEid (4) | sender (32) | dstEid (4) | receiver (32) | guid (32) | message */
function encodedPacket(nonce: bigint): Hex {
  const nonceHex = nonce.toString(16).padStart(16, "0");
  return `0x01${nonceHex}${"00".repeat(4 + 32 + 4 + 32 + 32 + 10)}` as Hex;
}

function packetSentLog(nonce: bigint) {
  return {
    address: ENDPOINT,
    topics: encodeEventTopics({ abi: PACKET_SENT_ABI, eventName: "PacketSent" }),
    data: encodeAbiParameters(parseAbiParameters("bytes, bytes, address"), [
      encodedPacket(nonce),
      "0x",
      ENDPOINT,
    ]),
  };
}

type FetchPacketSentNonce = (txHash: Hex) => Promise<bigint | null>;

function watcherWithReceipt(logs: unknown[]): FetchPacketSentNonce {
  const watcher = new EVMSourceWatcher({
    rpcUrl: "http://127.0.0.1:8545",
    escrowAddress: ESCROW,
    sourceEid: 1,
    stellarEid: 2,
    endpointAddress: ENDPOINT,
  });
  (watcher as unknown as { client: unknown }).client = {
    getTransactionReceipt: async () => ({ logs }),
  };
  return (
    watcher as unknown as { fetchPacketSentNonce: FetchPacketSentNonce }
  ).fetchPacketSentNonce.bind(watcher);
}

test("the nonce is read from the PacketSent event in the same transaction", async () => {
  const fetch = watcherWithReceipt([packetSentLog(42n)]);
  assert.equal(await fetch("0xabc" as Hex), 42n);
});

test("logs from other addresses or other event types are ignored", async () => {
  const other = { ...packetSentLog(9n), address: "0x4444444444444444444444444444444444444444" };
  const wrongTopic = { ...packetSentLog(9n), topics: [`0x${"ff".repeat(32)}`] };
  const fetch = watcherWithReceipt([other, wrongTopic]);
  assert.equal(await fetch("0xabc" as Hex), null);
});
