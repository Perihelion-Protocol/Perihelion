// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  custom,
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionResult,
  http,
  keccak256,
  numberToHex,
  toFunctionSelector,
  zeroAddress,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { ESCROW_ABI } from "../src/escrow-abi.js";
import { PerihelionEscrowClient, type Lock } from "../src/escrow-client.js";

const ESCROW = "0x00000000000000000000000000000000000e5c10" as Address;
const INTENT_HASH = ("0x" + "ab".repeat(32)) as Hex;
const LOCK = {
  solver: "0x1111111111111111111111111111111111111111" as Address,
  user: "0x2222222222222222222222222222222222222222" as Address,
  asset: "0x3333333333333333333333333333333333333333" as Address,
  amount: 1_000_000n,
  minDestAmount: (1n << 127n) + 7n,
  deadline: 4102444800n,
  released: false,
  refunded: true,
};

test("ESCROW_ABI exposes the contract's locks getter and EnforcedPause error", () => {
  const names: string[] = ESCROW_ABI.map((e) => ("name" in e ? e.name : e.type));
  assert.ok(names.includes("locks"));
  assert.ok(names.includes("EnforcedPause"));
  assert.ok(!names.includes("getLock"));
  assert.ok(!names.includes("PausedError"));
});

function clientWithEthCall(handler: (data: Hex) => Hex) {
  const transport = custom(
    {
      async request({ method, params }) {
        if (method === "eth_chainId") return numberToHex(foundry.id);
        if (method === "eth_call") return handler((params as [{ data: Hex }])[0].data);
        throw new Error(`unexpected RPC ${method}`);
      },
    },
    { retryCount: 0 },
  );
  const publicClient = createPublicClient({ chain: foundry, transport });
  const walletClient = createWalletClient({ chain: foundry, transport });
  return new PerihelionEscrowClient(publicClient, walletClient, ESCROW);
}

test("getLock calls locks(bytes32) and maps the 8-value result", async () => {
  let calledWith: readonly unknown[] | undefined;
  const client = clientWithEthCall((data) => {
    assert.equal(data.slice(0, 10), toFunctionSelector("locks(bytes32)"));
    calledWith = decodeFunctionData({ abi: ESCROW_ABI, data }).args;
    return encodeFunctionResult({
      abi: ESCROW_ABI,
      functionName: "locks",
      result: [
        LOCK.solver,
        LOCK.user,
        LOCK.asset,
        LOCK.amount,
        LOCK.minDestAmount,
        LOCK.deadline,
        LOCK.released,
        LOCK.refunded,
      ],
    });
  });

  assert.deepEqual(await client.getLock(INTENT_HASH), LOCK);
  assert.deepEqual(calledWith, [INTENT_HASH]);
});

test("getLock returns undefined for the zero-valued record of an unknown intent", async () => {
  const client = clientWithEthCall(() =>
    encodeFunctionResult({
      abi: ESCROW_ABI,
      functionName: "locks",
      result: [zeroAddress, zeroAddress, zeroAddress, 0n, 0n, 0n, false, false],
    }),
  );
  assert.equal(await client.getLock(INTENT_HASH), undefined);
});

// ---------------------------------------------------------------------------
// refundStatus / isRefundable: mirror cancelExpired's checks at one block.
// ---------------------------------------------------------------------------

const GRACE = 7200n;
const BLOCK_NUMBER = 1234n;

