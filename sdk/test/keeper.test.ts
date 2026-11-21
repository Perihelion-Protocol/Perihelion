// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  Account,
  Address as StellarSdkAddress,
  Keypair,
  SorobanDataBuilder,
  StrKey,
  nativeToScVal,
  xdr,
  type SorobanRpc,
  type Transaction,
} from "@stellar/stellar-sdk";
import {
  CROSS_CHAIN_LATENCY_BUDGET_SECS,
  DISPATCH_REWARD_GRACE_LEDGERS,
  MAX_LIST_BATCH,
  MIN_DISPATCH_WINDOW_SECS,
  OnChainIntentStatus,
  PerihelionSettlementClient,
  decodeSorobanIntentRecord,
  dispatchCutoff,
  evaluateEvmCancelCostGuard,
  evaluateSorobanKeeperProfitability,
  type Hex,
} from "../src/index.js";

const PASSPHRASE = "Test SDF Network ; September 2015";
const SETTLEMENT_CONTRACT_ID = StrKey.encodeContract(Buffer.alloc(32, 0x11));
const NATIVE_TOKEN_CONTRACT_ID = StrKey.encodeContract(Buffer.alloc(32, 0x22));
const SIGNER = Keypair.random();
const SOLVER_KP = Keypair.random();
const RECIPIENT_KP = Keypair.random();
const DEST_ASSET_ID = StrKey.encodeContract(Buffer.alloc(32, 0x33));

const HASH_1 = ("0x" + "11".repeat(32)) as Hex;
const HASH_2 = ("0x" + "22".repeat(32)) as Hex;
const HASH_3 = ("0x" + "33".repeat(32)) as Hex;
const HASH_4 = ("0x" + "44".repeat(32)) as Hex;

// ---------------------------------------------------------------------------
// Protocol Constants & Pure Helpers
// ---------------------------------------------------------------------------

test("keeper protocol constants match settlement contract definitions", () => {
  assert.equal(MAX_LIST_BATCH, 100);
  assert.equal(MIN_DISPATCH_WINDOW_SECS, 1_800);
  assert.equal(CROSS_CHAIN_LATENCY_BUDGET_SECS, 1_200);
  assert.equal(DISPATCH_REWARD_GRACE_LEDGERS, 360);
  assert.equal(dispatchCutoff(10_000), 10_600n);
  assert.equal(dispatchCutoff(10_000n), 10_600n);
});

test("evaluateSorobanKeeperProfitability: handles profitable, unprofitable, insufficient reserve, and awaiting grace period cases", () => {
  // 1. Profitable with positive net profit
  const profitable = evaluateSorobanKeeperProfitability({
    rewardStroops: 500_000n,
    lzFeeStroops: 300_000n,
    inclusionFeeStroops: 50_000n,
    minNetProfitStroops: 100_000n,
    contractReserveStroops: 1_000_000n,
    rewardEligible: true,
  });
  assert.deepEqual(profitable, {
    profitable: true,
    netProfitStroops: 150_000n,
    totalCostStroops: 350_000n,
    effectiveRewardStroops: 500_000n,
  });

  // 2. Unprofitable when net profit is below minNetProfitStroops
  const unprofitable = evaluateSorobanKeeperProfitability({
    rewardStroops: 300_000n,
    lzFeeStroops: 280_000n,
    inclusionFeeStroops: 50_000n,
    minNetProfitStroops: 0n,
    rewardEligible: true,
  });
  assert.equal(unprofitable.profitable, false);
  assert.equal(unprofitable.reason, "unprofitable");
  assert.equal(unprofitable.netProfitStroops, -30_000n);

  // 3. Insufficient contract reserve when reserve < rewardStroops
  const lowReserve = evaluateSorobanKeeperProfitability({
    rewardStroops: 500_000n,
    lzFeeStroops: 100_000n,
    inclusionFeeStroops: 10_000n,
    contractReserveStroops: 499_999n,
  });
  assert.equal(lowReserve.profitable, false);
  assert.equal(lowReserve.reason, "insufficient_reserve");
  assert.equal(lowReserve.effectiveRewardStroops, 0n);

  // 4. Awaiting DISPATCH_REWARD_GRACE_LEDGERS when reward would cover costs once eligible
  const awaitingGrace = evaluateSorobanKeeperProfitability({
    rewardStroops: 500_000n,
    lzFeeStroops: 200_000n,
    inclusionFeeStroops: 50_000n,
    minNetProfitStroops: 10_000n,
    rewardEligible: false,
  });
  assert.equal(awaitingGrace.profitable, false);
  assert.equal(awaitingGrace.reason, "awaiting_dispatch_reward_grace");
  assert.equal(awaitingGrace.effectiveRewardStroops, 0n);

  // 5. Not eligible AND reward wouldn't cover costs anyway -> unprofitable
  const neverProfitable = evaluateSorobanKeeperProfitability({
    rewardStroops: 100_000n,
    lzFeeStroops: 200_000n,
    inclusionFeeStroops: 50_000n,
    rewardEligible: false,
  });
  assert.equal(neverProfitable.profitable, false);
  assert.equal(neverProfitable.reason, "unprofitable");

  // 6. Not eligible for reward, but minNetProfitStroops allows negative profit (altruistic / solver self-recovery)
  const altruistic = evaluateSorobanKeeperProfitability({
    rewardStroops: 0n,
    lzFeeStroops: 200_000n,
    inclusionFeeStroops: 50_000n,
    minNetProfitStroops: -300_000n,
    rewardEligible: false,
  });
  assert.equal(altruistic.profitable, true);
  assert.equal(altruistic.netProfitStroops, -250_000n);
});

