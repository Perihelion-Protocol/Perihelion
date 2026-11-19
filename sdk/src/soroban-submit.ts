// SPDX-License-Identifier: MIT

/**
 * Soroban submission path shared by the relayer and the solver.
 *
 * - {@link quoteInclusionFee} bids a percentile of the network's recent
 *   inclusion fees (from `getFeeStats`), clamped to an operator floor and cap.
 * - {@link submitWithFeeEscalation} submits, and when the transaction expires
 *   or is refused for capacity it resubmits with a higher bid. Every attempt
 *   reuses the same sequence number, so at most one variant can ever apply.
 * - The returned `feeChargedStroops` is read from the ledger result, so callers
 *   report what was actually paid rather than the bid.
 */

import { Account, SorobanRpc, type Transaction } from "@stellar/stellar-sdk";

/** Percentiles of recent inclusion fees that can be bid (names match `getFeeStats`). */
export type InclusionFeePercentile = 50 | 70 | 90 | 95 | 99;

/** Operator policy for Soroban inclusion fees. All amounts are stroops per operation. */
export interface InclusionFeePolicy {
  /** Percentile of recent observed inclusion fees to bid. Default 90. */
  readonly percentile?: InclusionFeePercentile;
  /** Lowest bid. Also the bid when `getFeeStats` is unavailable. Default 10 000 (Stellar's floor is 100). */
  readonly floorStroops?: number;
  /** Highest bid the operator will pay per operation. Default 1 000 000 (0.1 XLM). */
  readonly capStroops?: number;
  /** Multiplier applied to the bid after each expired or refused attempt. Must be > 1. Default 1.5. */
  readonly bumpFactor?: number;
  /** Maximum submission attempts, including the first. Default 4. */
  readonly maxAttempts?: number;
}

/** Defaults used for any {@link InclusionFeePolicy} field left unset. */
export const DEFAULT_INCLUSION_FEE_POLICY: Required<InclusionFeePolicy> = Object.freeze({
  percentile: 90,
  floorStroops: 10_000,
  capStroops: 1_000_000,
  bumpFactor: 1.5,
  maxAttempts: 4,
});

const PERCENTILES: readonly InclusionFeePercentile[] = [50, 70, 90, 95, 99];

/**
 * A submission that did not land in time: refused with `TRY_AGAIN_LATER` after
 * its retries, or not included before it expired. The transaction was never
 * applied, so it is safe to resubmit with the same sequence number.
 */
export class SubmissionExpiredError extends Error {
  readonly hash?: string;

  constructor(message: string, hash?: string) {
    super(message);
    this.name = "SubmissionExpiredError";
    this.hash = hash;
  }
}

/** Resolve a partial policy against the defaults and reject values that cannot work. */
export function resolveInclusionFeePolicy(
  policy: InclusionFeePolicy = {},
): Required<InclusionFeePolicy> {
  const resolved = { ...DEFAULT_INCLUSION_FEE_POLICY, ...stripUndefined(policy) };
  if (!PERCENTILES.includes(resolved.percentile)) {
    throw new RangeError(`inclusion fee percentile must be one of ${PERCENTILES.join(", ")}`);
  }
  if (!Number.isSafeInteger(resolved.floorStroops) || resolved.floorStroops < 100) {
    throw new RangeError("inclusion fee floor must be an integer of at least 100 stroops");
  }
  if (!Number.isSafeInteger(resolved.capStroops) || resolved.capStroops < resolved.floorStroops) {
    throw new RangeError("inclusion fee cap must be an integer no lower than the floor");
  }
  if (!(resolved.bumpFactor > 1)) {
    throw new RangeError("inclusion fee bump factor must be greater than 1");
  }
  if (!Number.isSafeInteger(resolved.maxAttempts) || resolved.maxAttempts < 1) {
    throw new RangeError("maxAttempts must be an integer of at least 1");
  }
  return resolved;
}

function stripUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/**
 * Read the operator's inclusion-fee policy from environment variables:
 * `PERIHELION_SOROBAN_INCLUSION_FEE_PERCENTILE`, `PERIHELION_SOROBAN_MIN_INCLUSION_FEE`
 * and `PERIHELION_SOROBAN_MAX_INCLUSION_FEE` (stroops per operation). Unset or
 * blank variables keep the defaults. Invalid values throw a RangeError.
 */
export function inclusionFeePolicyFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): InclusionFeePolicy {
  const number = (name: string): number | undefined => {
    const raw = env[name]?.trim();
    if (!raw) return undefined;
    const value = Number(raw);
    if (Number.isNaN(value)) throw new RangeError(`${name} must be a number, got "${raw}"`);
    return value;
  };
  const policy: { -readonly [K in keyof InclusionFeePolicy]: InclusionFeePolicy[K] } = {};
  const percentile = number("PERIHELION_SOROBAN_INCLUSION_FEE_PERCENTILE");
  const floorStroops = number("PERIHELION_SOROBAN_MIN_INCLUSION_FEE");
  const capStroops = number("PERIHELION_SOROBAN_MAX_INCLUSION_FEE");
  if (percentile !== undefined) policy.percentile = percentile as InclusionFeePercentile;
  if (floorStroops !== undefined) policy.floorStroops = floorStroops;
  if (capStroops !== undefined) policy.capStroops = capStroops;
  // Validate now so a bad value is reported at startup.
  resolveInclusionFeePolicy(policy);
  return policy;
}

