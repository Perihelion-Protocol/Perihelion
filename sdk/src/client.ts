/**
 * Client for submitting intents to a Perihelion mempool and tracking status.
 *
 * The common integration path is three calls: sign an intent, submit it, then
 * poll (or `await`) until it settles.
 */

import type { TypedDataDomain, WalletClient } from "viem";
import { hashIntent, INTENT_TYPES, perihelionDomain, toMessage } from "./intent.js";
import {
  PerihelionHashMismatchError,
  PerihelionHttpError,
  PerihelionTimeoutError,
} from "./errors.js";
import { parseIntentRecord } from "./validate.js";
import type {
  Address,
  Hex,
  Intent,
  IntentRecord,
  SignedIntent,
} from "./types.js";

export interface ClientOptions {
  /** Base URL of the Perihelion mempool / relayer API. */
  readonly mempoolUrl: string;
  /** Chain ID of the EVM network the escrow is deployed on. */
  readonly chainId: number;
  /** Address of the PerihelionEscrow contract. */
  readonly verifyingContract: Address;
  /**
   * Per-request timeout in milliseconds. Applies to every fetch call.
   * Defaults to 10 000 ms. Set to 0 to disable.
   */
  readonly requestTimeoutMs?: number;
  /**
   * Maximum number of retries for idempotent GET requests on transient failures
   * (network errors or 5xx responses). Defaults to 3.
   */
  readonly maxRetries?: number;
  /** Override the fetch implementation (defaults to global `fetch`). */
  readonly fetch?: typeof fetch;
}

/** Thin client over a Perihelion mempool endpoint. */
export class PerihelionClient {
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;
  private readonly domain: TypedDataDomain;
  private readonly requestTimeoutMs: number;
  private readonly maxRetries: number;

  constructor(opts: ClientOptions) {
    this.base = opts.mempoolUrl.replace(/\/$/, "");
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
    this.domain = perihelionDomain(opts.chainId, opts.verifyingContract);
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 10_000;
    this.maxRetries = opts.maxRetries ?? 3;
  }

  /** Sign an intent with a viem wallet, producing a {@link SignedIntent}. */
  async signIntent(
    wallet: WalletClient,
    intent: Intent,
  ): Promise<SignedIntent> {
    const account = wallet.account;
    if (!account) throw new Error("wallet client has no account");
    const signature = (await wallet.signTypedData({
      account,
      domain: this.domain,
      types: INTENT_TYPES,
      primaryType: "Intent",
      message: toMessage(intent),
    })) as Hex;
    return { intent, signature, hash: hashIntent(intent, this.domain) };
  }