test("evaluateEvmCancelCostGuard: enforces gas price cap, total cost cap, and min net profit", () => {
  // 1. Allowed within caps
  const allowed = evaluateEvmCancelCostGuard({
    gasPriceWei: 10_000_000_000n, // 10 gwei
    estimatedGas: 80_000n,
    maxGasPriceWei: 20_000_000_000n,
    maxCancelCostWei: 1_000_000_000_000_000n,
  });
  assert.equal(allowed.allowed, true);
  assert.equal(allowed.totalCostWei, 800_000_000_000_000n);

  // 2. Gas price exceeds cap
  const gasPriceDenied = evaluateEvmCancelCostGuard({
    gasPriceWei: 25_000_000_000n,
    estimatedGas: 80_000n,
    maxGasPriceWei: 20_000_000_000n,
  });
  assert.equal(gasPriceDenied.allowed, false);
  assert.equal(gasPriceDenied.reason, "gas_price_exceeds_cap");

  // 3. Total cost exceeds cap
  const costDenied = evaluateEvmCancelCostGuard({
    gasPriceWei: 15_000_000_000n,
    estimatedGas: 100_000n,
    maxGasPriceWei: 20_000_000_000n,
    maxCancelCostWei: 1_000_000_000_000_000n,
  });
  assert.equal(costDenied.allowed, false);
  assert.equal(costDenied.reason, "cancel_cost_exceeds_cap");

  // 4. Net profit below minNetProfitWei
  const profitDenied = evaluateEvmCancelCostGuard({
    gasPriceWei: 10_000_000_000n,
    estimatedGas: 100_000n,
    rewardWei: 500_000_000_000_000n,
    minNetProfitWei: 0n,
  });
  assert.equal(profitDenied.allowed, false);
  assert.equal(profitDenied.reason, "unprofitable");
});