/** Next bid after an expired or refused attempt: multiplied by `bumpFactor` and capped. */
export function escalateInclusionFee(
  currentStroops: number,
  policy: Required<InclusionFeePolicy>,
): number {
  return Math.min(policy.capStroops, Math.ceil(currentStroops * policy.bumpFactor));
}

/**
 * Bid for the next submission from `getFeeStats`. Falls back to the floor when
 * the RPC call fails or reports no usable value, so an outage degrades to the
 * floor instead of blocking delivery.
 */
export async function quoteInclusionFee(
  rpc: SorobanRpc.Server,
  policy: InclusionFeePolicy = {},
  logger?: { warn(message: string, meta?: Record<string, unknown>): void },
): Promise<number> {
  const resolved = resolveInclusionFeePolicy(policy);
  try {
    const stats = await rpc.getFeeStats();
    const key = `p${resolved.percentile}` as "p50" | "p70" | "p90" | "p95" | "p99";
    const observed = Number(stats.sorobanInclusionFee[key]);
    if (!Number.isFinite(observed) || observed <= 0) return resolved.floorStroops;
    return Math.min(resolved.capStroops, Math.max(resolved.floorStroops, Math.ceil(observed)));
  } catch (err) {
    logger?.warn("getFeeStats failed; bidding the inclusion fee floor", {
      floorStroops: resolved.floorStroops,
      err: String(err),
    });
    return resolved.floorStroops;
  }
}

