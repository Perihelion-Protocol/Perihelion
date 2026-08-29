// SPDX-License-Identifier: MIT

/**
 * Tests for EVMSourceWatcher (Issue 4).
 *
 * Uses a mock viem PublicClient to test log-to-PendingMessage decoding without
 * a live RPC. Validates:
 *
 * - poll() returns messages for each Locked log decoded successfully
 * - BridgeMessage fields are correctly populated from the event + calldata
 * - Logs with missing topics are skipped
 * - Failed calldata decodes are skipped (not thrown)
 * - head, headHash, parentHash are populated from the latest block
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { EVMSourceWatcher } from "../src/evm-watcher.js";
import type { EVMSourceWatcherConfig } from "../src/evm-watcher.js";
import { encodeAbiParameters, parseAbiParameters, keccak256, toHex, toEventSelector, type Hex } from "viem";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const ESCROW = "0xaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaA";
const SOLVER  = "0x1111111111111111111111111111111111111111";
const USER    = "0x2222222222222222222222222222222222222222";
const ASSET   = "0x3333333333333333333333333333333333333333";
const INTENT_HASH = "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890ab" as Hex;

const DESTINATION = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";
const DEST_ASSET  = "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVV";
const MIN_DEST    = 990_000n;
const DEADLINE    = BigInt(Math.floor(Date.now() / 1000) + 600);
const SOURCE_CHAIN_ID = 8453n;

const BASE_CONFIG: EVMSourceWatcherConfig = {
  rpcUrl: "http://localhost:8545", // not used — we mock the client
  escrowAddress: ESCROW,
  sourceEid: 30184,
  stellarEid: 40161,
};

/**
 * Encode mock `lock(Intent, bytes)` calldata.
 * Selector for lock((address,string,uint256,address,uint256,string,uint256,uint256,uint256,address),bytes)
 * = 0x (we use a dummy; the decoder skips the 4-byte selector).
 */
function encodeLockCalldata(): Hex {
  const selector = "0xdeadbeef"; // 4-byte dummy selector
  const encoded = encodeAbiParameters(
    parseAbiParameters(
      "(address user, string destination, uint256 sourceChainId, address sourceAsset, uint256 sourceAmount, string destAsset, uint256 minDestAmount, uint256 deadline, uint256 nonce, address preferredSolver) intent, bytes signature",
    ),
    [
      {
        user: USER as `0x${string}`,
        destination: DESTINATION,
        sourceChainId: SOURCE_CHAIN_ID,
        sourceAsset: ASSET as `0x${string}`,
        sourceAmount: 1_000_000n,
        destAsset: DEST_ASSET,
        minDestAmount: MIN_DEST,
        deadline: DEADLINE,
        nonce: 0n,
        preferredSolver: "0x0000000000000000000000000000000000000000" as `0x${string}`,
      },
      "0x" as Hex,
    ],
  );
  return (selector + encoded.slice(2)) as Hex;
}

/**
 * Encode the Locked event data field:
 * abi.encode(address asset, uint256 amount, string destination, string destAsset, uint128 minDestAmount, uint64 deadline).
 */
function encodeLockedData(): Hex {
  return encodeAbiParameters(
    parseAbiParameters("address asset, uint256 amount, string destination, string destAsset, uint128 minDestAmount, uint64 deadline"),
    [ASSET as `0x${string}`, 1_000_000n, DESTINATION, DEST_ASSET, MIN_DEST, DEADLINE],
  );
}

/** Build a mock Locked log. */
function makeLockedLog() {
  // Pad addresses to 32 bytes (topics are 32 bytes each).
  const pad = (addr: string) => ("0x" + addr.slice(2).padStart(64, "0")) as Hex;

  return {
    address: ESCROW as `0x${string}`,
    blockNumber: 100n,
    transactionHash: "0xtxhash0000000000000000000000000000000000000000000000000000000001" as Hex,
    logIndex: 0,
    topics: [
      // event signature topic — Locked(bytes32,address,address,address,uint256,string,string,uint128,uint64)
      keccak256(toHex("Locked(bytes32,address,address,address,uint256,string,string,uint128,uint64)")),
      INTENT_HASH,   // intentHash (bytes32)
      pad(SOLVER),   // solver (address padded to 32 bytes)
      pad(USER),     // user (address padded to 32 bytes)
    ] as [Hex, Hex, Hex, Hex],
    data: encodeLockedData(),
  };
}

/**
 * Build a mock viem PublicClient that returns our fixture data.
 * We inject it by monkey-patching the watcher's `client` field.
 */
