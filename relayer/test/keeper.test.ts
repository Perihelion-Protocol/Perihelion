// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { test } from "node:test";
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import {
  DISPATCH_REWARD_GRACE_LEDGERS,
  OnChainIntentStatus,
  dispatchCutoff,
  type Hex,
  type SorobanIntentEventScanResult,
  type SorobanIntentRecord,
  type SorobanKeeperTxResult,
} from "@perihelion/sdk";
import { loadConfig, type RelayerConfig } from "../src/config.js";
import {
  Keeper,
  renderKeeperPrometheusMetrics,
  type EvmKeeperAdapter,
  type EvmKeeperScanResult,
  type SorobanKeeperAdapter,
} from "../src/keeper.js";
import { validConfigEnv } from "./fixtures.js";

const KEEPER_KP = Keypair.random();
const SOLVER_KP = Keypair.random();
const RECIPIENT_KP = Keypair.random();
const DEST_ASSET_ID = StrKey.encodeContract(Buffer.alloc(32, 0x33));

const HASH_EVM_EXPIRED = ("0x" + "a1".repeat(32)) as Hex;
const HASH_EVM_ACTIVE = ("0x" + "a2".repeat(32)) as Hex;
const HASH_EVM_FINALIZED = ("0x" + "a3".repeat(32)) as Hex;

const HASH_SOROBAN_EXPIRED = ("0x" + "b1".repeat(32)) as Hex;
const HASH_SOROBAN_ACTIVE = ("0x" + "b2".repeat(32)) as Hex;
const HASH_SOROBAN_UNDISPATCHED = ("0x" + "c1".repeat(32)) as Hex;
const HASH_SOROBAN_EXPIRED_CUTOFF = ("0x" + "c2".repeat(32)) as Hex;

function keeperConfig(overrides: Partial<RelayerConfig> = {}): RelayerConfig {
  const base = loadConfig({
    ...validConfigEnv(),
    PERIHELION_RELAYER_MODE: "keeper",
    PERIHELION_CONFIRMATIONS: "2",
    PERIHELION_POLL_INTERVAL_MS: "100",
  });
  return {
    ...base,
    ...overrides,
  };
}

function emptySorobanScan(
  latestLedger = 1000,
  latestLedgerTimestamp = 20_000n,
): SorobanIntentEventScanResult {
  return {
    events: [],
    registered: [],
    filled: [],
    confirmationSent: [],
    cancelled: [],
    latestLedger,
    latestLedgerTimestamp,
    nextLedger: latestLedger + 1,
  };
}

function makeSorobanRecord(opts: {
  intentHash: Hex;
  srcEid?: number;
  deadline: bigint;
  status: OnChainIntentStatus;
  solver?: string;
  fillLedger?: number;
}): SorobanIntentRecord {
  return {
    intentHash: opts.intentHash,
    srcEid: opts.srcEid ?? 30101,
    recipient: RECIPIENT_KP.publicKey(),
    destAsset: DEST_ASSET_ID,
    minDestAmount: 9_900_000n,
    deadline: opts.deadline,
    reservationExpires: 0n,
    status: opts.status,
    ...(opts.solver ? { solver: opts.solver } : {}),
    fillAmount: 10_000_000n,
    fillLedger: opts.fillLedger ?? 500,
    registeredLedger: 480,
  };
}

function makeTxResult(
  intentHash: Hex,
  lzFeeStroops: bigint,
  txHash = "soroban-tx-1",
): SorobanKeeperTxResult {
  return {
    txHash,
    intentHash,
    lzFeeStroops,
    inclusionFeeStroops: 10_000,
    feeChargedStroops: 10_000n,
    attempts: 1,
  };
}

// ---------------------------------------------------------------------------
// 1. EVM Locked Scan & cancelExpired
// ---------------------------------------------------------------------------