/** Options for {@link submitAndWait} and {@link submitAndWaitForResult}. */
export interface SubmitAndWaitOptions {
  /** Maximum number of `getTransaction` polls (default 20). */
  maxAttempts?: number;
  /** Delay between polls in milliseconds (default 1000). */
  pollIntervalMs?: number;
  /** Maximum number of resubmissions on `TRY_AGAIN_LATER` (default 3). */
  maxResubmits?: number;
  /** Base backoff delay in milliseconds for `TRY_AGAIN_LATER` (default 1000). */
  backoffMs?: number;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The successful `getTransaction` response plus the hash it was looked up by. */
export interface SubmittedTransaction {
  hash: string;
  response: SorobanRpc.Api.GetSuccessfulTransactionResponse;
}

/**
 * Submit a signed transaction and wait for it to be included in a ledger.
 *
 * - `ERROR`: rejected immediately with the decoded `errorResult`.
 * - `TRY_AGAIN_LATER`: back off and resubmit; after `maxResubmits`, throws {@link SubmissionExpiredError}.
 * - `PENDING` / `DUPLICATE`: poll `getTransaction`. `FAILED` throws; no inclusion
 *   within the poll budget throws {@link SubmissionExpiredError}.
 */
export async function submitAndWaitForResult(
  rpc: SorobanRpc.Server,
  transaction: Transaction,
  options: SubmitAndWaitOptions = {},
): Promise<SubmittedTransaction> {
  const maxAttempts = options.maxAttempts ?? 20;
  const pollIntervalMs = options.pollIntervalMs ?? 1000;
  const maxResubmits = options.maxResubmits ?? 3;
  const backoffMs = options.backoffMs ?? 1000;

  let resubmits = 0;
  for (;;) {
    const result = await rpc.sendTransaction(transaction);

    if (result.status === "ERROR") {
      const errorXdr = result.errorResult ? result.errorResult.toXDR("base64") : "unknown error";
      throw new Error(`Transaction rejected by RPC: ${errorXdr}`);
    }

    if (result.status === "TRY_AGAIN_LATER") {
      if (resubmits >= maxResubmits) {
        throw new SubmissionExpiredError(
          `Transaction not accepted after ${resubmits} retries: ${result.hash}`,
          result.hash,
        );
      }
      resubmits += 1;
      await sleep(backoffMs * resubmits);
      continue;
    }

    // PENDING or DUPLICATE: poll for confirmation.
    let attempts = 0;
    while (attempts < maxAttempts) {
      const status = await rpc.getTransaction(result.hash);
      if (status.status === "SUCCESS") {
        return { hash: result.hash, response: status };
      }
      if (status.status === "FAILED") {
        throw new Error(`Transaction failed: ${status.resultXdr}`);
      }
      await sleep(pollIntervalMs);
      attempts += 1;
    }
    throw new SubmissionExpiredError(
      `Transaction confirmation timeout: ${result.hash}`,
      result.hash,
    );
  }
}

/** Submit a signed transaction and resolve to its hash once it succeeds. */
export async function submitAndWait(
  rpc: SorobanRpc.Server,
  transaction: Transaction,
  options: SubmitAndWaitOptions = {},
): Promise<string> {
  return (await submitAndWaitForResult(rpc, transaction, options)).hash;
}

/** Stroops the ledger actually charged for a successful transaction. */
export function feeChargedStroops(
  response: SorobanRpc.Api.GetSuccessfulTransactionResponse,
): bigint {
  return BigInt(response.resultXdr.feeCharged().toString());
}

/** Inputs to {@link submitWithFeeEscalation}. */
export interface SubmitWithEscalationOptions {
  rpc: SorobanRpc.Server;
  /** Strkey of the account that signs the transaction. */
  signerPublicKey: string;
  /**
   * The account's sequence number, read once before the first attempt. Every
   * attempt reuses it, so an expired or refused attempt can never also land.
   */
  sequence: string;
  /**
   * Build, simulate and assemble an unsigned transaction for `account` at the
   * given per-operation inclusion fee. Called once per attempt.
   */
  prepare: (account: Account, inclusionFeeStroops: number) => Promise<Transaction>;
  /** Sign the transaction in place. */
  sign: (transaction: Transaction) => void;
  policy?: InclusionFeePolicy;
  /** Polling and backoff knobs passed to {@link submitAndWaitForResult}. */
  submitOptions?: Omit<SubmitAndWaitOptions, "maxResubmits">;
  logger?: { warn(message: string, meta?: Record<string, unknown>): void };
}

/** Outcome of {@link submitWithFeeEscalation}. */
export interface SubmitWithEscalationResult {
  hash: string;
  /** Attempts made, including the successful one. */
  attempts: number;
  /** Bid carried by the attempt that landed. */
  inclusionFeeStroops: number;
  /** Fee the ledger charged, read from the transaction result. */
  feeChargedStroops: bigint;
}

/**
 * Submit with an escalating inclusion fee.
 *
 * `TRY_AGAIN_LATER` and expiry each trigger a resubmission at a higher bid
 * (see {@link escalateInclusionFee}) with the same sequence number. Before each
 * resubmission, and before rethrowing a non-retryable error, earlier attempts
 * are checked. If one already landed, its result is returned, so a late
 * inclusion is never reported as a failure.
 */
export async function submitWithFeeEscalation(
  options: SubmitWithEscalationOptions,
): Promise<SubmitWithEscalationResult> {
  const policy = resolveInclusionFeePolicy(options.policy);
  const backoffMs = options.submitOptions?.backoffMs ?? 1000;
  const submitted: string[] = [];

  let bid = await quoteInclusionFee(options.rpc, policy, options.logger);
  for (let attempt = 1; ; attempt += 1) {
    try {
      // `prepare` simulates, so it runs inside the try: a simulation that fails
      // after an earlier attempt has landed must not be reported as a failure.
      const account = new Account(options.signerPublicKey, options.sequence);
      const transaction = await options.prepare(account, bid);
      options.sign(transaction);
      submitted.push(transaction.hash().toString("hex"));

      const landed = await submitAndWaitForResult(options.rpc, transaction, {
        ...options.submitOptions,
        maxResubmits: 0, // refusals escalate the fee instead of retrying the same bid
      });
      return {
        hash: landed.hash,
        attempts: attempt,
        inclusionFeeStroops: bid,
        feeChargedStroops: feeChargedStroops(landed.response),
      };
    } catch (err) {
      const earlier = await findLanded(options.rpc, submitted);
      if (earlier) {
        return { ...earlier, attempts: attempt, inclusionFeeStroops: bid };
      }
      if (!(err instanceof SubmissionExpiredError)) throw err;
      if (attempt >= policy.maxAttempts) {
        throw new SubmissionExpiredError(
          `transaction did not land after ${attempt} attempts (last bid ${bid} stroops): ${err.message}`,
          err.hash,
        );
      }
      if (bid >= policy.capStroops) {
        throw new SubmissionExpiredError(
          `transaction did not land and the inclusion fee cap (${policy.capStroops} stroops) is reached: ${err.message}`,
          err.hash,
        );
      }
      const next = escalateInclusionFee(bid, policy);
      options.logger?.warn("resubmitting with a higher inclusion fee", {
        attempt,
        fromStroops: bid,
        toStroops: next,
        reason: err.message,
      });
      bid = next;
      await sleep(backoffMs);
    }
  }
}

async function findLanded(
  rpc: SorobanRpc.Server,
  hashes: readonly string[],
): Promise<{ hash: string; feeChargedStroops: bigint } | undefined> {
  for (const hash of hashes) {
    const status = await rpc.getTransaction(hash);
    if (status.status === "SUCCESS") {
      return { hash, feeChargedStroops: feeChargedStroops(status) };
    }
  }
  return undefined;
}