test("decodeSorobanIntentRecord: decodes snake_case and camelCase IntentRecord objects", () => {
  const rec = decodeSorobanIntentRecord({
    intent_hash: Buffer.from(HASH_1.slice(2), "hex"),
    src_eid: 30101,
    recipient: RECIPIENT_KP.publicKey(),
    dest_asset: DEST_ASSET_ID,
    min_dest_amount: 9_900_000n,
    deadline: 1_700_005_000n,
    preferred_solver: SOLVER_KP.publicKey(),
    reservation_expires: 1_700_001_000n,
    status: 1, // Filled
    solver: SOLVER_KP.publicKey(),
    solver_evm: "0x0000000000000000000000001111111111111111111111111111111111111111",
    fill_amount: 10_000_000n,
    fill_ledger: 500,
    registered_ledger: 480,
  });

  assert.ok(rec);
  assert.equal(rec.intentHash, HASH_1);
  assert.equal(rec.srcEid, 30101);
  assert.equal(rec.recipient, RECIPIENT_KP.publicKey());
  assert.equal(rec.destAsset, DEST_ASSET_ID);
  assert.equal(rec.minDestAmount, 9_900_000n);
  assert.equal(rec.deadline, 1_700_005_000n);
  assert.equal(rec.preferredSolver, SOLVER_KP.publicKey());
  assert.equal(rec.status, OnChainIntentStatus.Filled);
  assert.equal(rec.solver, SOLVER_KP.publicKey());
  assert.equal(rec.fillAmount, 10_000_000n);
  assert.equal(rec.fillLedger, 500);
  assert.equal(rec.registeredLedger, 480);

  assert.equal(decodeSorobanIntentRecord(null), undefined);
  assert.equal(decodeSorobanIntentRecord({}), undefined);
});

// ---------------------------------------------------------------------------
// PerihelionSettlementClient Mock RPC Harness
// ---------------------------------------------------------------------------

function extractContractInvocation(tx: Transaction): {
  contractId: string;
  method: string;
  args: xdr.ScVal[];
} {
  const op = tx.operations[0] as unknown as {
    func: xdr.HostFunction;
  };
  const invoke = op.func.invokeContract();
  const contractId = StellarSdkAddress.fromScAddress(invoke.contractAddress()).toString();
  const method = invoke.functionName().toString();
  const args = invoke.args();
  return { contractId, method, args };
}

function buildIntentRecordScVal(opts: {
  intentHash: Hex;
  srcEid: number;
  deadline: bigint;
  status: OnChainIntentStatus;
  solver?: string;
  fillLedger?: number;
}): xdr.ScVal {
  return nativeToScVal({
    intent_hash: Buffer.from(opts.intentHash.slice(2), "hex"),
    src_eid: opts.srcEid,
    recipient: RECIPIENT_KP.publicKey(),
    dest_asset: DEST_ASSET_ID,
    min_dest_amount: 9_900_000n,
    deadline: opts.deadline,
    reservation_expires: 0n,
    status: opts.status,
    ...(opts.solver ? { solver: opts.solver } : {}),
    fill_amount: opts.status === OnChainIntentStatus.Locked ? 0n : 10_000_000n,
    fill_ledger: opts.fillLedger ?? 100,
    registered_ledger: 90,
  });
}