test("Keeper.tick: scans EVM Locked events past deadline + confirmationGrace and calls cancelExpired", async () => {
  const cancelledHashes: Hex[] = [];
  let savedEvmCursor: number | undefined;

  const evmAdapter: EvmKeeperAdapter = {
    async scanEvents(fromBlock: number): Promise<EvmKeeperScanResult> {
      assert.equal(fromBlock, 0);
      return {
        head: 100, // confirmedHead = 100 - 2 = 98
        blockTimestamp: 20_000n,
        confirmationGrace: 7_200n,
        locked: [
          // Expired: 10_000 + 7_200 = 17_200 <= 20_000 (at confirmed block 50)
          { intentHash: HASH_EVM_EXPIRED, deadline: 10_000n, blockNumber: 50 },
          // Not yet expired: 15_000 + 7_200 = 22_200 > 20_000
          { intentHash: HASH_EVM_ACTIVE, deadline: 15_000n, blockNumber: 60 },
          // Locked then finalized in the same scan window
          { intentHash: HASH_EVM_FINALIZED, deadline: 9_000n, blockNumber: 40 },
        ],
        finalized: [{ intentHash: HASH_EVM_FINALIZED, blockNumber: 45 }],
      };
    },
    async checkRefundable(intentHash: Hex) {
      return {
        refundable: intentHash === HASH_EVM_EXPIRED,
        reason: intentHash === HASH_EVM_EXPIRED ? undefined : "DeadlineNotPassed",
      };
    },
    async estimateCancelGasAndPrice() {
      return {
        gasPriceWei: 10_000_000_000n,
        estimatedGas: 80_000n,
      };
    },
    async cancelExpired(intentHash: Hex) {
      cancelledHashes.push(intentHash);
      return {
        txHash: ("0x" + "ee".repeat(32)) as Hex,
        gasUsedWei: 750_000_000_000_000n,
      };
    },
  };

  const keeper = new Keeper({
    config: keeperConfig(),
    evmAdapter,
    sorobanAdapter: null,
    evmCheckpoint: {
      load: async () => undefined,
      save: async (cursor) => {
        savedEvmCursor = cursor;
      },
    },
  });

  const res = await keeper.tick();
  assert.deepEqual(res.evmCancelled, [HASH_EVM_EXPIRED]);
  assert.deepEqual(cancelledHashes, [HASH_EVM_EXPIRED]);
  assert.equal(keeper.metrics.evmCancelledTotal, 1);
  assert.equal(keeper.metrics.evmGasSpentWei, 750_000_000_000_000n);
  assert.equal(savedEvmCursor, 99); // confirmedHead (98) + 1
  assert.equal(keeper.readiness.evmCursor, 99);
});

// ---------------------------------------------------------------------------
// 2. Soroban registered Scan & cancel_expired_intent
// ---------------------------------------------------------------------------

test("Keeper.tick: scans Soroban registered events past deadline and calls cancel_expired_intent", async () => {
  const cancelledOnSoroban: Array<{ intentHash: Hex; lzFee: bigint }> = [];
  let savedSorobanCursor: number | undefined;

  const sorobanAdapter: SorobanKeeperAdapter = {
    callerPublicKey: KEEPER_KP.publicKey(),
    async scanEvents(fromLedger: number) {
      assert.equal(fromLedger, 1);
      return {
        ...emptySorobanScan(500, 20_000n),
        registered: [
          {
            intentHash: HASH_SOROBAN_EXPIRED,
            srcEid: 30101,
            deadline: 18_000n, // <= 20_000n (expired)
            ledger: 410,
          },
          {
            intentHash: HASH_SOROBAN_ACTIVE,
            srcEid: 30101,
            deadline: 25_000n, // > 20_000n (still active)
            ledger: 420,
          },
        ],
      };
    },
    async status(intentHash: Hex) {
      if (intentHash === HASH_SOROBAN_EXPIRED || intentHash === HASH_SOROBAN_ACTIVE) {
        return OnChainIntentStatus.Locked;
      }
      return undefined;
    },
    async getIntent() {
      return undefined;
    },
    async listUndispatchedIntents() {
      return [];
    },
    async keeperReward() {
      return 400_000n;
    },
    async dispatchKeeperReward() {
      return 0n;
    },
    async quoteCancelFee(dstEid: number) {
      assert.equal(dstEid, 30101);
      return 120_000n;
    },
    async quoteFillConfirmedFee() {
      return 180_000n;
    },
    async estimateInclusionFeeStroops() {
      return 10_000n;
    },
    async getContractReserveStroops() {
      return 5_000_000n;
    },
    async cancelExpiredIntent(intentHash: Hex, lzFeeStroops: bigint) {
      cancelledOnSoroban.push({ intentHash, lzFee: lzFeeStroops });
      return makeTxResult(intentHash, lzFeeStroops, "soroban-cancel-tx-1");
    },
    async dispatchConfirmation(intentHash: Hex, lzFeeStroops: bigint) {
      return makeTxResult(intentHash, lzFeeStroops);
    },
  };

  const keeper = new Keeper({
    config: keeperConfig({ keeperLzFeeBufferStroops: 5_000n }),
    evmAdapter: null,
    sorobanAdapter,
    sorobanCheckpoint: {
      load: async () => undefined,
      save: async (cursor) => {
        savedSorobanCursor = cursor;
      },
    },
  });

  const res = await keeper.tick();
  assert.deepEqual(res.sorobanCancelled, [HASH_SOROBAN_EXPIRED]);
  assert.deepEqual(cancelledOnSoroban, [{ intentHash: HASH_SOROBAN_EXPIRED, lzFee: 125_000n }]);
  assert.equal(keeper.metrics.sorobanCancelledTotal, 1);
  assert.equal(keeper.metrics.sorobanFeesSpentStroops, 135_000n); // 125_000 lzFee + 10_000 feeCharged
  assert.equal(keeper.metrics.sorobanRewardsEarnedStroops, 400_000n);
  assert.equal(savedSorobanCursor, 501);
});