/** Escrow client over a mocked chain: one latest block, one lock, one grace. */
function refundClient(lock: Lock | undefined, blockTimestamp: bigint) {
  const pinned: string[] = [];
  const transport = custom(
    {
      async request({ method, params }) {
        if (method === "eth_chainId") return numberToHex(foundry.id);
        if (method === "eth_getBlockByNumber") {
          assert.equal((params as unknown[])[0], "latest");
          return {
            number: numberToHex(BLOCK_NUMBER),
            timestamp: numberToHex(blockTimestamp),
            hash: "0x" + "11".repeat(32),
            parentHash: "0x" + "22".repeat(32),
            transactions: [],
          };
        }
        if (method === "eth_call") {
          const [{ data }, block] = params as [{ data: Hex }, string];
          pinned.push(block);
          const { functionName } = decodeFunctionData({ abi: ESCROW_ABI, data });
          if (functionName === "confirmationGrace") {
            return encodeFunctionResult({ abi: ESCROW_ABI, functionName, result: GRACE });
          }
          const l = lock ?? { ...LOCK, user: zeroAddress, solver: zeroAddress, asset: zeroAddress };
          return encodeFunctionResult({
            abi: ESCROW_ABI,
            functionName: "locks",
            result: [
              l.solver,
              l.user,
              l.asset,
              l.amount,
              l.minDestAmount,
              l.deadline,
              l.released,
              l.refunded,
            ],
          });
        }
        throw new Error(`unexpected RPC ${method}`);
      },
    },
    { retryCount: 0 },
  );
  const publicClient = createPublicClient({ chain: foundry, transport });
  const walletClient = createWalletClient({ chain: foundry, transport });
  return { client: new PerihelionEscrowClient(publicClient, walletClient, ESCROW), pinned };
}

const OPEN_LOCK: Lock = { ...LOCK, released: false, refunded: false };
const REFUNDABLE_AT = OPEN_LOCK.deadline + GRACE;

test("refundStatus: no lock -> NotLocked", async () => {
  const { client } = refundClient(undefined, REFUNDABLE_AT + 1_000n);
  const status = await client.refundStatus(INTENT_HASH);
  assert.equal(status.refundable, false);
  assert.equal(status.reason, "NotLocked");
  assert.equal(status.lock, undefined);
});

test("refundStatus: released or refunded lock -> AlreadyFinalized, even after the deadline", async () => {
  for (const flags of [{ released: true }, { refunded: true }]) {
    const { client } = refundClient({ ...OPEN_LOCK, ...flags }, REFUNDABLE_AT + 1_000n);
    const status = await client.refundStatus(INTENT_HASH);
    assert.equal(status.refundable, false);
    assert.equal(status.reason, "AlreadyFinalized");
  }
});

test("refundStatus: one second before deadline + grace -> DeadlineNotPassed", async () => {
  const { client } = refundClient(OPEN_LOCK, REFUNDABLE_AT - 1n);
  const status = await client.refundStatus(INTENT_HASH);
  assert.equal(status.refundable, false);
  assert.equal(status.reason, "DeadlineNotPassed");
  assert.equal(status.refundableAt, REFUNDABLE_AT);
});

test("refundStatus: at exactly deadline + grace -> refundable (cancelExpired uses <)", async () => {
  const { client, pinned } = refundClient(OPEN_LOCK, REFUNDABLE_AT);
  const status = await client.refundStatus(INTENT_HASH);
  assert.deepEqual(status, {
    refundable: true,
    lock: OPEN_LOCK,
    refundableAt: REFUNDABLE_AT,
    blockNumber: BLOCK_NUMBER,
    blockTimestamp: REFUNDABLE_AT,
  });
  assert.equal(await client.isRefundable(INTENT_HASH), true);
  // Every contract read is pinned to the block whose timestamp was compared.
  assert.ok(pinned.length > 0);
  for (const block of pinned) assert.equal(block, numberToHex(BLOCK_NUMBER));
});

// ---------------------------------------------------------------------------
// Anvil: deploy the real contract and exercise the SDK against it.
// Skipped unless Foundry (forge + anvil) is on PATH.
// ---------------------------------------------------------------------------

const EVM_DIR = fileURLToPath(new URL("../../contracts/evm/", import.meta.url));
// Anvil's well-known first dev account.
const ANVIL_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const ANVIL_SKIP = { skip: !hasFoundry() && "forge/anvil not installed", timeout: 300_000 };

