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
  /**
   * Return messages emitted since `fromBlock` (inclusive). `head` must be the
   * source chain's latest block height — it may be smaller than the
   * configured confirmation depth (e.g. a fresh local/test chain), which
   * {@link Relayer.tick} handles by relaying nothing that tick.
   */
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
    const results: RelayResult[] = [];

    // `head` is assumed to be the source chain's latest block height. If the
    // chain has fewer blocks than the required confirmation depth (a fresh
    // local/test network, or a watcher reporting a small head), nothing can
    // be final yet — bail out before the subtraction below goes negative.
    if (head < this.config.confirmations) return results;

    const confirmedHead = Math.max(0, head - this.config.confirmations);

    for (const pending of messages) {
      if (pending.srcBlock > confirmedHead) continue; // not yet final
      results.push(await this.relayOne(pending));
    }

    // Advance the cursor past everything we've now confirmed.
    this.cursor = Math.max(this.cursor, confirmedHead + 1);
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
