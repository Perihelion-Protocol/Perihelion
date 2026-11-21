// SPDX-License-Identifier: MIT
// solver/src/released-watcher.ts
//
// Watches the source-chain (EVM) PerihelionEscrow contract for `Released`
// events and reports the corresponding intent as `settled` to the mempool.
//
// This is the *only* component that should transition an intent to the
// terminal `settled` status. The solver itself reports `filled` once it has
// delivered on Stellar; `settled` is reserved for the point at which the
// source chain has actually released the escrowed funds (or the intent has
// otherwise been finalised on-chain).

import { createHash } from "node:crypto";

import type { Hex, MempoolIntentStatus, PerihelionClient } from "@perihelion/sdk";

/**
 * Minimal logger interface. Compatible with the solver's existing logger.
 */
export interface ReleasedWatcherLogger {
  debug?: (msg: string, meta?: Record<string, unknown>) => void;
  info?: (msg: string, meta?: Record<string, unknown>) => void;
  warn?: (msg: string, meta?: Record<string, unknown>) => void;
  error?: (msg: string, meta?: Record<string, unknown>) => void;
}

/**
 * A single `Released` event observed on the escrow contract.
 */
export interface ReleasedEvent {
  /** The intent hash (bytes32, hex-encoded with 0x prefix). */
  intentHash: Hex;
  /** The block number in which the event was emitted. */
  blockNumber: number;
  /** The transaction hash that emitted the event. */
  transactionHash: string;
  /** The log index of the event within the transaction. */
  logIndex: number;
}

/**
 * Abstraction over the escrow contract used to fetch `Released` events.
 *
 * Implementations may wrap an ethers `Contract`, a viem client, or any other
 * EVM client. The watcher only needs the ability to query a block range for
 * `Released` events and to learn the current head block.
 */
export interface EscrowReleasedSource {
  /** Returns the current head block number. */
  getBlockNumber(): Promise<number>;
  /**
   * Returns all `Released` events emitted between `fromBlock` and `toBlock`
   * (inclusive), ordered by block number and log index.
   */
  getReleasedEvents(
    fromBlock: number,
    toBlock: number,
  ): Promise<ReleasedEvent[]>;
}

export interface ReleasedWatcherOptions {
  /** The escrow event source. */
  source: EscrowReleasedSource;
  /** The mempool client used to report status transitions. */
  client: PerihelionClient;
  /** The mempool's shared status token, required to call `reportStatus`. */
  statusToken: string;
  /** Optional logger. */
  logger?: ReleasedWatcherLogger;
  /**
   * The block from which to start scanning on first run. Defaults to the
   * current head block (i.e. only watch events emitted from now on).
   */
  startBlock?: number;
  /**
   * Maximum number of blocks to scan per poll. Defaults to 2_000.
   */
  maxBlockRange?: number;
  /**
   * Interval between polls when the watcher is caught up, in milliseconds.
   * Defaults to 5_000.
   */
  pollIntervalMs?: number;
  /**
   * Initial backoff delay after an error, in milliseconds. Defaults to 1_000.
   */
  initialBackoffMs?: number;
  /**
   * Maximum backoff delay after repeated errors, in milliseconds.
   * Defaults to 60_000.
   */
  maxBackoffMs?: number;
  /**
   * Optional callback invoked after an intent has been reported as settled.
   * Useful for tests and for wiring additional side effects.
   */
  onSettled?: (intentHash: string, event: ReleasedEvent) => void | Promise<void>;
}

/**
 * Polls the escrow contract for `Released` events and reports each observed
 * intent as `settled` to the mempool.
 *
 * The watcher is resilient to transient RPC and mempool failures: it retries
 * with exponential backoff and only advances its cursor past a block range
 * once every event in that range has been successfully reported (or has been
 * determined to be a duplicate / already-settled intent).
 */
export class ReleasedWatcher {
  private readonly source: EscrowReleasedSource;
  private readonly client: PerihelionClient;
  private readonly statusToken: string;
  private readonly logger: ReleasedWatcherLogger;
  private readonly maxBlockRange: number;
  private readonly pollIntervalMs: number;
  private readonly initialBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly onSettled?: (
    intentHash: string,
    event: ReleasedEvent,
  ) => void | Promise<void>;

  /** Next block to scan from (inclusive). */
  private nextBlock: number | undefined;
  /** Set of intent hashes already reported as settled (lowercased). */
  private readonly reported = new Set<string>();

  private running = false;
  private stopped = false;
  private loopPromise: Promise<void> | undefined;
  private wakeUp: (() => void) | undefined;

  constructor(options: ReleasedWatcherOptions) {
    this.source = options.source;
    this.client = options.client;
    this.statusToken = options.statusToken;
    this.logger = options.logger ?? {};
    this.maxBlockRange = options.maxBlockRange ?? 2_000;
    this.pollIntervalMs = options.pollIntervalMs ?? 5_000;
    this.initialBackoffMs = options.initialBackoffMs ?? 1_000;
    this.maxBackoffMs = options.maxBackoffMs ?? 60_000;
    this.onSettled = options.onSettled;
    this.nextBlock = options.startBlock;
  }