function hasFoundry(): boolean {
  try {
    execFileSync("forge", ["--version"], { stdio: "ignore" });
    execFileSync("anvil", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function forgeInspect(field: string): string {
  const out = execFileSync("forge", ["inspect", "PerihelionEscrow", field, "--json"], {
    cwd: EVM_DIR,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  // forge can print tracing log lines (e.g. about unrelated script sources)
  // to stdout ahead of the result; keep only the payload (JSON or 0x hex).
  const start = out.search(/^(?:[[{"]|0x)/m);
  assert.ok(start >= 0, `no result in forge inspect ${field} output:\n${out}`);
  return out.slice(start);
}

interface StorageLayout {
  storage: { label: string; slot: string; type: string }[];
  types: Record<string, { members?: { label: string; slot: string; offset: number }[] }>;
}

interface AnvilEscrow {
  publicClient: PublicClient;
  walletClient: WalletClient;
  escrow: Address;
  rpc(method: string, params: unknown[]): Promise<unknown>;
  /** Write locks[hash] directly, packing fields per the compiler's storage layout. */
  seedLock(hash: Hex, lock: Lock): Promise<void>;
  /** Write a top-level `mapping(address => uint256)` entry, e.g. totalLocked. */
  setAddressMapping(label: string, key: Address, value: bigint): Promise<void>;
}

/** Start Anvil, deploy PerihelionEscrow, run `fn`, and always stop Anvil. */
async function withAnvilEscrow(fn: (env: AnvilEscrow) => Promise<void>): Promise<void> {
  const raw = forgeInspect("bytecode").trim();
  const bytecode = (raw.startsWith('"') ? JSON.parse(raw) : raw) as Hex;
  const layout = JSON.parse(forgeInspect("storageLayout")) as StorageLayout;
  const slotOf = (label: string) => {
    const entry = layout.storage.find((s) => s.label === label);
    assert.ok(entry, `${label} missing from storage layout`);
    return entry;
  };
  const mappingSlot = (keyType: "bytes32" | "address", key: Hex, slot: string) =>
    BigInt(
      keccak256(encodeAbiParameters([{ type: keyType }, { type: "uint256" }], [key, BigInt(slot)])),
    );

  const port = 20000 + Math.floor(Math.random() * 20000);
  const anvil = spawn("anvil", ["--port", String(port), "--silent"], { stdio: "ignore" });
  try {
    const transport = http(`http://127.0.0.1:${port}`);
    const account = privateKeyToAccount(ANVIL_KEY);
    const publicClient = createPublicClient({ chain: foundry, transport });
    const walletClient = createWalletClient({ account, chain: foundry, transport });
    const rpc = (method: string, params: unknown[]) =>
      publicClient.request({ method: method as never, params: params as never });
    const setStorage = (address: Address, slot: bigint, value: bigint) =>
      rpc("anvil_setStorageAt", [
        address,
        numberToHex(slot, { size: 32 }),
        numberToHex(value, { size: 32 }),
      ]);

    for (let i = 0; ; i++) {
      try {
        await publicClient.getChainId();
        break;
      } catch (err) {
        if (i >= 100) throw err;
        await new Promise((r) => setTimeout(r, 100));
      }
    }

    // The constructor calls `endpoint.setDelegate`, so the endpoint needs code. A
    // bare STOP accepts any call with no return data, which is all this needs:
    // the paths under test never touch LayerZero.
    const endpoint = "0x000000000000000000000000000000000000dEaD";
    await rpc("anvil_setCode", [endpoint, "0x00"]);

    const deployHash = await walletClient.deployContract({
      abi: ESCROW_ABI,
      bytecode,
      args: [endpoint, 30148],
    });
    const { contractAddress: escrow } = await publicClient.waitForTransactionReceipt({
      hash: deployHash,
    });
    assert.ok(escrow);

    await fn({
      publicClient,
      walletClient,
      escrow,
      rpc,
      async seedLock(hash, lock) {
        const locks = slotOf("locks");
        const structType = locks.type.match(/^t_mapping\(t_bytes32,(.+)\)$/)?.[1];
        const members = structType && layout.types[structType]?.members;
        assert.ok(members, "Lock struct layout missing");
        const base = mappingSlot("bytes32", hash, locks.slot);
        const words = new Map<bigint, bigint>();
        for (const m of members) {
          const v = lock[m.label as keyof Lock];
          const n = typeof v === "boolean" || typeof v === "string" ? BigInt(v) : v;
          const slot = base + BigInt(m.slot);
          words.set(slot, (words.get(slot) ?? 0n) | (n << BigInt(m.offset * 8)));
        }
        for (const [slot, value] of words) await setStorage(escrow, slot, value);
      },
      async setAddressMapping(label, key, value) {
        await setStorage(escrow, mappingSlot("address", key, slotOf(label).slot), value);
      },
    });
  } finally {
    anvil.kill();
  }
}

test("getLock returns the stored lock from a deployed escrow (Anvil)", ANVIL_SKIP, async () => {
  await withAnvilEscrow(async ({ publicClient, walletClient, escrow, seedLock }) => {
    await seedLock(INTENT_HASH, LOCK);
    const client = new PerihelionEscrowClient(publicClient, walletClient, escrow);
    assert.deepEqual(await client.getLock(INTENT_HASH), LOCK);
    assert.equal(await client.getLock(("0x" + "cd".repeat(32)) as Hex), undefined);
  });
});

test(
  "refundStatus agrees with cancelExpired on a deployed escrow (Anvil)",
  ANVIL_SKIP,
  async () => {
    await withAnvilEscrow(async (env) => {
      const { publicClient, walletClient, escrow, rpc } = env;
      const client = new PerihelionEscrowClient(publicClient, walletClient, escrow);

      // Stand-in asset: any call returns ABI `true`, which is all _safeTransfer checks.
      const asset = "0x00000000000000000000000000000000000a55e7" as Address;
      await rpc("anvil_setCode", [asset, "0x600160005260206000f3"]);

      const mineAt = async (timestamp: bigint) => {
        await rpc("evm_setNextBlockTimestamp", [numberToHex(timestamp)]);
        await rpc("evm_mine", []);
      };

      // What cancelExpired does when executed in the context of `blockNumber`.
      const simulateCancel = async (hash: Hex, blockNumber: bigint): Promise<string> => {
        try {
          await publicClient.simulateContract({
            account: walletClient.account!,
            address: escrow,
            abi: ESCROW_ABI,
            functionName: "cancelExpired",
            args: [hash],
            blockNumber,
          });
          return "ok";
        } catch (err) {
          const reverted =
            err instanceof BaseError
              ? err.walk((e) => e instanceof ContractFunctionRevertedError)
              : undefined;
          if (reverted instanceof ContractFunctionRevertedError && reverted.data?.errorName) {
            return reverted.data.errorName;
          }
          throw err;
        }
      };

      // Send cancelExpired for real (fixed gas, so a revert is mined rather than
      // rejected at estimation) and report the receipt status.
      const sendCancel = async (hash: Hex) => {
        const tx = await walletClient.writeContract({
          account: walletClient.account!,
          chain: foundry,
          address: escrow,
          abi: ESCROW_ABI,
          functionName: "cancelExpired",
          args: [hash],
          gas: 500_000n,
        });
        return (await publicClient.waitForTransactionReceipt({ hash: tx })).status;
      };

      const assertAgrees = async (hash: Hex, expected: string) => {
        const status = await client.refundStatus(hash);
        const simulated = await simulateCancel(hash, status.blockNumber);
        assert.equal(simulated, expected);
        assert.equal(status.refundable, simulated === "ok");
        assert.equal(status.reason, simulated === "ok" ? undefined : simulated);
        assert.equal(await client.isRefundable(hash), status.refundable);
        return status;
      };

      const now = (await publicClient.getBlock()).timestamp;
      const grace = await client.confirmationGrace();
      const lock: Lock = { ...LOCK, asset, deadline: now + 600n, released: false, refunded: false };
      await env.setAddressMapping("totalLocked", asset, lock.amount * 2n);

      // 1. Unknown intent.
      await assertAgrees(("0x" + "cd".repeat(32)) as Hex, "NotLocked");
      assert.equal(await sendCancel(("0x" + "cd".repeat(32)) as Hex), "reverted");

      // 2. Live lock before deadline + grace, then a real call one second short.
      await env.seedLock(INTENT_HASH, lock);
      const early = await assertAgrees(INTENT_HASH, "DeadlineNotPassed");
      assert.equal(early.refundableAt, lock.deadline + grace);
      await mineAt(lock.deadline + grace - 2n);
      await assertAgrees(INTENT_HASH, "DeadlineNotPassed");
      await rpc("evm_setNextBlockTimestamp", [numberToHex(lock.deadline + grace - 1n)]);
      assert.equal(await sendCancel(INTENT_HASH), "reverted");

      // 3. At exactly deadline + grace the check flips, and the real call succeeds.
      await mineAt(lock.deadline + grace);
      await assertAgrees(INTENT_HASH, "ok");
      assert.equal(await sendCancel(INTENT_HASH), "success");

      // 4. Now refunded: finalized, and a second call reverts.
      const after = await assertAgrees(INTENT_HASH, "AlreadyFinalized");
      assert.equal(after.lock?.refunded, true);
      assert.equal(await sendCancel(INTENT_HASH), "reverted");

      // 5. A released lock long past its deadline is still not refundable.
      const releasedHash = ("0x" + "ef".repeat(32)) as Hex;
      await env.seedLock(releasedHash, { ...lock, released: true });
      await assertAgrees(releasedHash, "AlreadyFinalized");
      assert.equal(await sendCancel(releasedHash), "reverted");
    });
  },
);

// ---------------------------------------------------------------------------
// Issue #1123: findExpiredLocks & cancelExpiredLocks
// ---------------------------------------------------------------------------

const LOCKED_EVENT_FOR_TEST = {
  type: "event",
  name: "Locked",
  inputs: [
    { name: "intentHash", type: "bytes32", indexed: true },
    { name: "solver", type: "address", indexed: true },
    { name: "user", type: "address", indexed: true },
    { name: "asset", type: "address", indexed: false },
    { name: "amount", type: "uint256", indexed: false },
    { name: "destination", type: "string", indexed: false },
    { name: "destAsset", type: "string", indexed: false },
    { name: "minDestAmount", type: "uint128", indexed: false },
    { name: "deadline", type: "uint64", indexed: false },
  ],
} as const;

function makeRawLockedLog(opts: {
  intentHash: Hex;
  solver: Address;
  user: Address;
  asset: Address;
  amount: bigint;
  deadline: bigint;
  blockNumber: bigint;
  txHash: Hex;
}) {
  const topics = encodeEventTopics({
    abi: [LOCKED_EVENT_FOR_TEST],
    eventName: "Locked",
    args: {
      intentHash: opts.intentHash,
      solver: opts.solver,
      user: opts.user,
    },
  });
  const data = encodeAbiParameters(
    [
      { name: "asset", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "destination", type: "string" },
      { name: "destAsset", type: "string" },
      { name: "minDestAmount", type: "uint128" },
      { name: "deadline", type: "uint64" },
    ],
    [opts.asset, opts.amount, "G" + "A".repeat(55), "native", 900_000n, opts.deadline],
  );
  return {
    address: ESCROW,
    topics,
    data,
    blockNumber: numberToHex(opts.blockNumber),
    transactionHash: opts.txHash,
    transactionIndex: "0x0",
    blockHash: "0x" + "11".repeat(32),
    logIndex: "0x0",
    removed: false,
  };
}

test("findExpiredLocks: chunks block ranges, halves range on provider limit error, filters by user/solver, and excludes active or finalized locks", async () => {
  const hashExpiredUserA = ("0x" + "a1".repeat(32)) as Hex;
  const hashExpiredUserB = ("0x" + "b2".repeat(32)) as Hex;
  const hashNotYetExpired = ("0x" + "c3".repeat(32)) as Hex;
  const hashAlreadyRefunded = ("0x" + "d4".repeat(32)) as Hex;

  const userA = "0x2222222222222222222222222222222222222222" as Address;
  const userB = "0x4444444444444444444444444444444444444444" as Address;
  const solver1 = "0x1111111111111111111111111111111111111111" as Address;
  const asset = "0x3333333333333333333333333333333333333333" as Address;

  const evalBlock = 100n;
  const evalTimestamp = 20_000n;
  const grace = 7_200n;

  const lockMap = new Map<Hex, Lock>([
    [
      hashExpiredUserA,
      {
        solver: solver1,
        user: userA,
        asset,
        amount: 1_000_000n,
        minDestAmount: 950_000n,
        deadline: 10_000n, // 10_000 + 7_200 = 17_200 <= 20_000 (expired)
        released: false,
        refunded: false,
      },
    ],
    [
      hashExpiredUserB,
      {
        solver: solver1,
        user: userB,
        asset,
        amount: 2_000_000n,
        minDestAmount: 1_900_000n,
        deadline: 12_800n, // 12_800 + 7_200 = 20_000 <= 20_000 (exact boundary)
        released: false,
        refunded: false,
      },
    ],
    [
      hashNotYetExpired,
      {
        solver: solver1,
        user: userA,
        asset,
        amount: 1_000_000n,
        minDestAmount: 950_000n,
        deadline: 15_000n, // 15_000 + 7_200 = 22_200 > 20_000 (active)
        released: false,
        refunded: false,
      },
    ],
    [
      hashAlreadyRefunded,
      {
        solver: solver1,
        user: userA,
        asset,
        amount: 1_000_000n,
        minDestAmount: 950_000n,
        deadline: 9_000n,
        released: false,
        refunded: true, // already finalized
      },
    ],
  ]);

  const rawLogs = [
    makeRawLockedLog({
      intentHash: hashExpiredUserA,
      solver: solver1,
      user: userA,
      asset,
      amount: 1_000_000n,
      deadline: 10_000n,
      blockNumber: 15n,
      txHash: ("0x" + "10".repeat(32)) as Hex,
    }),
    // Duplicate log for hashExpiredUserA to verify deduplication
    makeRawLockedLog({
      intentHash: hashExpiredUserA,
      solver: solver1,
      user: userA,
      asset,
      amount: 1_000_000n,
      deadline: 10_000n,
      blockNumber: 15n,
      txHash: ("0x" + "10".repeat(32)) as Hex,
    }),
    makeRawLockedLog({
      intentHash: hashExpiredUserB,
      solver: solver1,
      user: userB,
      asset,
      amount: 2_000_000n,
      deadline: 12_800n,
      blockNumber: 45n,
      txHash: ("0x" + "20".repeat(32)) as Hex,
    }),
    makeRawLockedLog({
      intentHash: hashNotYetExpired,
      solver: solver1,
      user: userA,
      asset,
      amount: 1_000_000n,
      deadline: 15_000n,
      blockNumber: 65n,
      txHash: ("0x" + "30".repeat(32)) as Hex,
    }),
    makeRawLockedLog({
      intentHash: hashAlreadyRefunded,
      solver: solver1,
      user: userA,
      asset,
      amount: 1_000_000n,
      deadline: 9_000n,
      blockNumber: 85n,
      txHash: ("0x" + "40".repeat(32)) as Hex,
    }),
  ];

  const logRanges: Array<{ from: bigint; to: bigint }> = [];
  let rangeErrorInjected = false;

  const transport = custom(
    {
      async request({ method, params }) {
        if (method === "eth_chainId") return numberToHex(foundry.id);
        if (method === "eth_getBlockByNumber") {
          return {
            number: numberToHex(evalBlock),
            timestamp: numberToHex(evalTimestamp),
            hash: "0x" + "11".repeat(32),
            parentHash: "0x" + "22".repeat(32),
            transactions: [],
          };
        }
        if (method === "eth_getLogs") {
          const filter = (params as [{ fromBlock: Hex; toBlock: Hex }])[0];
          const from = BigInt(filter.fromBlock);
          const to = BigInt(filter.toBlock);
          if (to - from >= 50n) {
            rangeErrorInjected = true;
            throw new Error("query returned more than 10000 results: block range too large");
          }
          logRanges.push({ from, to });
          return rawLogs.filter((l) => {
            const bn = BigInt(l.blockNumber);
            return bn >= from && bn <= to;
          });
        }
        if (method === "eth_call") {
          const [{ data }] = params as [{ data: Hex }];
          const decoded = decodeFunctionData({ abi: ESCROW_ABI, data });
          if (decoded.functionName === "confirmationGrace") {
            return encodeFunctionResult({
              abi: ESCROW_ABI,
              functionName: "confirmationGrace",
              result: grace,
            });
          }
          if (decoded.functionName === "locks") {
            const hash = (decoded.args[0] as string).toLowerCase() as Hex;
            const l = lockMap.get(hash);
            if (!l) {
              return encodeFunctionResult({
                abi: ESCROW_ABI,
                functionName: "locks",
                result: [zeroAddress, zeroAddress, zeroAddress, 0n, 0n, 0n, false, false],
              });
            }
            return encodeFunctionResult({
              abi: ESCROW_ABI,
              functionName: "locks",
              result: [
                l.solver,
                l.user,
                l.asset,
                l.amount,
                l.minDestAmount,
                l.deadline,
                l.released,
                l.refunded,
              ],
            });
          }
        }
        throw new Error(`unexpected RPC ${method}`);
      },
    },
    { retryCount: 0 },
  );

  const publicClient = createPublicClient({ chain: foundry, transport });
  const walletClient = createWalletClient({ chain: foundry, transport });
  const client = new PerihelionEscrowClient(publicClient, walletClient, ESCROW);

  // Start with maxBlockRange: 60 -> first call [0, 59] throws range error -> halves to 30 -> chunks [0,29], [30,59], [60,89], [90,100].
  const allExpired = await client.findExpiredLocks({
    fromBlock: 0n,
    maxBlockRange: 60,
  });

  assert.equal(rangeErrorInjected, true);
  assert.equal(logRanges.length, 4);
  assert.equal(allExpired.length, 2);
  assert.equal(allExpired[0]?.intentHash, hashExpiredUserA);
  assert.equal(allExpired[0]?.refundableAt, 17_200n);
  assert.equal(allExpired[0]?.lockedAtBlock, 15n);
  assert.equal(allExpired[1]?.intentHash, hashExpiredUserB);
  assert.equal(allExpired[1]?.refundableAt, 20_000n);

  // Filter by userA only:
  const userAExpired = await client.findExpiredLocks({
    fromBlock: 0n,
    user: userA,
    maxBlockRange: 40,
  });
  assert.equal(userAExpired.length, 1);
  assert.equal(userAExpired[0]?.intentHash, hashExpiredUserA);

  // When fromBlock > toBlock, returns empty immediately:
  const emptyRange = await client.findExpiredLocks({
    fromBlock: 200n,
    toBlock: 100n,
  });
  assert.deepEqual(emptyRange, []);
});

test("cancelExpiredLocks: supports dryRun, enforces maxGasPriceWei and maxCancelCostWei guards, and submits cancelExpired transactions", async () => {
  const hash1 = ("0x" + "11".repeat(32)) as Hex;
  const hash2 = ("0x" + "22".repeat(32)) as Hex;
  const user = "0x2222222222222222222222222222222222222222" as Address;
  const solver = "0x1111111111111111111111111111111111111111" as Address;
  const asset = "0x3333333333333333333333333333333333333333" as Address;

  const evalBlock = 50n;
  const evalTimestamp = 30_000n;
  const grace = 7_200n;

  const currentGasPrice = 10_000_000_000n; // 10 gwei
  const currentEstimatedGas = 80_000n;
  const sentTxs: Hex[] = [];

  const rawLogs = [
    makeRawLockedLog({
      intentHash: hash1,
      solver,
      user,
      asset,
      amount: 1_000_000n,
      deadline: 10_000n,
      blockNumber: 10n,
      txHash: ("0x" + "aa".repeat(32)) as Hex,
    }),
    makeRawLockedLog({
      intentHash: hash2,
      solver,
      user,
      asset,
      amount: 2_000_000n,
      deadline: 12_000n,
      blockNumber: 20n,
      txHash: ("0x" + "bb".repeat(32)) as Hex,
    }),
  ];

  const account = privateKeyToAccount(ANVIL_KEY);
  const transport = custom(
    {
      async request({ method, params }) {
        if (method === "eth_chainId") return numberToHex(foundry.id);
        if (method === "eth_getBlockByNumber") {
          return {
            number: numberToHex(evalBlock),
            timestamp: numberToHex(evalTimestamp),
            hash: "0x" + "11".repeat(32),
            parentHash: "0x" + "22".repeat(32),
            transactions: [],
          };
        }
        if (method === "eth_getLogs") {
          return rawLogs;
        }
        if (method === "eth_gasPrice") {
          return numberToHex(currentGasPrice);
        }
        if (method === "eth_estimateGas") {
          return numberToHex(currentEstimatedGas);
        }
        if (method === "eth_getTransactionCount") {
          return numberToHex(sentTxs.length);
        }
        if (method === "eth_maxPriorityFeePerGas") {
          return numberToHex(1_000_000_000n);
        }
        if (method === "eth_sendRawTransaction") {
          const txHash = `0x${(sentTxs.length + 1).toString(16).padStart(64, "0")}` as Hex;
          sentTxs.push(txHash);
          return txHash;
        }
        if (method === "eth_call") {
          const [{ data }] = params as [{ data: Hex }];
          const decoded = decodeFunctionData({ abi: ESCROW_ABI, data });
          if (decoded.functionName === "confirmationGrace") {
            return encodeFunctionResult({
              abi: ESCROW_ABI,
              functionName: "confirmationGrace",
              result: grace,
            });
          }
          if (decoded.functionName === "locks") {
            const hash = (decoded.args[0] as string).toLowerCase() as Hex;
            return encodeFunctionResult({
              abi: ESCROW_ABI,
              functionName: "locks",
              result: [
                solver,
                user,
                asset,
                hash === hash1 ? 1_000_000n : 2_000_000n,
                900_000n,
                10_000n,
                false,
                false,
              ],
            });
          }
        }
        throw new Error(`unexpected RPC ${method}`);
      },
    },
    { retryCount: 0 },
  );

  const publicClient = createPublicClient({ chain: foundry, transport });
  const walletClient = createWalletClient({ account, chain: foundry, transport });
  const client = new PerihelionEscrowClient(publicClient, walletClient, ESCROW);

  // 1. Dry-run mode: finds both expired locks, sends zero transactions.
  const dryRes = await client.cancelExpiredLocks({ dryRun: true });
  assert.equal(dryRes.found.length, 2);
  assert.equal(dryRes.cancelled.length, 0);
  assert.deepEqual(dryRes.skipped, [
    { intentHash: hash1, reason: "dry_run" },
    { intentHash: hash2, reason: "dry_run" },
  ]);
  assert.equal(sentTxs.length, 0);

  // 2. Gas price exceeds cap -> skips both with gas_price_exceeds_cap.
  const highGasPriceRes = await client.cancelExpiredLocks({
    maxGasPriceWei: 5_000_000_000n, // 5 gwei cap < 10 gwei actual
  });
  assert.equal(highGasPriceRes.cancelled.length, 0);
  assert.deepEqual(highGasPriceRes.skipped, [
    { intentHash: hash1, reason: "gas_price_exceeds_cap" },
    { intentHash: hash2, reason: "gas_price_exceeds_cap" },
  ]);
  assert.equal(sentTxs.length, 0);

  // 3. Total cancel cost exceeds cap -> skips both with cancel_cost_exceeds_cap.
  // 10 gwei * 80,000 gas = 800,000,000,000,000 wei (0.0008 ETH)
  const highCostRes = await client.cancelExpiredLocks({
    maxGasPriceWei: 20_000_000_000n,
    maxCancelCostWei: 500_000_000_000_000n, // 0.0005 ETH cap < 0.0008 ETH actual
  });
  assert.equal(highCostRes.cancelled.length, 0);
  assert.deepEqual(highCostRes.skipped, [
    { intentHash: hash1, reason: "cancel_cost_exceeds_cap" },
    { intentHash: hash2, reason: "cancel_cost_exceeds_cap" },
  ]);
  assert.equal(sentTxs.length, 0);

  // 4. Within caps -> cancels both expired locks and records txHash + gasCostWei.
  const execRes = await client.cancelExpiredLocks({
    maxGasPriceWei: 20_000_000_000n,
    maxCancelCostWei: 1_000_000_000_000_000n,
  });
  assert.equal(execRes.found.length, 2);
  assert.equal(execRes.skipped.length, 0);
  assert.equal(execRes.cancelled.length, 2);
  assert.equal(execRes.cancelled[0]?.intentHash, hash1);
  assert.equal(execRes.cancelled[0]?.gasCostWei, 800_000_000_000_000n);
  assert.equal(execRes.cancelled[1]?.intentHash, hash2);
  assert.equal(sentTxs.length, 2);
});
