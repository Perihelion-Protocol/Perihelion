/**
 * Soroban destination delivery: submits verified LayerZero messages to the
 * Stellar settlement contract, restoring archived entries as needed.
 */

import {
  SorobanRpc,
  TransactionBuilder,
  type Account,
} from "@stellar/stellar-sdk";
import type { DestinationDelivery } from "./relayer.js";
import type { PendingMessage } from "./types.js";

/** Configuration for SorobanDestinationDelivery. */
export interface SorobanDeliveryConfig {
  /** Soroban RPC endpoint URL. */
  rpcUrl: string;
  /** Stellar network passphrase (e.g., "Test SDF Network ; September 2015"). */
  networkPassphrase: string;
  /** ID of the settlement contract on Soroban. */
  settlementContractId: string;
  /** Signer keypair or secret key for submitting transactions. */
  signerSecret: string;
}

/**
 * Concrete DestinationDelivery for Soroban: submits lz_receive calls to the
 * settlement contract, prepending RestoreFootprint ops for archived entries.
 */
export class SorobanDestinationDelivery implements DestinationDelivery {
  private rpc: SorobanRpc.Server;
  private networkPassphrase: string;
  private settlementContractId: string;
  private signerSecret: string;

  constructor(private config: SorobanDeliveryConfig) {
    this.rpc = new SorobanRpc.Server(config.rpcUrl);
    this.networkPassphrase = config.networkPassphrase;
    this.settlementContractId = config.settlementContractId;
    this.signerSecret = config.signerSecret;
  }

  async deliver(pending: PendingMessage): Promise<string> {
    try {
      // 1. Check if the settlement contract entry is archived
      const isArchived = await this.isEntryArchived();

      // 2. Get signer account to build transaction
      const keypair = await this.getSignerAccount();

      // 3. Build transaction
      let builder = new TransactionBuilder(keypair, {
        fee: "10000", // Placeholder fee (Soroban uses dynamic pricing)
        networkPassphrase: this.networkPassphrase,
      });

      // 4. If archived, prepend RestoreFootprint operation
      if (isArchived) {
        builder = await this.prependRestoreFootprint(builder);
      }

      // 5. Append lz_receive invocation
      builder = await this.appendLzReceiveCall(builder, pending);

      const transaction = builder.build();

      // 6. Submit and return tx hash
      const result = await this.rpc.sendTransaction(transaction);
      return result.hash;
    } catch (err) {
      throw new Error(`Failed to deliver to Soroban: ${String(err)}`);
    }
  }

  async isDelivered(intentHash: string): Promise<boolean> {
    try {
      // Query the settlement contract to check if this intent was already settled
      // via the is_settled view or by checking the Settled marker in storage.
      // Placeholder: return false for now.
      return false;
    } catch (err) {
      console.error("Failed to check if delivered", { intentHash, err });
      return false;
    }
  }

  private async isEntryArchived(): Promise<boolean> {
    // Check if the settlement contract's ledger entry is archived (TTL < threshold).
    // Placeholder: return false for now.
    return false;
  }

  private async getSignerAccount(): Promise<Account> {
    // Load the signer's account from the network to get sequence number.
    // Placeholder: stub.
    throw new Error("Not implemented");
  }

  private async prependRestoreFootprint(
    builder: TransactionBuilder,
  ): Promise<TransactionBuilder> {
    // Prepend a RestoreFootprint op to restore the archived settlement contract entry.
    // Placeholder: return builder unchanged.
    return builder;
  }

  private async appendLzReceiveCall(
    builder: TransactionBuilder,
    pending: PendingMessage,
  ): Promise<TransactionBuilder> {
    // Append the lz_receive contract invocation.
    // Placeholder: return builder unchanged.
    return builder;
  }
}