  /**
   * Starts the watcher loop. Resolves once the loop has been scheduled; the
   * loop itself runs in the background until {@link stop} is called.
   */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.stopped = false;
    this.loopPromise = this.run();
  }

  /**
   * Stops the watcher loop and waits for the in-flight iteration to finish.
   */
  async stop(): Promise<void> {
    if (!this.running) return;
    this.stopped = true;
    this.wakeUp?.();
    try {
      await this.loopPromise;
    } finally {
      this.running = false;
      this.loopPromise = undefined;
    }
  }

  /**
   * Runs a single scan iteration. Exposed for tests and for callers that want
   * to drive the watcher manually rather than via {@link start}.
   *
   * Returns the number of intents reported as settled during this iteration.
   */
  async pollOnce(): Promise<number> {
    const head = await this.source.getBlockNumber();

    if (this.nextBlock === undefined) {
      // First run: start from the current head so we do not replay history.
      this.nextBlock = head;
      this.logger.info?.("released-watcher: initialised", {
        startBlock: head,
      });
      return 0;
    }

    if (this.nextBlock > head) {
      return 0;
    }

    let settledCount = 0;
    let from = this.nextBlock;

    while (from <= head && !this.stopped) {
      const to = Math.min(from + this.maxBlockRange - 1, head);
      const events = await this.source.getReleasedEvents(from, to);

      // Process in deterministic order.
      events.sort((a, b) => {
        if (a.blockNumber !== b.blockNumber) {
          return a.blockNumber - b.blockNumber;
        }
        return a.logIndex - b.logIndex;
      });

      for (const event of events) {
        if (this.stopped) break;
        const reported = await this.handleEvent(event);
        if (reported) settledCount += 1;
      }

      // Only advance the cursor once the whole range has been processed.
      from = to + 1;
      this.nextBlock = from;
    }

    return settledCount;
  }

  private async handleEvent(event: ReleasedEvent): Promise<boolean> {
    const key = event.intentHash.toLowerCase();

    if (this.reported.has(key)) {
      this.logger.debug?.("released-watcher: already reported", {
        intentHash: event.intentHash,
      });
      return false;
    }

    try {
      await this.client.reportStatus(
        event.intentHash,
        "settled" satisfies MempoolIntentStatus,
        this.statusToken,
      );
      this.reported.add(key);
      this.logger.info?.("released-watcher: reported settled", {
        intentHash: event.intentHash,
        blockNumber: event.blockNumber,
        transactionHash: event.transactionHash,
      });
      try {
        await this.onSettled?.(event.intentHash, event);
      } catch (err) {
        this.logger.warn?.("released-watcher: onSettled callback failed", {
          intentHash: event.intentHash,
          error: describeError(err),
        });
      }
      return true;
    } catch (err) {
      // If the mempool already considers the intent settled (or otherwise
      // terminal), treat it as done so we do not retry forever.
      if (isAlreadySettledError(err)) {
        this.reported.add(key);
        this.logger.debug?.("released-watcher: intent already settled", {
          intentHash: event.intentHash,
        });
        return false;
      }

      this.logger.warn?.("released-watcher: failed to report settled", {
        intentHash: event.intentHash,
        error: describeError(err),
      });
      // Rethrow so the outer loop applies backoff and retries this range.
      throw err;
    }
  }

  private async run(): Promise<void> {
    let backoff = this.initialBackoffMs;

    while (!this.stopped) {
      try {
        const settled = await this.pollOnce();
        // Successful iteration: reset backoff.
        backoff = this.initialBackoffMs;

        if (settled > 0) {
          this.logger.info?.("released-watcher: settled intents", { settled });
        }

        await this.sleep(this.pollIntervalMs);
      } catch (err) {
        this.logger.error?.("released-watcher: poll failed", {
          error: describeError(err),
          backoffMs: backoff,
        });
        await this.sleep(backoff);
        backoff = Math.min(backoff * 2, this.maxBackoffMs);
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    if (this.stopped) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.wakeUp = undefined;
        resolve();
      }, ms);
      // Allow stop() to interrupt the sleep.
      this.wakeUp = () => {
        clearTimeout(timer);
        this.wakeUp = undefined;
        resolve();
      };
    });
  }
}

/**
 * Computes the intent hash used by the escrow contract for a given set of
 * identifying fields. Exposed for convenience so callers can correlate
 * mempool records with on-chain events.
 *
 * The exact preimage is defined by the escrow contract; this helper mirrors
 * the common `keccak256(abi.encode(...))` pattern using a stable concatenation
 * of the provided fields. Callers that need the precise on-chain hash should
 * compute it with the contract's own ABI encoding.
 */
export function computeIntentHash(parts: Array<string | Uint8Array>): string {
  const hash = createHash("sha256");
  for (const part of parts) {
    if (typeof part === "string") {
      hash.update(part);
    } else {
      hash.update(Buffer.from(part));
    }
  }
  return `0x${hash.digest("hex")}`;
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function isAlreadySettledError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const anyErr = err as {
    status?: number;
    code?: string | number;
    message?: string;
    response?: { status?: number };
  };
  const status = anyErr.status ?? anyErr.response?.status;
  if (status === 409) return true;
  if (status === 404) return true;
  const message = (anyErr.message ?? "").toLowerCase();
  return (
    message.includes("already settled") ||
    message.includes("not pending") ||
    message.includes("invalid status transition")
  );
}