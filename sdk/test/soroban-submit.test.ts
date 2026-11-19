// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  Keypair,
  Operation,
  TransactionBuilder,
  type Account,
  type SorobanRpc,
} from "@stellar/stellar-sdk";
import {
  escalateInclusionFee,
  inclusionFeePolicyFromEnv,
  quoteInclusionFee,
  resolveInclusionFeePolicy,
  submitWithFeeEscalation,
  SubmissionExpiredError,
  DEFAULT_INCLUSION_FEE_POLICY,
} from "../src/soroban-submit.js";

const PASSPHRASE = "Test SDF Network ; September 2015";
const signer = Keypair.random();

/** Minimal fake of the RPC methods the submission path calls. */
function fakeRpc(opts: {
  sendResponses?: unknown[];
  feeStats?: Partial<Record<"p50" | "p70" | "p90" | "p95" | "p99", string>>;
  feeStatsError?: Error;
  getTx?: (hash: string) => unknown;
}) {
  const queue = [...(opts.sendResponses ?? [])];
  const sent: { sequence: string; fee: string }[] = [];
  const rpc = {
    async getFeeStats() {
      if (opts.feeStatsError) throw opts.feeStatsError;
      const d = { p50: "100", p70: "100", p90: "100", p95: "100", p99: "100", ...opts.feeStats };
      return { sorobanInclusionFee: d };
    },
    async sendTransaction(tx: { sequence: string; fee: string }) {
      sent.push({ sequence: tx.sequence, fee: tx.fee });
      return queue.shift();
    },
    async getTransaction(hash: string) {
      return (opts.getTx ?? (() => ({ status: "NOT_FOUND" })))(hash);
    },
  };
  return { rpc: rpc as unknown as SorobanRpc.Server, sent };
}

function success(feeCharged: string) {
  return {
    status: "SUCCESS",
    latestLedger: 1,
    latestLedgerCloseTime: 1,
    oldestLedger: 1,
    oldestLedgerCloseTime: 1,
    ledger: 1,
    createdAt: 1,
    applicationOrder: 1,
    feeBump: false,
    envelopeXdr: undefined,
    resultMetaXdr: undefined,
    resultXdr: { feeCharged: () => ({ toString: () => feeCharged }) },
  };
}

/** Build a minimal signable transaction for the given account and bid. */
function prepare(account: Account, fee: number) {
  return Promise.resolve(
    new TransactionBuilder(account, { fee: String(fee), networkPassphrase: PASSPHRASE })
      .addOperation(Operation.bumpSequence({ bumpTo: "0" }))
      .setTimeout(30)
      .build(),
  );
}

const fast = { pollIntervalMs: 0, backoffMs: 0, maxAttempts: 1 };

test("quoteInclusionFee bids the configured percentile, clamped to floor and cap", async () => {
  const quote = (p90: string) =>
    quoteInclusionFee(fakeRpc({ feeStats: { p90 } }).rpc, {
      percentile: 90,
      floorStroops: 10_000,
      capStroops: 50_000,
    });
  assert.equal(await quote("250"), 10_000, "observed fee below the floor is raised to the floor");
  assert.equal(await quote("20000"), 20_000, "observed fee inside the band is bid as-is");
  assert.equal(await quote("9999999"), 50_000, "observed fee above the cap is capped");
});

test("quoteInclusionFee reads the requested percentile, not another one", async () => {
  const { rpc } = fakeRpc({ feeStats: { p50: "11000", p99: "40000" } });
  assert.equal(
    await quoteInclusionFee(rpc, { percentile: 50, floorStroops: 10_000, capStroops: 100_000 }),
    11_000,
  );
  assert.equal(
    await quoteInclusionFee(rpc, { percentile: 99, floorStroops: 10_000, capStroops: 100_000 }),
    40_000,
  );
});

test("quoteInclusionFee falls back to the floor and logs when getFeeStats fails", async () => {
  const warnings: string[] = [];
  const { rpc } = fakeRpc({ feeStatsError: new Error("rpc down") });
  const bid = await quoteInclusionFee(
    rpc,
    { floorStroops: 12_345 },
    { warn: (m) => warnings.push(m) },
  );
  assert.equal(bid, 12_345);
  assert.equal(warnings.length, 1);
});

test("escalateInclusionFee grows the bid each time and never exceeds the cap", () => {
  const policy = resolveInclusionFeePolicy({
    floorStroops: 10_000,
    capStroops: 50_000,
    bumpFactor: 1.5,
  });
  assert.equal(escalateInclusionFee(10_000, policy), 15_000);
  assert.equal(escalateInclusionFee(15_000, policy), 22_500);
  assert.equal(escalateInclusionFee(40_000, policy), 50_000);
  assert.equal(escalateInclusionFee(50_000, policy), 50_000);
});

test("resolveInclusionFeePolicy fills defaults and rejects unusable values", () => {
  assert.deepEqual(resolveInclusionFeePolicy({}), DEFAULT_INCLUSION_FEE_POLICY);
  assert.throws(() => resolveInclusionFeePolicy({ percentile: 42 as 50 }), RangeError);
  assert.throws(() => resolveInclusionFeePolicy({ floorStroops: 10, capStroops: 100 }), RangeError);
  assert.throws(
    () => resolveInclusionFeePolicy({ floorStroops: 10_000, capStroops: 5_000 }),
    RangeError,
  );
  assert.throws(() => resolveInclusionFeePolicy({ bumpFactor: 1 }), RangeError);
  assert.throws(() => resolveInclusionFeePolicy({ maxAttempts: 0 }), RangeError);
});

