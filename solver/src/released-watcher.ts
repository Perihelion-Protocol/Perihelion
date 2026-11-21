// SPDX-License-Identifier: MIT
// solver/src/released-watcher.ts
//
// Watches the source-chain (EVM) PerihelionEscrow contract for terminal
// events and reports the corresponding intent's final status to the mempool:
//
//   - `Released`                              -> `settled`
//   - `Refunded` / `RefundedLocalTimeout`     -> `refunded`
//
// This is the *only* component that should transition an intent to the
// terminal `settled` or `refunded` statuses. The solver itself reports
// `filled` once it has delivered on Stellar; the terminal statuses are
// reserved for the point at which the source chain has actually moved the
// escrowed funds.
//
// Only events at least `confirmations` blocks deep are reported, so a shallow
// reorg cannot produce a `settled` / `refunded` status that later reverts.

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

/** Escrow events that end an intent's lifecycle on the source chain. */
export type TerminalEventKind = "Released" | "Refunded" | "RefundedLocalTimeout";

/** The mempool status each terminal escrow event maps to. */
export const TERMINAL_STATUS: Record<TerminalEventKind, "settled" | "refunded"> = {
  Released: "settled",
  Refunded: "refunded",
  RefundedLocalTimeout: "refunded",
};

/**
 * A single terminal event observed on the escrow contract.
 */
export interface TerminalEvent {
  /** Which escrow event was emitted; determines the status reported. */
  kind: TerminalEventKind;
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
 * Abstraction over the escrow contract used to fetch terminal events.
 *
 * Implementations may wrap a viem client, an ethers `Contract`, or any other
 * EVM client. The watcher only needs to query a block range for terminal
 * events and to learn the current head block.
 */
export interface EscrowTerminalSource {
  /** Returns the current head block number. */
  getBlockNumber(): Promise<number>;
  /**
   * Returns all terminal events (`Released`, `Refunded`,
   * `RefundedLocalTimeout`) emitted between `fromBlock` and `toBlock`
   * (inclusive), ordered by block number and log index.
   */
  getTerminalEvents(fromBlock: number, toBlock: number): Promise<TerminalEvent[]>;
}

/**
 * Persists the scan cursor across restarts. Structurally compatible with the
 * relayer's `CheckpointStore`.
 */
export interface CheckpointStore {
  /** Returns the saved next block to scan from, or undefined if none. */
  load(): Promise<number | undefined>;
  /** Saves the next block to scan from. */
  save(block: number): Promise<void>;
}

export interface ReleasedWatcherOptions {
  /** The escrow event source. */
  source: EscrowTerminalSource;
  /** The mempool client used to report status transitions. */
  client: PerihelionClient;
  /** The mempool's shared status token, required to call `reportStatus`. */
  statusToken: string;
  /** Optional logger. */
  logger?: ReleasedWatcherLogger;
  /**
   * The block from which to start scanning on first run, used only when no
   * checkpoint has been saved. Defaults to the current head block (i.e. only
   * watch events emitted from now on).
   */
  startBlock?: number;
  /**
   * Number of blocks an event must be buried under (inclusive of its own
   * block) before it is reported. `1` reports as soon as the event is mined.
   * Defaults to 1.
   */
  confirmations?: number;
  /**
   * Optional cursor persistence. When provided, the scan resumes from the
   * saved block after a restart instead of the current head.
   */
  checkpoint?: CheckpointStore;
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
   * Optional callback invoked after an intent has been reported to the
   * mempool. Useful for tests and for wiring additional side effects.
   */
  onReported?: (
    intentHash: Hex,
    status: "settled" | "refunded",
    event: TerminalEvent,
  ) => void | Promise<void>;
}

/**
 * Polls the escrow contract for terminal events and reports each observed
 * intent's final status to the mempool.
 *
 * The watcher is resilient to transient RPC and mempool failures: it retries
 * with exponential backoff and only advances its cursor past a block range
 * once every event in that range has been successfully reported (or has been
 * determined to be a duplicate / already-terminal intent).
 */
export class ReleasedWatcher {
  private readonly source: EscrowTerminalSource;
  private readonly client: PerihelionClient;
  private readonly statusToken: string;
  private readonly logger: ReleasedWatcherLogger;
  private readonly confirmations: number;
  private readonly checkpoint?: CheckpointStore;
  private readonly maxBlockRange: number;
  private readonly pollIntervalMs: number;
  private readonly initialBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly onReported?: ReleasedWatcherOptions["onReported"];

