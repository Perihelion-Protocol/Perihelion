/**
 * The Perihelion solver loop: poll the mempool for pending intents, evaluate
 * each for profitability, and execute fills for the winners.
 */

import {
  PerihelionClient,
  parseIntentRecordArray,
  verifyIntent,
  hashIntent,
  perihelionDomain,
  type IntentRecord,
  type SignedIntent,
  type Hex,
} from "@perihelion/sdk";
import type { SolverConfig } from "./config.js";
import { evaluate } from "./quote.js";

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
 * LRU cache for signature verification results. Evicts oldest entries when the
 * cache exceeds its size limit to prevent unbounded memory growth.
 */
class VerificationCache {
  private readonly cache = new Map<Hex, boolean>();
  private readonly maxSize: number;

  constructor(maxSize = 10_000) {
    this.maxSize = maxSize;
  }

  get(hash: Hex): boolean | undefined {
    const result = this.cache.get(hash);
    if (result !== undefined) {
      // Move to end (LRU)
      this.cache.delete(hash);
      this.cache.set(hash, result);
    }
    return result;
  }

  set(hash: Hex, valid: boolean): void {
    // Evict oldest if at capacity
    if (this.cache.size >= this.maxSize) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(hash, valid);
  }

  size(): number {
    return this.cache.size;
  }
}

export class Solver {
  private readonly client: PerihelionClient;
  private readonly seen = new Set<string>();
  private readonly verificationCache: VerificationCache;
  private running = false;

  constructor(
    private readonly config: SolverConfig,
    private readonly executor: Executor,
    private readonly log: Logger = console,
  ) {
    this.client = new PerihelionClient({
      mempoolUrl: config.mempoolUrl,
      chainId: config.sourceChainId,
      verifyingContract: config.escrowAddress,
    });
    this.verificationCache = new VerificationCache(config.verificationCacheSize);
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
    const pending = await this.fetchPending();
    for (const record of pending) {
      if (this.seen.has(record.hash)) continue;
      this.seen.add(record.hash);
      await this.consider(record);
    }
  }

  private async consider(record: IntentRecord): Promise<void> {
    const { intent, signature, hash } = record;

    // Verify the mempool's hash matches our recomputation
    const domain = perihelionDomain(this.config.sourceChainId, this.config.escrowAddress);
    const recomputedHash = hashIntent(intent, domain);
    if (recomputedHash.toLowerCase() !== hash.toLowerCase()) {
      this.log.warn("rejecting intent: mempool hash mismatch", {
        hash,
        recomputedHash,
      });
      return;
    }

    // Check cache first to avoid redundant verification
    let valid = this.verificationCache.get(hash);
    if (valid === undefined) {
      // Not cached — verify and cache the result
      valid = await verifyIntent(intent, signature, domain);
      this.verificationCache.set(hash, valid);
    }

    if (!valid) {
      this.log.warn("rejecting intent with invalid signature", { hash });
      return;
    }

    const decision = await evaluate(intent, this.config);
    if (!decision.fill) {
      this.log.info("skipping intent", { hash, reason: decision.reason });
      return;
    }

    this.log.info("filling intent", { hash, marginBps: decision.marginBps });
    try {
      const { settlementTx } = await this.executor.fill(record);
      this.log.info("filled", { hash, settlementTx });
    } catch (err) {
      this.log.error("fill failed", { hash, err: String(err) });
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
