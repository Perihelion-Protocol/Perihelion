/**
 * Executor: orchestrates the two settlement legs of a fill.
 *
 * 1. Calls EVM escrow `lock` to lock source funds
 * 2. Calls Soroban `fill_intent` to deliver destination assets
 * 3. Tracks settlement status and handles idempotent retries
 */

import type { SignedIntent } from "@perihelion/sdk";
import { getAddress, type Hex } from "viem";

/** Configuration for executor (keys and RPC endpoints). */
export interface ExecutorConfig {
  /** EVM RPC URL (Ethereum, Base, etc.) */
  readonly evmRpcUrl: string;
  /** Soroban RPC URL */
  readonly sorobanRpcUrl: string;
  /** EVM private key (hex-encoded with 0x prefix) */
  readonly evmPrivateKey: Hex;
  /** Soroban secret key (Stellar strkey) */
  readonly sorobanSecretKey: string;
  /** EVM escrow contract address */
  readonly escrowAddress: `0x${string}`;
  /** Soroban settlement contract ID (hash) */
  readonly settlementContractId: string;
  /** Source chain ID (1=mainnet, 8453=Base, etc.) */
  readonly sourceChainId: number;
}

/** Idempotency check result. */
interface FillStatus {
  filled: boolean;
  settlementTx?: string;
}

/**
 * Execute a fill by orchestrating EVM lock and Soroban fill_intent.
 *
 * Handles idempotent retries: before re-filling, queries current status
 * to avoid double-fills.
 */
export class Executor {
  private readonly evmRpcUrl: string;
  private readonly sorobanRpcUrl: string;
  private readonly evmPrivateKey: Hex;
  private readonly sorobanSecretKey: string;
  private readonly escrowAddress: `0x${string}`;
  private readonly settlementContractId: string;
  private readonly sourceChainId: number;

  constructor(config: ExecutorConfig) {
    this.evmRpcUrl = config.evmRpcUrl;
    this.sorobanRpcUrl = config.sorobanRpcUrl;
    this.evmPrivateKey = config.evmPrivateKey;
    this.sorobanSecretKey = config.sorobanSecretKey;
    this.escrowAddress = config.escrowAddress;
    this.settlementContractId = config.settlementContractId;
    this.sourceChainId = config.sourceChainId;
  }

  /**
   * Fill an intent: lock source funds and deliver destination assets.
   * Idempotent: checks fill status before attempting retry.
   */
  async fill(signed: SignedIntent): Promise<{ settlementTx: string }> {
    const { intent, signature, hash } = signed;

    // Check if already filled (idempotency)
    const status = await this.checkFillStatus(hash);
    if (status.filled && status.settlementTx) {
      return { settlementTx: status.settlementTx };
    }

    // Step 1: Lock on EVM escrow
    const lockTx = await this.lockOnEvm(signed);

    // Step 2: Fill on Soroban (deliver dest asset, dispatch FillConfirmed)
    const settlementTx = await this.fillOnSoroban(signed, lockTx);

    return { settlementTx };
  }

  /**
   * Check if an intent has already been filled (idempotency check).
   * Queries Soroban to see if `is_settled` returns true.
   */
  private async checkFillStatus(intentHash: Hex): Promise<FillStatus> {
    try {
      const settled = await this.isSettled(intentHash);
      if (settled) {
        // If settled, return a marker indicating it's already filled
        // In production, would retrieve the actual settlement tx hash from Soroban
        return { filled: true, settlementTx: intentHash };
      }
    } catch (err) {
      // Query failure is not fatal; proceed with fill attempt
    }
    return { filled: false };
  }

  /**
   * Check if an intent is settled on Soroban (stub for full implementation).
   *
   * In production, this would call the Soroban contract's `is_settled` view function
   * via the Stellar SDK to query the settlement state.
   */
  private async isSettled(_intentHash: Hex): Promise<boolean> {
    // TODO: Implement via Stellar SDK
    // This would call: settlement_contract.is_settled(intent_hash)
    // For now, assume not settled so fills can proceed
    return false;
  }

  /**
   * Lock funds in the EVM escrow contract.
   * Returns the EVM transaction hash.
   *
   * In production, this would use viem to call escrow.lock(intent, signature).
   * The transaction includes the user's source funds locked against intent_hash.
   */
  private async lockOnEvm(signed: SignedIntent): Promise<Hex> {
    const { intent, signature, hash } = signed;

    // TODO: Implement via viem
    // This would construct the Intent struct and call:
    // walletClient.writeContract({
    //   address: this.escrowAddress,
    //   abi: escrowAbi,
    //   functionName: "lock",
    //   args: [intent, signature],
    //   value: layerZeroFee,
    // })

    // For now, return a mock transaction hash
    console.info("locking on EVM escrow", {
      intentHash: hash,
      escrow: this.escrowAddress,
      user: intent.user,
      amount: intent.sourceAmount,
    });

    // In a real implementation, await the lock transaction confirmation
    return hash;
  }

  /**
   * Fill the intent on Soroban: deliver destination assets and dispatch FillConfirmed.
   * Returns the Soroban transaction hash.
   *
   * In production, this would invoke the Soroban settlement contract's fill_intent
   * function, which transfers the destination asset to the user and dispatches
   * a FillConfirmed message to the source chain via LayerZero.
   */
  private async fillOnSoroban(_signed: SignedIntent, lockTx: Hex): Promise<Hex> {
    // TODO: Implement via Stellar SDK
    // This would call: settlement_contract.fill_intent(
    //   solver_address,
    //   solver_evm_bytes32,
    //   intent_hash,
    //   fill_amount,
    //   lz_fee
    // )

    // For now, return a mock transaction hash (same as lock for simplicity)
    console.info("filling on Soroban settlement", {
      lockTx,
    });

    // In a real implementation, await the settlement transaction confirmation
    return lockTx;
  }
}
