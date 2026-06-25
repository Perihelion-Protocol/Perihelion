/**
 * EVM source watcher: polls the EVM escrow for emitted FillConfirmed messages.
 * Decodes the message payload into PendingMessage for relay to Soroban.
 */

import { createPublicClient, http, type PublicClient, type Log } from "viem";
import type { SourceWatcher } from "./relayer.js";
import type { BridgeMessage, PendingMessage, EndpointId } from "./types.js";

/** Configuration for EVMSourceWatcher. */
export interface EVMSourceWatcherConfig {
  /** EVM RPC endpoint URL. */
  rpcUrl: string;
  /** Address of the PerihelionEscrow contract on the source chain. */
  escrowAddress: string;
  /** LayerZero endpoint ID of the source chain (e.g., 30101 for Ethereum). */
  sourceEid: EndpointId;
}

/** Wire-level event signature for escrow's FillConfirmed emission. */
const FILL_CONFIRMED_TOPIC =
  "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef"; // Placeholder; replace with actual

/**
 * Concrete SourceWatcher for EVM: polls an EVM RPC for escrow events and
 * decodes bridge messages.
 */
export class EVMSourceWatcher implements SourceWatcher {
  private client: PublicClient;

  constructor(private config: EVMSourceWatcherConfig) {
    this.client = createPublicClient({
      transport: http(config.rpcUrl),
    });
  }

  async poll(
    fromBlock: number,
  ): Promise<{ messages: PendingMessage[]; head: number }> {
    try {
      // Get current block
      const currentBlock = await this.client.getBlockNumber();

      // Query logs for FillConfirmed events emitted by the escrow
      // NOTE: This is a placeholder. The actual topic and decoding depend on
      // the EVM contract's event signature.
      const logs = await this.client.getLogs({
        address: this.config.escrowAddress as `0x${string}`,
        fromBlock: BigInt(fromBlock),
        toBlock: currentBlock,
        // topics: [FILL_CONFIRMED_TOPIC],
      });

      const messages: PendingMessage[] = [];

      for (const log of logs) {
        try {
          const pending = this.decodeLog(log);
          if (pending) {
            messages.push(pending);
          }
        } catch (err) {
          // Log decode error but continue processing other logs
          console.error("Failed to decode log", { log, err });
        }
      }

      return {
        messages,
        head: Number(currentBlock),
      };
    } catch (err) {
      throw new Error(`Failed to poll EVM logs: ${String(err)}`);
    }
  }

  /**
   * Decode an EVM log into a BridgeMessage.
   * This is a skeleton; actual decoding depends on the escrow contract's ABI.
   */
  private decodeLog(log: Log): PendingMessage | null {
    // Placeholder: in production, use ethers/viem ABIs to decode the escrow event
    // For now, return null to indicate this is a stub.
    return null;
  }
}