// ---------------------------------------------------------------------------
// 3. Soroban list_undispatched_intents & dispatch_confirmation
// ---------------------------------------------------------------------------

test("Keeper.tick: discovers Filled intents via list_undispatched_intents and calls dispatch_confirmation after DISPATCH_REWARD_GRACE_LEDGERS", async () => {
  const dispatched: Array<{ intentHash: Hex; lzFee: bigint }> = [];
  const fillLedger = 500;
  let currentLedger = fillLedger + DISPATCH_REWARD_GRACE_LEDGERS - 10; // 350 ledgers (< 360 grace)
  const deadline = 30_000n;
  const currentTimestamp = 25_000n; // well before dispatchCutoff(30_000) = 30_600

  const sorobanAdapter: SorobanKeeperAdapter = {
    callerPublicKey: KEEPER_KP.publicKey(),
    async scanEvents() {
      return {
        ...emptySorobanScan(currentLedger, currentTimestamp),
        filled: [
          {
            intentHash: HASH_SOROBAN_UNDISPATCHED,
            solver: SOLVER_KP.publicKey(),
            destAsset: DEST_ASSET_ID,
            fillAmount: 10_000_000n,
            srcEid: 30101,
            ledger: fillLedger,
          },
        ],
      };
    },
    async status() {
      return OnChainIntentStatus.Filled;
    },
    async getIntent(intentHash: Hex) {
      if (intentHash === HASH_SOROBAN_UNDISPATCHED) {
        return makeSorobanRecord({
          intentHash,
          deadline,
          status: OnChainIntentStatus.Filled,
          solver: SOLVER_KP.publicKey(),
          fillLedger,
        });
      }
      return undefined;
    },
    async listUndispatchedIntents(hashes: readonly Hex[]) {
      return hashes.filter((h) => h === HASH_SOROBAN_UNDISPATCHED);
    },
    async keeperReward() {
      return 0n;
    },
    async dispatchKeeperReward() {
      return 600_000n;
    },
    async quoteCancelFee() {
      return 120_000n;
    },
    async quoteFillConfirmedFee() {
      return 180_000n;
    },
    async estimateInclusionFeeStroops() {
      return 10_000n;
    },
    async getContractReserveStroops() {
      return 10_000_000n;
    },
    async cancelExpiredIntent(intentHash: Hex, lzFeeStroops: bigint) {
      return makeTxResult(intentHash, lzFeeStroops);
    },
    async dispatchConfirmation(intentHash: Hex, lzFeeStroops: bigint) {
      dispatched.push({ intentHash, lzFee: lzFeeStroops });
      return makeTxResult(intentHash, lzFeeStroops, "soroban-dispatch-tx-1");
    },
  };

  const keeper = new Keeper({
    config: keeperConfig({ keeperLzFeeBufferStroops: 10_000n }),
    evmAdapter: null,
    sorobanAdapter,
  });

  // Tick 1: only 350 ledgers elapsed (< 360 DISPATCH_REWARD_GRACE_LEDGERS) -> deferred!
  const tick1 = await keeper.tick();
  assert.equal(tick1.confirmationsDispatched.length, 0);
  assert.equal(dispatched.length, 0);
  assert.equal(keeper.metrics.skippedAwaitingGraceTotal, 1);
  assert.equal(tick1.skipped[0]?.reason, "awaiting_dispatch_reward_grace");

  // Tick 2: advance ledger to fillLedger + DISPATCH_REWARD_GRACE_LEDGERS (860) -> executes!
  currentLedger = fillLedger + DISPATCH_REWARD_GRACE_LEDGERS;
  const tick2 = await keeper.tick();
  assert.deepEqual(tick2.confirmationsDispatched, [HASH_SOROBAN_UNDISPATCHED]);
  assert.deepEqual(dispatched, [{ intentHash: HASH_SOROBAN_UNDISPATCHED, lzFee: 190_000n }]);
  assert.equal(keeper.metrics.confirmationsDispatchedTotal, 1);
  assert.equal(keeper.metrics.sorobanRewardsEarnedStroops, 600_000n);
  assert.equal(keeper.metrics.sorobanFeesSpentStroops, 200_000n);
});