test("PerihelionSettlementClient: views (status, getIntent, keeperReward, dispatchKeeperReward, quoteCancelFee, quoteFillConfirmedFee, getContractReserveStroops)", async () => {
  const rpcCalls: string[] = [];

  const mockRpc = {
    async getAccount(address: string) {
      return new Account(address, "100");
    },
    async getFeeStats() {
      return {
        sorobanInclusionFee: { p50: "100", p90: "12000", max: "50000" },
      };
    },
    async simulateTransaction(tx: Transaction) {
      const { contractId, method, args } = extractContractInvocation(tx);
      rpcCalls.push(`${contractId}:${method}`);

      let retval: xdr.ScVal = xdr.ScVal.scvVoid();
      if (contractId === NATIVE_TOKEN_CONTRACT_ID && method === "balance") {
        retval = nativeToScVal(25_000_000n, { type: "i128" });
      } else if (method === "status") {
        const hashHex = ("0x" + Buffer.from(args[0]!.bytes()).toString("hex")) as Hex;
        if (hashHex === HASH_1) {
          retval = nativeToScVal(OnChainIntentStatus.Locked, { type: "u32" });
        } else if (hashHex === HASH_2) {
          retval = nativeToScVal(OnChainIntentStatus.Filled, { type: "u32" });
        } else {
          retval = xdr.ScVal.scvVoid();
        }
      } else if (method === "get_intent") {
        const hashHex = ("0x" + Buffer.from(args[0]!.bytes()).toString("hex")) as Hex;
        if (hashHex === HASH_1) {
          retval = buildIntentRecordScVal({
            intentHash: HASH_1,
            srcEid: 30101,
            deadline: 1_700_005_000n,
            status: OnChainIntentStatus.Locked,
          });
        } else {
          retval = xdr.ScVal.scvVoid();
        }
      } else if (method === "keeper_reward") {
        retval = nativeToScVal(500_000n, { type: "i128" });
      } else if (method === "dispatch_keeper_reward") {
        retval = nativeToScVal(750_000n, { type: "i128" });
      } else if (method === "quote_cancel_fee") {
        retval = nativeToScVal(120_000n, { type: "i128" });
      } else if (method === "quote_fill_confirmed_fee") {
        retval = nativeToScVal(180_000n, { type: "i128" });
      }

      return {
        id: "1",
        latestLedger: 200,
        events: [],
        minResourceFee: "100",
        transactionData: new SorobanDataBuilder(),
        result: {
          auth: [],
          retval,
        },
        _parsed: true,
      };
    },
  } as unknown as SorobanRpc.Server;

  const client = new PerihelionSettlementClient({
    rpcUrl: "http://localhost:8000",
    networkPassphrase: PASSPHRASE,
    settlementContractId: SETTLEMENT_CONTRACT_ID,
    nativeTokenContractId: NATIVE_TOKEN_CONTRACT_ID,
    signerSecret: SIGNER.secret(),
    rpc: mockRpc,
  });

  assert.equal(client.callerPublicKey, SIGNER.publicKey());
  assert.equal(await client.status(HASH_1), OnChainIntentStatus.Locked);
  assert.equal(await client.status(HASH_2), OnChainIntentStatus.Filled);
  assert.equal(await client.status(HASH_3), undefined);

  const intent1 = await client.getIntent(HASH_1);
  assert.ok(intent1);
  assert.equal(intent1.intentHash, HASH_1);
  assert.equal(intent1.srcEid, 30101);
  assert.equal(intent1.deadline, 1_700_005_000n);
  assert.equal(intent1.status, OnChainIntentStatus.Locked);
  assert.equal(await client.getIntent(HASH_3), undefined);

  assert.equal(await client.keeperReward(), 500_000n);
  assert.equal(await client.dispatchKeeperReward(), 750_000n);
  assert.equal(await client.quoteCancelFee(30101), 120_000n);
  assert.equal(await client.quoteFillConfirmedFee(30101), 180_000n);
  assert.equal(await client.estimateInclusionFeeStroops(), 12_000n);
  assert.equal(await client.getContractReserveStroops(), 25_000_000n);
});

test("PerihelionSettlementClient.listUndispatchedIntents: batches >100 hashes into chunks of MAX_LIST_BATCH (100)", async () => {
  const total = 235;
  const allHashes: Hex[] = Array.from(
    { length: total },
    (_, i) => `0x${(i + 1).toString(16).padStart(64, "0")}` as Hex,
  );
  const undispatchedTarget = new Set<Hex>([allHashes[5]!, allHashes[105]!, allHashes[234]!]);
  const observedBatchSizes: number[] = [];

  const mockRpc = {
    async getAccount(address: string) {
      return new Account(address, "100");
    },
    async simulateTransaction(tx: Transaction) {
      const { method, args } = extractContractInvocation(tx);
      assert.equal(method, "list_undispatched_intents");
      const vec = args[0]!.vec() ?? [];
      assert.ok(
        vec.length <= MAX_LIST_BATCH,
        `batch size ${vec.length} exceeds MAX_LIST_BATCH (${MAX_LIST_BATCH})`,
      );
      observedBatchSizes.push(vec.length);

      const matched = vec.filter((item) => {
        const hex = ("0x" + Buffer.from(item.bytes()).toString("hex")) as Hex;
        return undispatchedTarget.has(hex);
      });

      return {
        id: "1",
        latestLedger: 200,
        events: [],
        minResourceFee: "100",
        transactionData: new SorobanDataBuilder(),
        result: {
          auth: [],
          retval: xdr.ScVal.scvVec(matched),
        },
        _parsed: true,
      };
    },
  } as unknown as SorobanRpc.Server;

  const client = new PerihelionSettlementClient({
    rpcUrl: "http://localhost:8000",
    networkPassphrase: PASSPHRASE,
    settlementContractId: SETTLEMENT_CONTRACT_ID,
    rpc: mockRpc,
  });

  assert.deepEqual(await client.listUndispatchedIntents([]), []);
  assert.equal(observedBatchSizes.length, 0);

  const result = await client.listUndispatchedIntents(allHashes);
  assert.deepEqual(observedBatchSizes, [100, 100, 35]);
  assert.deepEqual(result, [allHashes[5], allHashes[105], allHashes[234]]);
});