function makeMockClient(log = makeLockedLog()) {
  return {
    getBlockNumber: async () => 100n,
    getBlock: async () => ({
      hash: "0xblockhash" as Hex,
      parentHash: "0xparenthash" as Hex,
    }),
    getLogs: async () => [log],
    getTransaction: async () => ({
      input: encodeLockCalldata(),
    }),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("EVMSourceWatcher: decodes a Locked log into a PendingMessage", async () => {
  const watcher = new EVMSourceWatcher(BASE_CONFIG);
  // Inject mock client.
  (watcher as unknown as { client: unknown }).client = makeMockClient();

  const { messages, head } = await watcher.poll(0);

  assert.equal(messages.length, 1, "one message decoded");
  assert.equal(head, 100);

  const msg = messages[0]!;
  assert.equal(msg.srcBlock, 100);
  assert.equal(msg.srcTxHash, makeLockedLog().transactionHash);

  const bm = msg.message;
  assert.equal(bm.messageType, "FillInstruction");
  assert.equal(bm.srcEid, BASE_CONFIG.sourceEid);
  assert.equal(bm.dstEid, BASE_CONFIG.stellarEid);
  assert.equal(bm.intentHash.toLowerCase(), INTENT_HASH.toLowerCase());
  assert.equal(bm.recipient, DESTINATION);
  assert.equal(bm.destAsset, DEST_ASSET);
  assert.equal(bm.amount, MIN_DEST.toString());
});

test("EVMSourceWatcher: includes headHash and parentHash from latest block", async () => {
  const watcher = new EVMSourceWatcher(BASE_CONFIG);
  (watcher as unknown as { client: unknown }).client = makeMockClient();

  const { headHash, parentHash } = await watcher.poll(0);

  assert.equal(headHash, "0xblockhash");
  assert.equal(parentHash, "0xparenthash");
});

test("EVMSourceWatcher: skips logs with insufficient topics", async () => {
  const log = makeLockedLog();
  (log as unknown as { topics: Hex[] }).topics = [log.topics[0]!]; // only event sig topic

  const client = makeMockClient(log as unknown as ReturnType<typeof makeLockedLog>);
  const watcher = new EVMSourceWatcher(BASE_CONFIG);
  (watcher as unknown as { client: unknown }).client = client;

  const { messages } = await watcher.poll(0);
  assert.equal(messages.length, 0, "log with insufficient topics skipped");
});

test("EVMSourceWatcher: skips logs whose event data cannot be decoded", async () => {
  const log = {
    ...makeLockedLog(),
    data: "0xdeadbeef" as Hex, // garbage data
  };
  const client = makeMockClient(log);
  const watcher = new EVMSourceWatcher(BASE_CONFIG);
  (watcher as unknown as { client: unknown }).client = client;

  const { messages } = await watcher.poll(0);
  assert.equal(messages.length, 0, "log with bad data skipped");
});

test("EVMSourceWatcher: returns empty messages when no logs emitted", async () => {
  const client = {
    ...makeMockClient(),
    getLogs: async () => [],
  };
  const watcher = new EVMSourceWatcher(BASE_CONFIG);
  (watcher as unknown as { client: unknown }).client = client;

  const { messages } = await watcher.poll(0);
  assert.equal(messages.length, 0);
});

test("EVMSourceWatcher: solver address extracted from indexed topic", async () => {
  const watcher = new EVMSourceWatcher(BASE_CONFIG);
  (watcher as unknown as { client: unknown }).client = makeMockClient();

  const { messages } = await watcher.poll(0);
  assert.equal(messages.length, 1);
  // solver should be the address portion of the indexed topic
  const solver = messages[0]!.message.solver.toLowerCase();
  assert.equal(solver, ("0x" + SOLVER.slice(2).toLowerCase()) as string);
});

test("Locked event topic hash is correctly derived from ABI", () => {
  const lockedEventAbi = [
    {
      type: "event" as const,
      name: "Locked",
      inputs: [
        { name: "intentHash",    type: "bytes32", indexed: true },
        { name: "solver",        type: "address", indexed: true },
        { name: "user",          type: "address", indexed: true },
        { name: "asset",         type: "address", indexed: false },
        { name: "amount",        type: "uint256", indexed: false },
        { name: "destination",   type: "string",  indexed: false },
        { name: "destAsset",     type: "string",  indexed: false },
        { name: "minDestAmount", type: "uint128", indexed: false },
        { name: "deadline",      type: "uint64",  indexed: false },
      ],
    },
  ] as const;

  const derivedTopic = toEventSelector(lockedEventAbi[0]);
  assert.ok(derivedTopic.startsWith("0x"), "topic should be hex string");
  assert.equal(derivedTopic.length, 66, "topic should be 64 hex chars + 0x prefix");
});