// ---------------------------------------------------------------------------
// 4. Dry-Run Mode
// ---------------------------------------------------------------------------

test("Keeper.tick: dryRun mode records candidate actions without submitting any state-mutating transactions", async () => {
  let evmCancelCalled = false;
  let sorobanCancelCalled = false;
  let sorobanDispatchCalled = false;

  const evmAdapter: EvmKeeperAdapter = {
    async scanEvents() {
      return {
        head: 50,
        blockTimestamp: 30_000n,
        confirmationGrace: 7_200n,
        locked: [{ intentHash: HASH_EVM_EXPIRED, deadline: 10_000n, blockNumber: 10 }],
        finalized: [],
      };
    },
    async checkRefundable() {
      return { refundable: true };
    },
    async estimateCancelGasAndPrice() {
      return { gasPriceWei: 5_000_000_000n, estimatedGas: 80_000n };
    },
    async cancelExpired() {
      evmCancelCalled = true;
      throw new Error("cancelExpired must not be called in dry-run mode");
    },
  };

  const sorobanAdapter: SorobanKeeperAdapter = {
    callerPublicKey: KEEPER_KP.publicKey(),
    async scanEvents() {
      return {
        ...emptySorobanScan(1000, 30_000n),
        registered: [
          {
            intentHash: HASH_SOROBAN_EXPIRED,
            srcEid: 30101,
            deadline: 20_000n,
            ledger: 400,
          },
        ],
        filled: [
          {
            intentHash: HASH_SOROBAN_UNDISPATCHED,
            solver: SOLVER_KP.publicKey(),
            destAsset: DEST_ASSET_ID,
            fillAmount: 10_000_000n,
            srcEid: 30101,
            ledger: 400,
          },
        ],
      };
    },
    async status(hash: Hex) {
      return hash === HASH_SOROBAN_EXPIRED
        ? OnChainIntentStatus.Locked
        : OnChainIntentStatus.Filled;
    },
    async getIntent(hash: Hex) {
      return makeSorobanRecord({
        intentHash: hash,
        deadline: 35_000n,
        status: OnChainIntentStatus.Filled,
        solver: SOLVER_KP.publicKey(),
        fillLedger: 400,
      });
    },
    async listUndispatchedIntents(hashes: readonly Hex[]) {
      return hashes.filter((h) => h === HASH_SOROBAN_UNDISPATCHED);
    },
    async keeperReward() {
      return 500_000n;
    },
    async dispatchKeeperReward() {
      return 500_000n;
    },
    async quoteCancelFee() {
      return 100_000n;
    },
    async quoteFillConfirmedFee() {
      return 150_000n;
    },
    async estimateInclusionFeeStroops() {
      return 10_000n;
    },
    async cancelExpiredIntent() {
      sorobanCancelCalled = true;
      throw new Error("cancelExpiredIntent must not be called in dry-run mode");
    },
    async dispatchConfirmation() {
      sorobanDispatchCalled = true;
      throw new Error("dispatchConfirmation must not be called in dry-run mode");
    },
  };

  const keeper = new Keeper({
    config: keeperConfig({ keeperDryRun: true }),
    evmAdapter,
    sorobanAdapter,
  });

  const res = await keeper.tick();
  assert.equal(evmCancelCalled, false);
  assert.equal(sorobanCancelCalled, false);
  assert.equal(sorobanDispatchCalled, false);

  assert.equal(res.evmCancelled.length, 0);
  assert.equal(res.sorobanCancelled.length, 0);
  assert.equal(res.confirmationsDispatched.length, 0);
  assert.equal(res.dryRunActions.length, 3);
  assert.equal(keeper.metrics.dryRunActionsTotal, 3);
  assert.deepEqual(
    res.dryRunActions.map((a) => a.action),
    ["cancelExpired", "cancel_expired_intent", "dispatch_confirmation"],
  );
});

// ---------------------------------------------------------------------------
// 5. Profitability Guards, Expired Dispatch Window & Prometheus Metrics
// ---------------------------------------------------------------------------

