/**
 * The Perihelion solver loop: poll the mempool for pending intents, evaluate
 * each for profitability, and execute fills for the winners.
 */

import {
  PerihelionClient,
  parseIntentRecordArray,
  verifyIntent,
  type IntentRecord,
  type SignedIntent,
} from "@perihelion/sdk";
import type { SolverConfig } from "./config.js";
import { evaluate } from "./quote.js";
import { BackoffState } from "./backoff.js";
import type { Metrics } from "./metrics.js";

/** Pluggable execution backend — abstracts the two settlement legs. */
export interface Executor {
  /**
   * Lock the user's source funds in the EVM escrow against the intent hash and
   * release the destination assets on Stellar once the LayerZero message is
   * confirmed. Returns the Stellar settlement tx hash.
   */
  fill(signed: SignedIntent): Promise<{ settlementTx: string }>;
}

/** Minimal logger interface so callers can inject structured logging. */
export interface Logger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

export class Solver {
  private readonly client: PerihelionClient;
  private readonly seen = new Set<string>();
  private running = false;
  private readonly backoff: BackoffState;

  constructor(
    private readonly config: SolverConfig,
    private readonly executor: Executor,
    private readonly log: Logger = console,
    private readonly metrics?: Metrics,
  ) {
    this.client = new PerihelionClient({ mempoolUrl: config.mempoolUrl });
    this.backoff = new BackoffState(config);
  }

  /** Start the poll loop. Resolves when {@link stop} is called. */
  async start(): Promise<void> {
    this.running = true;
    this.log.info("solver started", {
      solver: this.config.solverAddress,
      mempool: this.config.mempoolUrl,
    });
    while (this.running) {
      try {
        await this.tick();
        this.backoff.recordSuccess();
      } catch (err) {
        this.backoff.recordFailure();
        this.log.error("tick failed", {
          err: String(err),
          consecutiveFailures: this.backoff.consecutiveFailures,
        });
      }
      await sleep(this.backoff.nextDelay());
    }
  }

  stop(): void {
    this.running = false;
  }

  /** One poll-evaluate-fill cycle. Exposed for testing. */
  async tick(): Promise<void> {
    const pending = await this.fetchPending();
    for (const record of pending) {
      if (this.seen.has(record.hash)) continue;
      this.seen.add(record.hash);
      await this.consider(record);
    }
  }

  private async consider(record: IntentRecord): Promise<void> {
    const { intent, signature, hash } = record;

    if (!(await verifyIntent(intent, signature))) {
      this.log.warn("rejecting intent with invalid signature", { hash });
      return;
    }

    const decision = await evaluate(intent, this.config);
    if (!decision.fill) {
      this.log.info("skipping intent", { hash, reason: decision.reason });
      this.metrics?.recordSkip(decision.reason);
      return;
    }

    this.log.info("filling intent", { hash, marginBps: decision.marginBps });
    this.metrics?.recordFillAttempt(intent.destAsset);
    try {
      const { settlementTx } = await this.executor.fill(record);
      this.log.info("filled", { hash, settlementTx });
      this.metrics?.recordFillWon(
        intent.destAsset,
        BigInt(intent.minDestAmount),
        decision.marginBps ?? 0,
      );
    } catch (err) {
      this.log.error("fill failed", { hash, err: String(err) });
      this.metrics?.recordFillLost(intent.destAsset, String(err));
    }
  }

  private async fetchPending(): Promise<IntentRecord[]> {
    const res = await fetch(`${this.config.mempoolUrl}/intents?status=pending`);
    if (!res.ok) throw new Error(`mempool poll failed: ${res.status}`);
    return parseIntentRecordArray(await res.json());
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