  /**
   * Submit a signed intent to the mempool. Returns its hash (id).
   *
   * The locally-computed `signed.hash` is treated as authoritative. If the
   * server echoes a different hash, {@link PerihelionHashMismatchError} is thrown.
   */
  async submitIntent(signed: SignedIntent): Promise<Hex> {
    const res = await this.fetchWithTimeout(`${this.base}/intents`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(signed),
    });
    if (!res.ok) {
      throw new PerihelionHttpError("submitIntent", res.status, await res.text());
    }
    const body = (await res.json()) as { hash?: Hex };
    if (body.hash && body.hash.toLowerCase() !== signed.hash.toLowerCase()) {
      throw new PerihelionHashMismatchError(signed.hash, body.hash);
    }
    return signed.hash;
  }

  /** Fetch the current record for an intent by its hash. */
  async getIntent(hash: Hex, signal?: AbortSignal): Promise<IntentRecord> {
    const res = await this.fetchWithRetry(`${this.base}/intents/${hash}`, {}, signal);
    if (!res.ok) {
      throw new PerihelionHttpError("getIntent", res.status, await res.text());
    }
    return parseIntentRecord(await res.json());
  }

  /**
   * Poll until the intent reaches a terminal state (`settled`, `refunded`, or
   * `expired`) or the timeout elapses.
   *
   * The `timeoutMs` deadline is wired directly into each `getIntent` request's
   * abort signal, so a hung network call cannot block past the outer deadline.
   *
   * @param opts.onStatus  Called on every poll when the status changes.
   */
  async waitForSettlement(
    hash: Hex,
    opts: {
      intervalMs?: number;
      timeoutMs?: number;
      onStatus?: (status: IntentRecord["status"], record: IntentRecord) => void;
    } = {},
  ): Promise<IntentRecord> {
    const interval = opts.intervalMs ?? 3_000;
    const timeoutMs = opts.timeoutMs ?? 5 * 60_000;
    const deadline = Date.now() + timeoutMs;
    const terminal = new Set(["settled", "refunded", "expired"]);
    let lastStatus: IntentRecord["status"] | undefined;

    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new PerihelionTimeoutError(
          `[Perihelion] waitForSettlement timed out for ${hash} (last status: ${lastStatus ?? "unknown"})`,
          hash,
          lastStatus,
        );
      }

      // Combine the outer deadline with the per-request timeout so the shorter
      // of the two wins — the outer timeout is always authoritative.
      const perRequest = this.requestTimeoutMs > 0
        ? Math.min(remaining, this.requestTimeoutMs)
        : remaining;
      const signal = AbortSignal.timeout(perRequest);

      let record: IntentRecord;
      try {
        record = await this.getIntent(hash, signal);
      } catch (e) {
        if (isAbortError(e)) {
          throw new PerihelionTimeoutError(
            `[Perihelion] waitForSettlement timed out for ${hash} (last status: ${lastStatus ?? "unknown"})`,
            hash,
            lastStatus,
          );
        }
        throw e;
      }

      if (record.status !== lastStatus) {
        lastStatus = record.status;
        opts.onStatus?.(record.status, record);
      }
      if (terminal.has(record.status)) return record;

      await sleep(Math.min(interval, deadline - Date.now()));
    }
  }

  // ─── private helpers ───────────────────────────────────────────────────────

  /** Single fetch with a per-request timeout abort signal. */
  private fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    const signal = this.requestTimeoutMs > 0
      ? AbortSignal.timeout(this.requestTimeoutMs)
      : undefined;
    return this.fetchImpl(url, { ...init, signal });
  }

  /**
   * Fetch with retry+backoff for transient failures.
   * An external signal (e.g. from `waitForSettlement`'s deadline) can be merged
   * so the outer deadline wins over the per-attempt timeout.
   */
  private async fetchWithRetry(
    url: string,
    init: RequestInit,
    externalSignal?: AbortSignal,
  ): Promise<Response> {
    let attempt = 0;
    for (;;) {
      const perAttemptMs = this.requestTimeoutMs > 0 ? this.requestTimeoutMs : undefined;
      const signal = combineSignals(
        perAttemptMs != null ? AbortSignal.timeout(perAttemptMs) : undefined,
        externalSignal,
      );
      let res: Response;
      try {
        res = await this.fetchImpl(url, { ...init, signal });
      } catch (e) {
        if (isAbortError(e) || attempt >= this.maxRetries) throw e;
        await sleep(backoff(attempt++));
        continue;
      }
      if (res.status >= 500 && attempt < this.maxRetries) {
        await sleep(backoff(attempt++));
        continue;
      }
      return res;
    }
  }
}

// ─── utilities ───────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

/** Exponential backoff: 100 ms, 200 ms, 400 ms, … capped at 5 s. */
function backoff(attempt: number): number {
  return Math.min(100 * 2 ** attempt, 5_000);
}

function isAbortError(e: unknown): boolean {
  return e instanceof Error && e.name === "AbortError";
}

/**
 * Combine two optional AbortSignals so that either aborting aborts the result.
 * Returns undefined if both are undefined.
 */
function combineSignals(
  a: AbortSignal | undefined,
  b: AbortSignal | undefined,
): AbortSignal | undefined {
  if (!a) return b;
  if (!b) return a;
  const ctrl = new AbortController();
  const abort = () => ctrl.abort();
  a.addEventListener("abort", abort, { once: true });
  b.addEventListener("abort", abort, { once: true });
  return ctrl.signal;
}