  /** Next block to scan from (inclusive). */
  private nextBlock: number | undefined;
  /** Set of `hash:status` keys already reported (hash lowercased). */
  private readonly reported = new Set<string>();

  private running = false;
  private stopped = false;
  private loopPromise: Promise<void> | undefined;
  private wakeUp: (() => void) | undefined;

  constructor(options: ReleasedWatcherOptions) {
    const confirmations = options.confirmations ?? 1;
    if (!Number.isInteger(confirmations) || confirmations < 1) {
      throw new Error(`released-watcher: confirmations must be an integer >= 1, got ${confirmations}`);
    }
    this.source = options.source;
    this.client = options.client;
    this.statusToken = options.statusToken;
    this.logger = options.logger ?? {};
    this.confirmations = confirmations;
    this.checkpoint = options.checkpoint;
    this.maxBlockRange = options.maxBlockRange ?? 2_000;
    this.pollIntervalMs = options.pollIntervalMs ?? 5_000;
    this.initialBackoffMs = options.initialBackoffMs ?? 1_000;
    this.maxBackoffMs = options.maxBackoffMs ?? 60_000;
    this.onReported = options.onReported;
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
   * Returns the number of intents reported to the mempool during this iteration.
   */
  async pollOnce(): Promise<number> {
    const head = await this.source.getBlockNumber();

    if (this.nextBlock === undefined) {
      const saved = await this.checkpoint?.load();
      if (saved !== undefined) {
        this.nextBlock = saved;
        this.logger.info?.("released-watcher: resumed from checkpoint", {
          startBlock: saved,
        });
      } else {
        // First run: start from the current head so we do not replay history.
        this.nextBlock = head;
        this.logger.info?.("released-watcher: initialised", {
          startBlock: head,
        });
        return 0;
      }
    }

    // Highest block whose events are buried under `confirmations` blocks.
    const safeHead = head - this.confirmations + 1;
    if (this.nextBlock > safeHead) {
      return 0;
    }

    let reportedCount = 0;
    let from = this.nextBlock;

    while (from <= safeHead && !this.stopped) {
      const to = Math.min(from + this.maxBlockRange - 1, safeHead);
      const events = await this.source.getTerminalEvents(from, to);

      // Process in deterministic order.
      events.sort((a, b) => {
        if (a.blockNumber !== b.blockNumber) {
          return a.blockNumber - b.blockNumber;
        }
        return a.logIndex - b.logIndex;
      });

      for (const event of events) {
        // Stopped mid-range: leave the cursor where it is so this range is
        // rescanned on the next start.
        if (this.stopped) return reportedCount;
        if (await this.handleEvent(event)) reportedCount += 1;
      }

      // Only advance the cursor once the whole range has been processed.
      from = to + 1;
      this.nextBlock = from;
      await this.checkpoint?.save(from);
    }

    return reportedCount;
  }

  private async handleEvent(event: TerminalEvent): Promise<boolean> {
    const status = TERMINAL_STATUS[event.kind];
    const key = `${event.intentHash.toLowerCase()}:${status}`;

    if (this.reported.has(key)) {
      this.logger.debug?.("released-watcher: already reported", {
        intentHash: event.intentHash,
        status,
      });
      return false;
    }

    try {
      await this.client.reportStatus(event.intentHash, status, this.statusToken);
      this.reported.add(key);
      this.logger.info?.("released-watcher: reported terminal status", {
        intentHash: event.intentHash,
        status,
        event: event.kind,
        blockNumber: event.blockNumber,
        transactionHash: event.transactionHash,
      });
      try {
        await this.onReported?.(event.intentHash, status, event);
      } catch (err) {
        this.logger.warn?.("released-watcher: onReported callback failed", {
          intentHash: event.intentHash,
          error: describeError(err),
        });
      }
      return true;
    } catch (err) {
      // If the mempool already considers the intent terminal, treat it as done
      // so we do not retry forever.
      if (isAlreadyTerminalError(err)) {
        this.reported.add(key);
        this.logger.debug?.("released-watcher: intent already terminal", {
          intentHash: event.intentHash,
          status,
        });
        return false;
      }

      this.logger.warn?.("released-watcher: failed to report terminal status", {
        intentHash: event.intentHash,
        status,
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
        const reported = await this.pollOnce();
        // Successful iteration: reset backoff.
        backoff = this.initialBackoffMs;

        if (reported > 0) {
          this.logger.info?.("released-watcher: reported intents", { reported });
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

function isAlreadyTerminalError(err: unknown): boolean {
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
    message.includes("already refunded") ||
    message.includes("not pending") ||
    message.includes("invalid status transition")
  );
}