test("Keeper.tick: enforces EVM gas guards, Soroban profitability guards, and dispatch_cutoff window", async () => {
  const evmAdapter: EvmKeeperAdapter = {
    async scanEvents() {
      return {
        head: 50,
        blockTimestamp: 30_000n,
        confirmationGrace: 7_200n,
        locked: [{ intentHash: HASH_EVM_EXPIRED, deadline: 10_000n, blockNumber: 10 }],
        finalized: [],
      };
    },
    async checkRefundable() {
      return { refundable: true };
    },
    async estimateCancelGasAndPrice() {
      return {
        gasPriceWei: 50_000_000_000n, // 50 gwei > 20 gwei cap
        estimatedGas: 100_000n,
      };
    },
    async cancelExpired() {
      throw new Error("must be blocked by gas guard");
    },
  };

  const expiredDeadline = 20_000n;
  // dispatchCutoff(20_000) = 20_600. Current ledger timestamp is 25_000 > 20_600.
  assert.equal(dispatchCutoff(expiredDeadline), 20_600n);

  const sorobanAdapter: SorobanKeeperAdapter = {
    callerPublicKey: KEEPER_KP.publicKey(),
    async scanEvents() {
      return {
        ...emptySorobanScan(1000, 25_000n),
        registered: [
          {
            intentHash: HASH_SOROBAN_EXPIRED,
            srcEid: 30101,
            deadline: 18_000n,
            ledger: 400,
          },
        ],
        filled: [
          {
            intentHash: HASH_SOROBAN_EXPIRED_CUTOFF,
            solver: SOLVER_KP.publicKey(),
            destAsset: DEST_ASSET_ID,
            fillAmount: 10_000_000n,
            srcEid: 30101,
            ledger: 400,
          },
        ],
      };
    },
    async status(hash: Hex) {
      return hash === HASH_SOROBAN_EXPIRED
        ? OnChainIntentStatus.Locked
        : OnChainIntentStatus.Filled;
    },
    async getIntent(hash: Hex) {
      return makeSorobanRecord({
        intentHash: hash,
        deadline: expiredDeadline, // cutoff 20_600 < currentTimestamp 25_000
        status: OnChainIntentStatus.Filled,
        solver: SOLVER_KP.publicKey(),
        fillLedger: 400,
      });
    },
    async listUndispatchedIntents(hashes: readonly Hex[]) {
      return hashes.filter((h) => h === HASH_SOROBAN_EXPIRED_CUTOFF);
    },
    async keeperReward() {
      return 50_000n; // < 120_000 lzFee + 10_000 inclusionFee (unprofitable)
    },
    async dispatchKeeperReward() {
      return 500_000n;
    },
    async quoteCancelFee() {
      return 120_000n;
    },
    async quoteFillConfirmedFee() {
      return 150_000n;
    },
    async estimateInclusionFeeStroops() {
      return 10_000n;
    },
    async cancelExpiredIntent() {
      throw new Error("must be skipped as unprofitable");
    },
    async dispatchConfirmation() {
      throw new Error("must be skipped due to expired dispatch window");
    },
  };

  const keeper = new Keeper({
    config: keeperConfig({
      keeperMaxGasPriceWei: 20_000_000_000n,
      keeperEnforceProfitability: true,
    }),
    evmAdapter,
    sorobanAdapter,
  });

  const res = await keeper.tick();
  assert.equal(res.evmCancelled.length, 0);
  assert.equal(res.sorobanCancelled.length, 0);
  assert.equal(res.confirmationsDispatched.length, 0);
  assert.equal(res.skipped.length, 3);
  assert.equal(keeper.metrics.skippedUnprofitableTotal, 2); // 1 EVM gas cap + 1 Soroban unprofitable
  assert.equal(keeper.metrics.skippedExpiredWindowTotal, 1); // 1 Soroban past dispatchCutoff

  const prom = keeper.renderPrometheusMetrics();
  assert.match(prom, /keeper_ticks_total 1/);
  assert.match(prom, /keeper_skipped_unprofitable_total 2/);
  assert.match(prom, /keeper_skipped_expired_window_total 1/);
  assert.match(prom, /keeper_evm_cancelled_total 0/);
  assert.match(prom, /keeper_soroban_cancelled_total 0/);
  assert.match(prom, /keeper_confirmations_dispatched_total 0/);

  const standaloneProm = renderKeeperPrometheusMetrics(keeper.metrics, keeper.readiness);
  assert.equal(standaloneProm, prom);
});
