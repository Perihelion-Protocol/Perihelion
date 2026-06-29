/**
 * The Perihelion relayer carries LayerZero messages along the Stellar ↔ EVM
 * path. It watches the source chain for locked-fund commitments, waits for
 * sufficient confirmations, and delivers the verified message to the
 * destination settlement contract.
 *
 * The relayer is **permissionless and trust-minimized**: it only transports
 * messages whose authenticity the destination contract verifies independently
 * (via the LayerZero DVN stack and, where available, Stellar Protocol 24 ZK
 * proofs). A malicious relayer can censor or delay, but cannot forge a delivery.
 */

import type { RelayerConfig } from "./config.js";
import type { PendingMessage, RelayResult } from "./types.js";

/** Observes bridge messages emitted on the source chain. */
export interface SourceWatcher {
  /** Return messages emitted since `fromBlock` (inclusive). */
  poll(fromBlock: number): Promise<{ messages: PendingMessage[]; head: number }>;
}

/** Delivers a verified message to the destination settlement contract. */
export interface DestinationDelivery {
  /** Submit the message; returns the destination tx hash. */
  deliver(pending: PendingMessage): Promise<string>;
  /** True if this message was already delivered (idempotency / replay guard). */
  isDelivered(intentHash: string): Promise<boolean>;
}

export interface Logger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

export class Relayer {
  private running = false;
  private cursor: number;

  constructor(
    private readonly config: RelayerConfig,
    private readonly watcher: SourceWatcher,
    private readonly delivery: DestinationDelivery,
    private readonly log: Logger = console,
    startBlock = 0,
  ) {
    this.cursor = startBlock;
  }

  /** Start the watch-and-relay loop. Resolves when {@link stop} is called. */
  async start(): Promise<void> {
    this.running = true;
    this.log.info("relayer started", {
      escrow: this.config.escrowAddress,
      settlement: this.config.settlementContractId,
    });
    while (this.running) {
      try {
        await this.tick();
      } catch (err) {
        this.log.error("tick failed", { err: String(err) });
      }
      await sleep(this.config.pollIntervalMs);
    }
  }

  stop(): void {
    this.running = false;
  }

  /** One watch-confirm-deliver cycle. Exposed for testing. */
  async tick(): Promise<RelayResult[]> {
    const { messages, head } = await this.watcher.poll(this.cursor);
    const confirmedHead = head - this.config.confirmations;
    const results: RelayResult[] = [];

    // Only advance the cursor past blocks that were fully handled (delivered,
    // or already-delivered per the idempotency check). A delivery failure
    // caps the cursor at that block so it's retried next tick.
    let cursorTarget = confirmedHead + 1;

    for (const pending of messages) {
      if (pending.srcBlock > confirmedHead) continue; // not yet final
      const result = await this.relayOne(pending);
      results.push(result);
      if (result.error !== undefined) {
        cursorTarget = Math.min(cursorTarget, pending.srcBlock);
      }
    }

    this.cursor = Math.max(this.cursor, cursorTarget);
    return results;
  }

  private async relayOne(pending: PendingMessage): Promise<RelayResult> {
    const { intentHash } = pending.message;
    try {
      if (await this.delivery.isDelivered(intentHash)) {
        this.log.info("already delivered, skipping", { intentHash });
        return { intentHash, delivered: false };
      }
      const dstTxHash = await this.delivery.deliver(pending);
      this.log.info("delivered", { intentHash, dstTxHash });
      return { intentHash, delivered: true, dstTxHash };
    } catch (err) {
      this.log.error("delivery failed", { intentHash, err: String(err) });
      return { intentHash, delivered: false, error: String(err) };
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