test("PerihelionSettlementClient.scanIntentEvents: decodes registered, filled, confirmation_sent, and cancelled events", async () => {
  const hashBytes = (h: Hex) => Buffer.from(h.slice(2), "hex");

  const mockRpc = {
    async getLatestLedger() {
      return {
        id: "ledger-500",
        protocolVersion: 21,
        sequence: 500,
        closeTime: 1_700_010_000,
      };
    },
    async getEvents() {
      return {
        latestLedger: 500,
        events: [
          {
            type: "contract",
            ledger: 450,
            ledgerClosedAt: "2026-11-21T00:00:00Z",
            contractId: SETTLEMENT_CONTRACT_ID,
            id: "evt-1",
            pagingToken: "1",
            inSuccessfulContractCall: true,
            txHash: "tx-reg-1",
            topic: [
              nativeToScVal("registered", { type: "symbol" }),
              nativeToScVal(hashBytes(HASH_1), { type: "bytes" }),
            ],
            value: xdr.ScVal.scvVec([
              nativeToScVal(30101, { type: "u32" }),
              nativeToScVal(1_700_005_000n, { type: "u64" }),
            ]),
          },
          {
            type: "contract",
            ledger: 460,
            ledgerClosedAt: "2026-11-21T00:01:00Z",
            contractId: SETTLEMENT_CONTRACT_ID,
            id: "evt-2",
            pagingToken: "2",
            inSuccessfulContractCall: true,
            txHash: "tx-fill-2",
            topic: [
              nativeToScVal("filled", { type: "symbol" }),
              nativeToScVal(hashBytes(HASH_2), { type: "bytes" }),
            ],
            value: xdr.ScVal.scvVec([
              new StellarSdkAddress(SOLVER_KP.publicKey()).toScVal(),
              new StellarSdkAddress(DEST_ASSET_ID).toScVal(),
              nativeToScVal(9_900_000n, { type: "i128" }),
              nativeToScVal(30101, { type: "u32" }),
            ]),
          },
          {
            type: "contract",
            ledger: 470,
            ledgerClosedAt: "2026-11-21T00:02:00Z",
            contractId: SETTLEMENT_CONTRACT_ID,
            id: "evt-3",
            pagingToken: "3",
            inSuccessfulContractCall: true,
            txHash: "tx-conf-3",
            topic: [
              nativeToScVal("confirmation_sent", { type: "symbol" }),
              nativeToScVal(hashBytes(HASH_3), { type: "bytes" }),
            ],
            value: xdr.ScVal.scvVec([
              new StellarSdkAddress(SOLVER_KP.publicKey()).toScVal(),
              nativeToScVal(150_000n, { type: "i128" }),
            ]),
          },
          {
            type: "contract",
            ledger: 480,
            ledgerClosedAt: "2026-11-21T00:03:00Z",
            contractId: SETTLEMENT_CONTRACT_ID,
            id: "evt-4",
            pagingToken: "4",
            inSuccessfulContractCall: true,
            txHash: "tx-cancel-4",
            topic: [
              nativeToScVal("cancelled", { type: "symbol" }),
              nativeToScVal(hashBytes(HASH_4), { type: "bytes" }),
            ],
            value: xdr.ScVal.scvVec([
              nativeToScVal(30101, { type: "u32" }),
              nativeToScVal(1_700_004_000n, { type: "u64" }),
              nativeToScVal(120_000n, { type: "i128" }),
            ]),
          },
        ],
      };
    },
  } as unknown as SorobanRpc.Server;

  const client = new PerihelionSettlementClient({
    rpcUrl: "http://localhost:8000",
    networkPassphrase: PASSPHRASE,
    settlementContractId: SETTLEMENT_CONTRACT_ID,
    rpc: mockRpc,
  });

  const scan = await client.scanIntentEvents(440);
  assert.equal(scan.latestLedger, 500);
  assert.equal(scan.latestLedgerTimestamp, 1_700_010_000n);
  assert.equal(scan.nextLedger, 501);
  assert.equal(scan.events.length, 4);

  assert.equal(scan.registered.length, 1);
  assert.equal(scan.registered[0]?.intentHash, HASH_1);
  assert.equal(scan.registered[0]?.srcEid, 30101);
  assert.equal(scan.registered[0]?.deadline, 1_700_005_000n);

  assert.equal(scan.filled.length, 1);
  assert.equal(scan.filled[0]?.intentHash, HASH_2);
  assert.equal(scan.filled[0]?.solver, SOLVER_KP.publicKey());
  assert.equal(scan.filled[0]?.fillAmount, 9_900_000n);
  assert.equal(scan.filled[0]?.srcEid, 30101);

  assert.deepEqual(scan.confirmationSent, [HASH_3]);
  assert.deepEqual(scan.cancelled, [HASH_4]);
});