test("a refused attempt is resubmitted with a higher fee and the same sequence number", async () => {
  const { rpc, sent } = fakeRpc({
    sendResponses: [
      { status: "TRY_AGAIN_LATER", hash: "h1" },
      { status: "PENDING", hash: "h2" },
    ],
    getTx: (hash) => (hash === "h2" ? success("15000") : { status: "NOT_FOUND" }),
  });

  const result = await submitWithFeeEscalation({
    rpc,
    signerPublicKey: signer.publicKey(),
    sequence: "100",
    prepare,
    sign: (tx) => tx.sign(signer),
    policy: { floorStroops: 10_000, capStroops: 100_000, bumpFactor: 1.5 },
    submitOptions: fast,
  });

  assert.equal(result.attempts, 2);
  assert.equal(result.inclusionFeeStroops, 15_000);
  assert.equal(result.feeChargedStroops, 15_000n);
  assert.equal(result.hash, "h2");
  assert.deepEqual(
    sent.map((s) => s.fee),
    ["10000", "15000"],
    "fee escalates between attempts",
  );
  assert.equal(sent[0].sequence, sent[1].sequence, "every attempt reuses the same sequence number");
});

test("refusals escalate until the cap, then fail instead of looping", async () => {
  const { rpc, sent } = fakeRpc({
    sendResponses: Array.from({ length: 5 }, (_, i) => ({
      status: "TRY_AGAIN_LATER",
      hash: `r${i}`,
    })),
  });

  await assert.rejects(
    submitWithFeeEscalation({
      rpc,
      signerPublicKey: signer.publicKey(),
      sequence: "7",
      prepare,
      sign: (tx) => tx.sign(signer),
      policy: { floorStroops: 10_000, capStroops: 15_000, bumpFactor: 1.5, maxAttempts: 10 },
      submitOptions: fast,
    }),
    (err: unknown) => err instanceof SubmissionExpiredError && /cap/.test((err as Error).message),
  );
  assert.deepEqual(
    sent.map((s) => s.fee),
    ["10000", "15000"],
    "bids stop at the cap; no third attempt",
  );
});

test("an on-chain FAILED result is not retried with a higher fee", async () => {
  const { rpc, sent } = fakeRpc({
    sendResponses: [{ status: "PENDING", hash: "bad" }],
    getTx: () => ({ status: "FAILED", resultXdr: "AAAA" }),
  });

  await assert.rejects(
    submitWithFeeEscalation({
      rpc,
      signerPublicKey: signer.publicKey(),
      sequence: "1",
      prepare,
      sign: (tx) => tx.sign(signer),
      submitOptions: fast,
    }),
    /Transaction failed/,
  );
  assert.equal(sent.length, 1, "no resubmission after an on-chain failure");
});

test("an earlier attempt that lands late is reported instead of resubmitting", async () => {
  let polls = 0;
  const { rpc, sent } = fakeRpc({
    sendResponses: [{ status: "PENDING", hash: "first" }],
    // Poll budget of one: attempt 1 times out (NOT_FOUND). The lookup in the
    // escalation path then shows that the same transaction did land.
    getTx: () => {
      polls += 1;
      return polls === 1 ? { status: "NOT_FOUND" } : success("10000");
    },
  });

  const result = await submitWithFeeEscalation({
    rpc,
    signerPublicKey: signer.publicKey(),
    sequence: "42",
    prepare,
    sign: (tx) => tx.sign(signer),
    submitOptions: fast,
  });

  assert.equal(result.attempts, 1);
  assert.equal(result.feeChargedStroops, 10_000n);
  assert.equal(sent.length, 1, "no second submission once an earlier one has landed");
});

test("a simulation failure on a retry does not hide an attempt that has since landed", async () => {
  // Attempt 1 is refused and expires without being visible yet. Attempt 2 cannot
  // be simulated (the first one applied). By then attempt 1 has landed, so the
  // result must be that landed transaction, not the simulation error.
  let lookups = 0;
  let prepared = 0;
  const { rpc, sent } = fakeRpc({
    sendResponses: [{ status: "TRY_AGAIN_LATER", hash: "first" }],
    getTx: () => {
      lookups += 1;
      return lookups === 1 ? { status: "NOT_FOUND" } : success("10000");
    },
  });

  const result = await submitWithFeeEscalation({
    rpc,
    signerPublicKey: signer.publicKey(),
    sequence: "9",
    prepare: (account, fee) => {
      prepared += 1;
      if (prepared === 2) return Promise.reject(new Error("simulation failed: already applied"));
      return prepare(account, fee);
    },
    sign: (tx) => tx.sign(signer),
    submitOptions: fast,
  });

  assert.equal(result.attempts, 2);
  assert.equal(result.feeChargedStroops, 10_000n);
  assert.equal(sent.length, 1, "the failing simulation never reaches the network");
});

test("inclusionFeePolicyFromEnv reads operator settings and rejects bad values", () => {
  assert.deepEqual(inclusionFeePolicyFromEnv({}), {});
  assert.deepEqual(
    inclusionFeePolicyFromEnv({
      PERIHELION_SOROBAN_INCLUSION_FEE_PERCENTILE: "99",
      PERIHELION_SOROBAN_MIN_INCLUSION_FEE: "500",
      PERIHELION_SOROBAN_MAX_INCLUSION_FEE: "250000",
    }),
    { percentile: 99, floorStroops: 500, capStroops: 250_000 },
  );
  assert.throws(
    () => inclusionFeePolicyFromEnv({ PERIHELION_SOROBAN_MAX_INCLUSION_FEE: "lots" }),
    /PERIHELION_SOROBAN_MAX_INCLUSION_FEE must be a number/,
  );
  assert.throws(
    () => inclusionFeePolicyFromEnv({ PERIHELION_SOROBAN_INCLUSION_FEE_PERCENTILE: "42" }),
    RangeError,
  );
});
