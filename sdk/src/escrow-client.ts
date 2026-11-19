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
import type {
  PublicClient,
  WalletClient,
  Address,
} from "viem";
import type { Intent, Hex } from "./types.js";
import { ESCROW_ABI } from "./escrow-abi.js";

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
        ? (intent.preferredSolver)
        : (intent.user));

    const fee = await this.publicClient.readContract({
      address: this.escrowAddress,
      abi: ESCROW_ABI,
      functionName: "quoteFee",
      args: [this._intentToContract(intent), solverAddress],
    });
    return fee as bigint;
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
  async lock(
    intent: Intent,
    signature: Hex,
    value: bigint,
  ): Promise<Hex> {
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
    return grace as bigint;
  }

  // Read locks(intentHash), optionally at a pinned block; undefined if no lock exists.
  private async _readLock(intentHash: Hex, blockNumber?: bigint): Promise<Lock | undefined> {
    const [
      solver,
      user,
      asset,
      amount,
      minDestAmount,
      deadline,
      released,
      refunded,
    ] = await this.publicClient.readContract({
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
