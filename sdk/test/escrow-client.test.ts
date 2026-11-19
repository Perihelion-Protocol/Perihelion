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
  const transport = custom({
    async request({ method, params }) {
      if (method === "eth_chainId") return numberToHex(foundry.id);
      if (method === "eth_call") return handler((params as [{ data: Hex }])[0].data);
      throw new Error(`unexpected RPC ${method}`);
    },
  });
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
  const transport = custom({
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
          result: [l.solver, l.user, l.asset, l.amount, l.minDestAmount, l.deadline, l.released, l.refunded],
        });
      }
      throw new Error(`unexpected RPC ${method}`);
    },
  });
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
    BigInt(keccak256(encodeAbiParameters([{ type: keyType }, { type: "uint256" }], [key, BigInt(slot)])));

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
      rpc("anvil_setStorageAt", [address, numberToHex(slot, { size: 32 }), numberToHex(value, { size: 32 })]);

    for (let i = 0; ; i++) {
      try {
        await publicClient.getChainId();
        break;
      } catch (err) {
        if (i >= 100) throw err;
        await new Promise((r) => setTimeout(r, 100));
      }
    }

    // Any non-zero endpoint: the paths under test never touch LayerZero. The
    // constructor calls setDelegate on it, so it needs code that accepts the call
    // (0x00 = STOP: succeeds with no return data).
    const endpoint = "0x000000000000000000000000000000000000dEaD" as Address;
    await rpc("anvil_setCode", [endpoint, "0x00"]);

    const deployHash = await walletClient.deployContract({
      abi: ESCROW_ABI,
      bytecode,
      args: [endpoint, 30148],
    });
    const { contractAddress: escrow } = await publicClient.waitForTransactionReceipt({ hash: deployHash });
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

test("refundStatus agrees with cancelExpired on a deployed escrow (Anvil)", ANVIL_SKIP, async () => {
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
        const reverted = err instanceof BaseError
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
});
