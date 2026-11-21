// SPDX-License-Identifier: MIT

/**
 * Client for on-chain escrow contract interactions.
 *
 * The SDK constructs, signs, and submits intents to the mempool, but users
 * still need to call escrow functions for critical operations:
 * - `lock()` for a solver to claim an intent: pulls the user's pre-approved
 *   source funds into escrow and dispatches the fill instruction to Stellar
 * - `cancelExpired()` to recover expired intents
 * - `confirmationGrace()` and `getLock()` (over the `locks` mapping getter)
 *   to verify intent status
 * - `isRefundable()` / `refundStatus()` to check, from chain state, whether
 *   `cancelExpired()` would currently succeed
 *
 * This client provides type-safe helpers over viem's PublicClient and
 * WalletClient to perform these on-chain actions directly.
 */

import { zeroAddress } from "viem";
import type { PublicClient, WalletClient, Address } from "viem";
import type { Intent, Hex } from "./types.js";
import { ESCROW_ABI } from "./escrow-abi.js";
import { evaluateEvmCancelCostGuard } from "./keeper.js";

const LOCKED_EVENT_ABI = {
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

/**
 * Lock record returned by {@link PerihelionEscrowClient.getLock}. Mirrors
 * `PerihelionEscrow.Lock` (`minDestAmount` is a uint128 and `deadline` a
 * uint64 on-chain; both are surfaced as bigint).
 */
export interface Lock {
  solver: Address;
  user: Address;
  asset: Address;
  amount: bigint;
  minDestAmount: bigint;
  deadline: bigint;
  released: boolean;
  refunded: boolean;
}

/**
 * Why `cancelExpired` would revert right now, named after the contract error it
 * would revert with.
 */
export type RefundBlocker = "NotLocked" | "AlreadyFinalized" | "DeadlineNotPassed";

/** Result of {@link PerihelionEscrowClient.refundStatus}. */
export interface RefundStatus {
  /** `true` if `cancelExpired(intentHash)` passes all of its checks at `blockNumber`. */
  refundable: boolean;
  /** When not refundable, the error `cancelExpired` would revert with. */
  reason?: RefundBlocker;
  /** The on-chain lock record, if one exists. */
  lock?: Lock;
  /**
   * Unix time (seconds) from which the lock is refundable: `deadline +
   * confirmationGrace`. Present whenever a lock exists.
   */
  refundableAt?: bigint;
  /** Block the state was read at; every value above is from this one block. */
  blockNumber: bigint;
  /** Timestamp of `blockNumber`, compared against `refundableAt`. */
  blockTimestamp: bigint;
}

/** An expired, unfinalized lock discovered by {@link PerihelionEscrowClient.findExpiredLocks}. */
export interface ExpiredLock {
  readonly intentHash: Hex;
  readonly lock: Lock;
  readonly refundableAt: bigint;
  readonly lockedAtBlock: bigint;
  readonly lockedTxHash?: Hex;
  readonly evaluatedAtBlock: bigint;
  readonly evaluatedAtTimestamp: bigint;
}

/** Options for {@link PerihelionEscrowClient.findExpiredLocks}. */
export interface FindExpiredLocksOptions {
  /** Starting block number (inclusive). Defaults to 0n. */
  readonly fromBlock?: bigint;
  /** Ending block number (inclusive). Defaults to the latest block. */
  readonly toBlock?: bigint;
  /** Optional filter by user address (indexed topic on Locked). */
  readonly user?: Address;
  /** Optional filter by solver address (indexed topic on Locked). */
  readonly solver?: Address;
  /** Maximum block span per eth_getLogs request. Defaults to 2000. */
  readonly maxBlockRange?: number;
}

/** Options for {@link PerihelionEscrowClient.cancelExpiredLocks}. */
export interface CancelExpiredLocksOptions extends FindExpiredLocksOptions {
  /** When true, finds and evaluates expired locks without sending transactions. */
  readonly dryRun?: boolean;
  /** Optional maximum gas price (in wei) the caller is willing to pay. */
  readonly maxGasPriceWei?: bigint;
  /** Optional maximum total native gas cost (gas * gasPrice in wei) per cancel call. */
  readonly maxCancelCostWei?: bigint;
}

/** Result of {@link PerihelionEscrowClient.cancelExpiredLocks}. */
export interface CancelExpiredLocksResult {
  readonly found: ExpiredLock[];
  readonly cancelled: Array<{ intentHash: Hex; txHash: Hex; gasCostWei?: bigint }>;
  readonly skipped: Array<{ intentHash: Hex; reason: string }>;
}

/**
 * Client for interacting with the PerihelionEscrow contract.
 *
 * Requires a viem PublicClient for read operations and a WalletClient
 * for write operations (signing transactions).
 */
export class PerihelionEscrowClient {
  constructor(
    private readonly publicClient: PublicClient,
    private readonly walletClient: WalletClient,
    private readonly escrowAddress: Address,
  ) {}

  /**
   * Quote the native fee (in wei) for locking an intent as a solver.
   * Add a small buffer and pass the result as `msg.value` to {@link lock}.
   *
   * @param intent The intent to quote a fee for.
   * @param payer Optional solver/payer address. Defaults to wallet client account or preferredSolver.
   * @returns The estimated native token fee in wei.
   */
  async quoteFee(intent: Intent, payer?: Address): Promise<bigint> {
    const solverAddress =
      payer ??
      this.walletClient.account?.address ??
      (intent.preferredSolver !== "0x0000000000000000000000000000000000000000"
        ? intent.preferredSolver
        : intent.user);

    const fee = await this.publicClient.readContract({
      address: this.escrowAddress,
      abi: ESCROW_ABI,
      functionName: "quoteFee",
      args: [this._intentToContract(intent), solverAddress],
    });
    return fee;
  }

  /**
   * Claim an intent as a solver.
   *
   * Transfers the user's pre-approved `sourceAmount` of `sourceAsset` from
   * the user into escrow (not the solver's own funds) and dispatches the
   * FillInstruction to Stellar over LayerZero. The user must have granted
   * this contract an ERC-20 allowance of at least `sourceAmount` before this
   * call, or the transaction reverts.
   *
   * @param intent The intent being locked (must match the signed version).
   * @param signature The EIP-712 signature authorizing the intent.
   * @param value The native token amount funding the LayerZero send — see
   *   {@link quoteFee}. The escrow itself charges no native fee; any excess
   *   over the actual LayerZero cost is refunded by the endpoint to the caller.
   * @returns The transaction hash.
   */
  async lock(intent: Intent, signature: Hex, value: bigint): Promise<Hex> {
    const account = this.walletClient.account;
    if (!account) throw new Error("wallet client has no account");

    const hash = await this.walletClient.writeContract({
      account,
      chain: this.walletClient.chain,
      address: this.escrowAddress,
      abi: ESCROW_ABI,
      functionName: "lock",
      args: [this._intentToContract(intent), signature],
      value,
    });
    return hash;
  }

  /**
   * Call the local refund fallback for an expired intent.
   * Only callable after `deadline + confirmationGrace` has elapsed.
   *
   * @param intentHash The hash of the expired intent.
   * @returns The transaction hash.
   */
  async cancelExpired(intentHash: Hex): Promise<Hex> {
    const account = this.walletClient.account;
    if (!account) throw new Error("wallet client has no account");

    const hash = await this.walletClient.writeContract({
      account,
      chain: this.walletClient.chain,
      address: this.escrowAddress,
      abi: ESCROW_ABI,
      functionName: "cancelExpired",
      args: [intentHash],
    });
    return hash;
  }

  /**
   * Revoke one of your own signed intents before a solver locks it (#1053).
   *
   * Sent by the intent's user (the wallet client's account must be the signer).
   * Once confirmed, `lock` for this intent reverts with `IntentCancelled`. The call
   * is not pausable and is idempotent. It reverts with `AlreadyLocked` if a solver
   * has already locked the intent.
   *
   * @param intentHash The EIP-712 hash of the intent (see `hashIntent`).
   * @returns The transaction hash.
   */
  async cancelIntent(intentHash: Hex): Promise<Hex> {
    const account = this.walletClient.account;
    if (!account) throw new Error("wallet client has no account");

    const hash = await this.walletClient.writeContract({
      account,
      chain: this.walletClient.chain,
      address: this.escrowAddress,
      abi: ESCROW_ABI,
      functionName: "cancelIntent",
      args: [intentHash],
    });
    return hash;
  }

  /**
   * Retrieve the lock record for an intent.
   *
   * Wraps the contract's public `locks(bytes32)` mapping getter, which does
   * not revert for an unknown hash — it returns a zero-valued struct — so
   * absence is determined from `user` rather than from a caught exception.
   * RPC/transport failures are not caught here and propagate to the caller,
   * since they must not be confused with "no lock exists".
   *
   * @param intentHash The hash of the intent.
   * @returns The lock record, or undefined if no lock exists.
   * @throws If the underlying RPC call fails (network, timeout, etc.).
   */
  async getLock(intentHash: Hex): Promise<Lock | undefined> {
    return this._readLock(intentHash);
  }

  /**
   * Check, from chain state, whether `cancelExpired(intentHash)` would succeed.
   *
   * This is the authoritative refundability check. Unlike
   * {@link PerihelionClient.isRefundable}, it does not trust the mempool's
   * best-effort status reports.
   *
   * See {@link refundStatus} for the exact semantics and for the reason a
   * lock is not refundable.
   *
   * @param intentHash The hash of the intent.
   * @returns `true` if `cancelExpired` passes all of its checks at the latest block.
   * @throws If the underlying RPC call fails (network, timeout, etc.).
   */
  async isRefundable(intentHash: Hex): Promise<boolean> {
    return (await this.refundStatus(intentHash)).refundable;
  }

  /**
   * Evaluate `cancelExpired`'s checks against the escrow's state at the latest
   * block, in the contract's order:
   *
   * 1. a lock exists (`NotLocked`),
   * 2. it is neither released nor refunded (`AlreadyFinalized`),
   * 3. `block.timestamp >= deadline + confirmationGrace` (`DeadlineNotPassed`).
   *
   * The lock, the grace period and the timestamp are all read at the same
   * block, so the verdict cannot mix state from different blocks.
   * `cancelExpired` is not pause-gated, so pausing does not affect the result.
   *
   * A transaction lands in a later block than the one read here, with a
   * timestamp at least as high, so a `refundable: true` verdict stays true
   * unless another transaction finalizes the lock first. Near the boundary
   * the check is conservative: it can report `DeadlineNotPassed` for a call
   * that would succeed one block later. It does not predict a revert from
   * the asset token itself (`TransferFailed`).
   *
   * @param intentHash The hash of the intent.
   * @returns The verdict, the reason when not refundable, and the state it was based on.
   * @throws If the underlying RPC call fails (network, timeout, etc.).
   */
  async refundStatus(intentHash: Hex): Promise<RefundStatus> {
    const block = await this.publicClient.getBlock({ blockTag: "latest" });
    const blockNumber = block.number;
    const blockTimestamp = block.timestamp;
    const [lock, grace] = await Promise.all([
      this._readLock(intentHash, blockNumber),
      this.publicClient.readContract({
        address: this.escrowAddress,
        abi: ESCROW_ABI,
        functionName: "confirmationGrace",
        blockNumber,
      }),
    ]);

    if (!lock) {
      return { refundable: false, reason: "NotLocked", blockNumber, blockTimestamp };
    }
    const refundableAt = lock.deadline + grace;
    const base = { lock, refundableAt, blockNumber, blockTimestamp };
    if (lock.released || lock.refunded) {
      return { refundable: false, reason: "AlreadyFinalized", ...base };
    }
    if (blockTimestamp < refundableAt) {
      return { refundable: false, reason: "DeadlineNotPassed", ...base };
    }
    return { refundable: true, ...base };
  }

  /**
   * Read the confirmation grace period (in seconds): how long after an
   * intent's deadline {@link cancelExpired} becomes callable.
   *
   * @returns The grace period in seconds.
   */
  async confirmationGrace(): Promise<bigint> {
    const grace = await this.publicClient.readContract({
      address: this.escrowAddress,
      abi: ESCROW_ABI,
      functionName: "confirmationGrace",
    });
    return grace;
  }

  /**
   * Scan on-chain `Locked` events and return all locks that are currently
   * unfinalized and past `deadline + confirmationGrace` at the evaluated block.
   *
   * Every contract read (`confirmationGrace()` and `locks(intentHash)`) is
   * pinned to the same block whose timestamp is evaluated, matching
   * {@link refundStatus}.
   */
  async findExpiredLocks(opts: FindExpiredLocksOptions = {}): Promise<ExpiredLock[]> {
    const block =
      opts.toBlock !== undefined
        ? await this.publicClient.getBlock({ blockNumber: opts.toBlock })
        : await this.publicClient.getBlock({ blockTag: "latest" });
    const evaluatedAtBlock = block.number;
    const evaluatedAtTimestamp = block.timestamp;

    const fromBlock = opts.fromBlock ?? 0n;
    const toBlock = opts.toBlock ?? evaluatedAtBlock;
    if (fromBlock > toBlock) return [];

    const grace = await this.publicClient.readContract({
      address: this.escrowAddress,
      abi: ESCROW_ABI,
      functionName: "confirmationGrace",
      blockNumber: evaluatedAtBlock,
    });

    let maxRange = BigInt(Math.max(1, opts.maxBlockRange ?? 2000));
    const candidates = new Map<
      Hex,
      { lockedAtBlock: bigint; lockedTxHash?: Hex; eventDeadline?: bigint }
    >();

    let cursor = fromBlock;
    while (cursor <= toBlock) {
      const chunkEnd = cursor + maxRange - 1n < toBlock ? cursor + maxRange - 1n : toBlock;
      let logs;
      try {
        const filterArgs: { user?: Address; solver?: Address } = {};
        if (opts.user) filterArgs.user = opts.user;
        if (opts.solver) filterArgs.solver = opts.solver;

        logs = await this.publicClient.getLogs({
          address: this.escrowAddress,
          event: LOCKED_EVENT_ABI,
          ...(Object.keys(filterArgs).length > 0 ? { args: filterArgs } : {}),
          fromBlock: cursor,
          toBlock: chunkEnd,
        });
      } catch (err) {
        if (this._isProviderRangeError(err) && maxRange > 1n) {
          maxRange = maxRange / 2n;
          if (maxRange < 1n) maxRange = 1n;
          continue;
        }
        throw err;
      }

      for (const log of logs) {
        const rawHash =
          (log as { args?: { intentHash?: Hex } }).args?.intentHash ?? log.topics?.[1];
        if (!rawHash || !/^0x[0-9a-fA-F]{64}$/.test(rawHash)) continue;
        const intentHash = rawHash.toLowerCase() as Hex;

        const rawDeadline = (log as { args?: { deadline?: bigint | number } }).args?.deadline;
        const eventDeadline = rawDeadline !== undefined ? BigInt(rawDeadline) : undefined;

        // Pre-filter by event deadline when available to avoid redundant eth_call reads.
        if (eventDeadline !== undefined && eventDeadline + grace > evaluatedAtTimestamp) {
          continue;
        }

        if (!candidates.has(intentHash)) {
          candidates.set(intentHash, {
            lockedAtBlock: log.blockNumber ?? 0n,
            ...(log.transactionHash ? { lockedTxHash: log.transactionHash } : {}),
            ...(eventDeadline !== undefined ? { eventDeadline } : {}),
          });
        }
      }

      cursor = chunkEnd + 1n;
    }

    const expired: ExpiredLock[] = [];
    for (const [intentHash, meta] of candidates) {
      const lock = await this._readLock(intentHash, evaluatedAtBlock);
      if (!lock) continue;
      if (lock.released || lock.refunded) continue;
      if (opts.user && lock.user.toLowerCase() !== opts.user.toLowerCase()) continue;
      if (opts.solver && lock.solver.toLowerCase() !== opts.solver.toLowerCase()) continue;

      const refundableAt = lock.deadline + grace;
      if (evaluatedAtTimestamp < refundableAt) continue;

      expired.push({
        intentHash,
        lock,
        refundableAt,
        lockedAtBlock: meta.lockedAtBlock,
        ...(meta.lockedTxHash ? { lockedTxHash: meta.lockedTxHash } : {}),
        evaluatedAtBlock,
        evaluatedAtTimestamp,
      });
    }

    return expired;
  }

  /**
   * Discover expired locks via {@link findExpiredLocks} and invoke
   * {@link cancelExpired} for each one that passes optional dry-run and
   * gas-price / gas-cost guards.
   */
  async cancelExpiredLocks(
    opts: CancelExpiredLocksOptions = {},
  ): Promise<CancelExpiredLocksResult> {
    const found = await this.findExpiredLocks(opts);
    const cancelled: Array<{ intentHash: Hex; txHash: Hex; gasCostWei?: bigint }> = [];
    const skipped: Array<{ intentHash: Hex; reason: string }> = [];

    if (found.length === 0) {
      return { found, cancelled, skipped };
    }

    if (opts.dryRun) {
      for (const item of found) {
        skipped.push({ intentHash: item.intentHash, reason: "dry_run" });
      }
      return { found, cancelled, skipped };
    }

    const account = this.walletClient.account;
    if (!account) throw new Error("wallet client has no account");

    const hasGasGuards = opts.maxGasPriceWei !== undefined || opts.maxCancelCostWei !== undefined;
    let gasPriceWei: bigint | undefined;
    if (hasGasGuards) {
      gasPriceWei = await this.publicClient.getGasPrice();
    }

    for (const item of found) {
      let estimatedCostWei: bigint | undefined;
      if (hasGasGuards && gasPriceWei !== undefined) {
        if (opts.maxGasPriceWei !== undefined && gasPriceWei > opts.maxGasPriceWei) {
          skipped.push({
            intentHash: item.intentHash,
            reason: "gas_price_exceeds_cap",
          });
          continue;
        }
        const estimatedGas = await this._estimateCancelGas(item.intentHash);
        const decision = evaluateEvmCancelCostGuard({
          gasPriceWei,
          estimatedGas,
          maxGasPriceWei: opts.maxGasPriceWei,
          maxCancelCostWei: opts.maxCancelCostWei,
        });
        if (!decision.allowed) {
          skipped.push({
            intentHash: item.intentHash,
            reason: decision.reason ?? "cancel_cost_exceeds_cap",
          });
          continue;
        }
        estimatedCostWei = decision.totalCostWei;
      }

      const txHash = await this.cancelExpired(item.intentHash);
      cancelled.push({
        intentHash: item.intentHash,
        txHash,
        ...(estimatedCostWei !== undefined ? { gasCostWei: estimatedCostWei } : {}),
      });
    }

    return { found, cancelled, skipped };
  }

  private async _estimateCancelGas(intentHash: Hex): Promise<bigint> {
    try {
      return await this.publicClient.estimateContractGas({
        address: this.escrowAddress,
        abi: ESCROW_ABI,
        functionName: "cancelExpired",
        args: [intentHash],
        account: this.walletClient.account,
      });
    } catch {
      return 100_000n;
    }
  }

  private _isProviderRangeError(err: unknown): boolean {
    if (!(err instanceof Error)) return false;
    const msg = err.message.toLowerCase();
    return msg.includes("range") || msg.includes("too large") || msg.includes("limit");
  }

  // Read locks(intentHash), optionally at a pinned block; undefined if no lock exists.
  private async _readLock(intentHash: Hex, blockNumber?: bigint): Promise<Lock | undefined> {
    const [solver, user, asset, amount, minDestAmount, deadline, released, refunded] =
      await this.publicClient.readContract({
        address: this.escrowAddress,
        abi: ESCROW_ABI,
        functionName: "locks",
        args: [intentHash],
        blockNumber,
      });
    if (user === zeroAddress) return undefined;
    return {
      solver,
      user,
      asset,
      amount,
      minDestAmount,
      deadline,
      released,
      refunded,
    };
  }

  // Convert SDK intent to contract tuple format.
  private _intentToContract(intent: Intent) {
    return {
      user: intent.user,
      destination: intent.destination,
      sourceChainId: BigInt(intent.sourceChainId),
      sourceAsset: intent.sourceAsset,
      sourceAmount: BigInt(intent.sourceAmount),
      destAsset: intent.destAsset,
      minDestAmount: BigInt(intent.minDestAmount),
      deadline: BigInt(intent.deadline),
      nonce: BigInt(intent.nonce),
      preferredSolver: intent.preferredSolver,
    };
  }
}
