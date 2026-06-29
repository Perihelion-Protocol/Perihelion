/**
 * The Perihelion solver loop: poll the mempool for pending intents, evaluate
 * each for profitability, and execute fills for the winners.
 */

import {
  PerihelionClient,
  verifyIntent,
  type IntentRecord,
  type SignedIntent,
} from "@perihelion/sdk";
import type { SolverConfig } from "./config.js";
import { evaluate, type PricingDeps } from "./quote.js";

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

/**
 * Per-intent retry state for transient failures.
 * Terminal outcomes remove the entry; transient failures increment the counter.
 */
interface RetryState {
  attempts: number;
  nextRetryAt: number;
}

const MAX_FILL_RETRIES = 3;

/** Exponential backoff in ms: 1s, 2s, 4s. */
function retryBackoff(attempt: number): number {
  return Math.min(1_000 * 2 ** attempt, 30_000);
}

export class Solver {
  private readonly client: PerihelionClient;
  /**
   * `seen` only contains hashes whose outcome is terminal (filled, skipped for
   * a durable reason, or exhausted retries). Transient failures are tracked in
   * `retryState` and remain eligible for reconsideration.
   */
  private readonly seen = new Set<string>();
  private readonly retryState = new Map<string, RetryState>();
  private running = false;

  constructor(
    private readonly config: SolverConfig,
    private readonly executor: Executor,
    private readonly log: Logger = console,
    fetchImpl?: typeof fetch,
    private readonly pricingDeps: PricingDeps = {},
  ) {
    this.client = new PerihelionClient({ mempoolUrl: config.mempoolUrl, fetch: fetchImpl });
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
      } catch (err) {
        this.log.error("tick failed", { err: String(err) });
      }
      await sleep(this.config.pollIntervalMs);
    }
  }

  stop(): void {
    this.running = false;
  }

  /** One poll-evaluate-fill cycle. Exposed for testing. */
  async tick(): Promise<void> {
    const pending = await this.client.listPending();
    const now = Date.now();
    for (const record of pending) {
      const { hash } = record;
      if (this.seen.has(hash)) continue;

      const retry = this.retryState.get(hash);
      if (retry && now < retry.nextRetryAt) continue;

      await this.consider(record);
    }
  }

  private async consider(record: IntentRecord): Promise<void> {
    const { intent, signature, hash } = record;

    if (!(await verifyIntent(intent, signature))) {
      this.log.warn("rejecting intent with invalid signature", { hash });
      // Terminal: invalid signature will never become valid.
      this.seen.add(hash);
      this.retryState.delete(hash);
      return;
    }

    const decision = await evaluate(intent, this.config, this.pricingDeps);
    if (!decision.fill) {
      if (decision.terminal) {
        // Terminal skip — never retry.
        this.log.info("skipping intent (terminal)", { hash, reason: decision.reason });
        this.seen.add(hash);
        this.retryState.delete(hash);
      } else {
        // Transient skip (e.g. evaluate pricing error) — schedule retry.
        this.scheduleRetry(hash);
        this.log.info("skipping intent (transient)", { hash, reason: decision.reason });
      }
      return;
    }

    this.log.info("filling intent", { hash, profitBps: decision.profitBps });
    try {
      const { settlementTx } = await this.executor.fill(record);
      this.log.info("filled", { hash, settlementTx });
      // Terminal: successfully filled.
      this.seen.add(hash);
      this.retryState.delete(hash);
    } catch (err) {
      this.log.error("fill failed", { hash, err: String(err) });
      this.scheduleRetry(hash);
    }
  }

  private scheduleRetry(hash: string): void {
    const state = this.retryState.get(hash) ?? { attempts: 0, nextRetryAt: 0 };
    const attempts = state.attempts + 1;
    if (attempts > MAX_FILL_RETRIES) {
      this.log.warn("max retries exhausted, retiring intent", { hash, attempts });
      this.seen.add(hash);
      this.retryState.delete(hash);
    } else {
      this.retryState.set(hash, {
        attempts,
        nextRetryAt: Date.now() + retryBackoff(attempts - 1),
      });
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