test("PerihelionSettlementClient: cancelExpiredIntent and dispatchConfirmation auto-quote fees, restore footprint when needed, and submit transactions", async () => {
  let seq = 200;
  let needRestoreOnFirstCancel = true;
  const submittedOperations: string[] = [];
  const invokedWrites: Array<{ method: string; lzFee: bigint; intentHash: Hex }> = [];

  const mockRpc = {
    async getAccount(address: string) {
      return new Account(address, String(seq));
    },
    async getFeeStats() {
      return {
        sorobanInclusionFee: { p50: "100", p90: "10000", max: "50000" },
      };
    },
    async simulateTransaction(tx: Transaction) {
      const { method, args } = extractContractInvocation(tx);
      if (method === "get_intent") {
        const hashHex = ("0x" + Buffer.from(args[0]!.bytes()).toString("hex")) as Hex;
        return {
          id: "sim-get",
          latestLedger: 300,
          events: [],
          minResourceFee: "100",
          transactionData: new SorobanDataBuilder(),
          result: {
            auth: [],
            retval: buildIntentRecordScVal({
              intentHash: hashHex,
              srcEid: 30101,
              deadline: 1_700_000_000n,
              status: hashHex === HASH_1 ? OnChainIntentStatus.Locked : OnChainIntentStatus.Filled,
            }),
          },
          _parsed: true,
        };
      }
      if (method === "quote_cancel_fee") {
        return {
          id: "sim-q-cancel",
          latestLedger: 300,
          events: [],
          minResourceFee: "100",
          transactionData: new SorobanDataBuilder(),
          result: {
            auth: [],
            retval: nativeToScVal(120_000n, { type: "i128" }),
          },
          _parsed: true,
        };
      }
      if (method === "quote_fill_confirmed_fee") {
        return {
          id: "sim-q-confirm",
          latestLedger: 300,
          events: [],
          minResourceFee: "100",
          transactionData: new SorobanDataBuilder(),
          result: {
            auth: [],
            retval: nativeToScVal(180_000n, { type: "i128" }),
          },
          _parsed: true,
        };
      }
      if (method === "cancel_expired_intent" && needRestoreOnFirstCancel) {
        needRestoreOnFirstCancel = false;
        return {
          id: "sim-restore",
          latestLedger: 300,
          events: [],
          minResourceFee: "100",
          transactionData: new SorobanDataBuilder(),
          result: {
            auth: [],
            retval: xdr.ScVal.scvVoid(),
          },
          restorePreamble: {
            minResourceFee: "500",
            transactionData: new SorobanDataBuilder(),
          },
          _parsed: true,
        };
      }
      if (method === "cancel_expired_intent" || method === "dispatch_confirmation") {
        return {
          id: "sim-write",
          latestLedger: 300,
          events: [],
          minResourceFee: "100",
          transactionData: new SorobanDataBuilder(),
          result: {
            auth: [],
            retval: xdr.ScVal.scvVoid(),
          },
          _parsed: true,
        };
      }
      throw new Error(`Unexpected simulated method: ${method}`);
    },
    async sendTransaction(tx: Transaction) {
      seq += 1;
      const opType = tx.operations[0]?.type ?? "unknown";
      submittedOperations.push(opType);
      if (opType === "invokeHostFunction") {
        const { method, args } = extractContractInvocation(tx);
        const hashHex = ("0x" + Buffer.from(args[1]!.bytes()).toString("hex")) as Hex;
        const lzFee = BigInt((args[2]!.i128().lo().toBigInt() & 0xffffffffffffffffn).toString());
        invokedWrites.push({ method, lzFee, intentHash: hashHex });
      }
      return {
        status: "PENDING",
        hash: `tx-${submittedOperations.length}`,
        latestLedger: 300,
        latestLedgerCloseTime: 1_700_005_000,
      };
    },
    async getTransaction() {
      return {
        status: "SUCCESS",
        latestLedger: 301,
        latestLedgerCloseTime: 1_700_005_005,
        oldestLedger: 1,
        oldestLedgerCloseTime: 1_700_000_000,
        ledger: 301,
        createdAt: 1_700_005_005,
        applicationOrder: 1,
        feeBump: false,
        resultXdr: {
          feeCharged: () => ({ toString: () => "10100" }),
        },
      };
    },
  } as unknown as SorobanRpc.Server;

  // Read-only client must reject write operations
  const readOnlyClient = new PerihelionSettlementClient({
    rpcUrl: "http://localhost:8000",
    networkPassphrase: PASSPHRASE,
    settlementContractId: SETTLEMENT_CONTRACT_ID,
    rpc: mockRpc,
  });
  await assert.rejects(() => readOnlyClient.cancelExpiredIntent(HASH_1), /requires signerSecret/);

  const client = new PerihelionSettlementClient({
    rpcUrl: "http://localhost:8000",
    networkPassphrase: PASSPHRASE,
    settlementContractId: SETTLEMENT_CONTRACT_ID,
    signerSecret: SIGNER.secret(),
    lzFeeBufferStroops: 5_000n,
    submitOptions: { pollIntervalMs: 0, backoffMs: 0, maxAttempts: 2 },
    rpc: mockRpc,
  });

  // 1. cancelExpiredIntent auto-quotes 120_000 + 5_000 buffer = 125_000, restores footprint first, then submits
  const cancelRes = await client.cancelExpiredIntent(HASH_1);
  assert.equal(cancelRes.intentHash, HASH_1);
  assert.equal(cancelRes.lzFeeStroops, 125_000n);
  assert.equal(cancelRes.feeChargedStroops, 10_100n);
  assert.equal(cancelRes.txHash, "tx-2");
  assert.deepEqual(submittedOperations.slice(0, 2), ["restoreFootprint", "invokeHostFunction"]);

  // 2. dispatchConfirmation auto-quotes 180_000 + 5_000 buffer = 185_000 and submits
  const dispatchRes = await client.dispatchConfirmation(HASH_2);
  assert.equal(dispatchRes.intentHash, HASH_2);
  assert.equal(dispatchRes.lzFeeStroops, 185_000n);
  assert.equal(dispatchRes.feeChargedStroops, 10_100n);
  assert.equal(dispatchRes.txHash, "tx-3");

  assert.deepEqual(invokedWrites, [
    { method: "cancel_expired_intent", lzFee: 125_000n, intentHash: HASH_1 },
    { method: "dispatch_confirmation", lzFee: 185_000n, intentHash: HASH_2 },
  ]);
});
