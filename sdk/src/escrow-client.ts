// SPDX-License-Identifier: MIT

/**
 * Client for on-chain escrow contract interactions.
 *
 * The SDK constructs, signs, and submits intents to the mempool, but users
 * still need to call escrow functions for critical operations:
 * - `lock()` for a solver to claim an intent: pulls the user's pre-approved
 *   source funds into escrow and dispatches the fill instruction to Stellar
 * - `cancelExpired()` to recover expired intents
 * - `confirmationGrace()` and `getLock()` to verify intent status
 *
 * This client provides type-safe helpers over viem's PublicClient and
 * WalletClient to perform these on-chain actions directly.
 */

import { zeroAddress } from "viem";
import type {
  PublicClient,
  WalletClient,
  Address,
  Chain,
  Account,
} from "viem";
import type { Intent, Hex } from "./types.js";
import { ESCROW_ABI } from "./escrow-abi.js";

/** Lock structure returned by getLock. */
interface Lock {
  solver: Address;
  user: Address;
  asset: Address;
  amount: bigint;
  deadline: bigint;
  released: boolean;
  refunded: boolean;
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
        ? (intent.preferredSolver as Address)
        : (intent.user as Address));

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
   * Retrieve the lock record for an intent.
   *
   * `getLock` is a public mapping getter and does not revert for an unknown
   * hash — it returns a zero-valued struct — so absence is determined from
   * `lock.user` rather than from a caught exception. RPC/transport failures
   * are not caught here and propagate to the caller, since they must not be
   * confused with "no lock exists".
   *
   * @param intentHash The hash of the intent.
   * @returns The lock record, or undefined if no lock exists.
   * @throws If the underlying RPC call fails (network, timeout, etc.).
   */
  async getLock(intentHash: Hex): Promise<Lock | undefined> {
    const lock = (await this.publicClient.readContract({
      address: this.escrowAddress,
      abi: ESCROW_ABI,
      functionName: "getLock",
      args: [intentHash],
    })) as Lock;
    return lock.user === zeroAddress ? undefined : lock;
  }

  /**
   * Read the confirmation grace period (in seconds).
   * Used by {@link PerihelionClient.isRefundable} to determine when
   * an expired intent becomes refundable via {@link cancelExpired}.
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
