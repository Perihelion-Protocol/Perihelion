// SPDX-License-Identifier: MIT

/**
 * Client for submitting intents to a Perihelion mempool and tracking status.
 *
 * The common integration path is three calls: sign an intent, submit it, then
 * poll (or `await`) until it settles.
 */

import type { TypedDataDomain, WalletClient } from "viem";
import { hashIntent, INTENT_TYPES, perihelionDomain, toMessage } from "./intent.js";
import {
  PerihelionError,
  PerihelionHashMismatchError,
  PerihelionHttpError,
  PerihelionNetworkError,
  PerihelionTimeoutError,
  PerihelionValidationError,
} from "./errors.js";
import { parseIntentRecord, parseIntentRecordArray } from "./validate.js";
import type {
  Address,
  Hex,
  Intent,
  IntentRecord,
  IntentStatus,
  SignedIntent,
} from "./types.js";

export interface ClientOptions {
  /** Base URL of the Perihelion mempool / relayer API. */
  readonly mempoolUrl: string;
  /** Chain ID of the EVM network the escrow is deployed on. Required for {@link PerihelionClient.signIntent}. */
  readonly chainId?: number;
  /** Address of the PerihelionEscrow contract. Required for {@link PerihelionClient.signIntent}. */
  readonly verifyingContract?: Address;
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

/**
 * Default page size {@link PerihelionClient.listPending} requests explicitly,
 * matching the mempool server's own default page cap (issue #532). Passing an
 * explicit value (rather than relying on the server's default) keeps page
 * sizes bounded even against a server whose own default changes or is
 * misconfigured.
 */
const DEFAULT_LIST_LIMIT = 100;

export interface ListPendingPageResult {
  /** Intent records returned in this page. */
  readonly records: IntentRecord[];
  /** Continuation cursor to fetch the subsequent page, or undefined if this was the last page. */
  readonly nextCursor?: string;
}

/**
 * Thin client over a Perihelion mempool endpoint.
 *
 * ## Retry Policy Summary
 * - **Writes ({@link submitIntent}, {@link reportStatus})**: Do NOT retry automatically.
 *   `submitIntent` is non-idempotent from the server's perspective (duplicate submissions return HTTP 409).
 * - **Reads ({@link getIntent}, {@link listPending}, {@link listPendingPage})**: Retry transient failures
 *   (network connection errors and 5xx HTTP responses) up to `maxRetries` times with exponential backoff.
 *   Timeouts and caller-initiated aborts are never retried.
 * - **Polling ({@link waitForSettlement})**: Repeatedly calls {@link getIntent} until a terminal status
 *   (`settled`, `refunded`, `expired`) is reached or `timeoutMs` elapses.
 */
export class PerihelionClient {
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;
  private readonly opts: ClientOptions;
  private readonly requestTimeoutMs: number;
  private readonly maxRetries: number;

  constructor(opts: ClientOptions) {
    // Parse and validate the URL up-front so any mistake is reported immediately
    // at construction with the option name, rather than surfacing as an opaque
    // TypeError inside the first fetch call.
    let parsed: URL;
    try {
      parsed = new URL(opts.mempoolUrl);
    } catch {
      throw new PerihelionValidationError(
        `[Perihelion] mempoolUrl must be a valid URL, got: "${opts.mempoolUrl}"`,
      );
    }
    // Derive the normalised base from the parsed URL so that repeated slashes,
    // default ports, and other quirks are resolved before any path is appended.
    // Strip the trailing slash from the pathname so every request path is
    // appended with a single '/'.
    this.base = `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`;

    // Warn when the scheme is http: and the host is not a loopback address.
    // reportStatus forwards a bearer token, which would be transmitted in clear
    // text to a non-local http:// endpoint.
    if (
      parsed.protocol === "http:" &&
      parsed.hostname !== "localhost" &&
      parsed.hostname !== "127.0.0.1" &&
      parsed.hostname !== "::1"
    ) {
      console.warn(
        "[Perihelion] mempoolUrl uses http:// with a non-loopback host — " +
          "bearer tokens sent to reportStatus will be transmitted in clear text. " +
          "Use https:// in production.",
      );
    }

    this.fetchImpl = opts.fetch ?? globalThis.fetch;
    this.opts = opts;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 10_000;
    this.maxRetries = opts.maxRetries ?? 3;
  }

  private get domain(): TypedDataDomain {
    if (this.opts.chainId == null || this.opts.verifyingContract == null) {
      throw new PerihelionValidationError(
        "[Perihelion] chainId and verifyingContract are required for signing",
      );
    }
    return perihelionDomain(this.opts.chainId, this.opts.verifyingContract);
  }

  /** Sign an intent with a viem wallet, producing a {@link SignedIntent}. */
  async signIntent(
    wallet: WalletClient,
    intent: Intent,
  ): Promise<SignedIntent> {
    const account = wallet.account;
    if (!account) throw new PerihelionValidationError("wallet client has no account");
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
   * **Retry policy**: Does NOT retry automatically. Mempool intent submissions
   * are non-idempotent from the server's perspective; duplicate submissions return HTTP 409.
   *
   * The locally-computed `signed.hash` is treated as authoritative. If the
   * server echoes a different hash, {@link PerihelionHashMismatchError} is thrown.
   *
   * @throws {@link PerihelionHttpError} on non-2xx responses (e.g. 400 validation, 409 conflict).
   * @throws {@link PerihelionTimeoutError} if the request exceeds `requestTimeoutMs`.
   * @throws {@link PerihelionNetworkError} on network / transport failure.
   * @throws {@link PerihelionHashMismatchError} if the server returns a different hash.
   */
  async submitIntent(signed: SignedIntent): Promise<Hex> {
    let res: Response;
    try {
      res = await this.fetchWithTimeout(`${this.base}/intents`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(signed),
      });
    } catch (e) {
      if (e instanceof PerihelionError) throw e;
      if (isTimeoutError(e)) {
        throw new PerihelionTimeoutError(
          `[Perihelion] submitIntent timed out after ${this.requestTimeoutMs}ms`,
          signed.hash,
          undefined,
          { cause: e },
        );
      }
      throw new PerihelionNetworkError(
        `[Perihelion] submitIntent network error: ${e instanceof Error ? e.message : String(e)}`,
        "submitIntent",
        { cause: e },
      );
    }
    if (!res.ok) {
      throw new PerihelionHttpError("submitIntent", res.status, await res.text());
    }
    let body: { hash?: Hex };
    try {
      body = (await res.json()) as { hash?: Hex };
    } catch (e) {
      throw new PerihelionNetworkError(
        `[Perihelion] submitIntent failed to parse response: ${e instanceof Error ? e.message : String(e)}`,
        "submitIntent",
        { cause: e },
      );
    }
    if (body.hash && body.hash.toLowerCase() !== signed.hash.toLowerCase()) {
      throw new PerihelionHashMismatchError(signed.hash, body.hash);
    }
    return signed.hash;
  }

  /**
   * Report a status transition for an intent (e.g. `"claimed"`, `"settled"`).
   * Restricted server-side to holders of the mempool's shared status token —
   * intended for relayer/solver services, not end users.
   *
   * **Retry policy**: Does NOT retry automatically (PATCH updates intent state).
   *
   * @throws {@link PerihelionHttpError} on non-2xx responses (401 unauthorized, 404 not found, 409 conflict).
   * @throws {@link PerihelionTimeoutError} if the request exceeds `requestTimeoutMs`.
   * @throws {@link PerihelionNetworkError} on network / transport failure.
   */
  async reportStatus(hash: Hex, status: IntentStatus, statusToken: string): Promise<void> {
    let res: Response;
    try {
      res = await this.fetchWithTimeout(`${this.base}/intents/${hash}/status`, {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${statusToken}`,
        },
        body: JSON.stringify({ status }),
      });
    } catch (e) {
      if (e instanceof PerihelionError) throw e;
      if (isTimeoutError(e)) {
        throw new PerihelionTimeoutError(
          `[Perihelion] reportStatus timed out for ${hash} after ${this.requestTimeoutMs}ms`,
          hash,
          undefined,
          { cause: e },
        );
      }
      throw new PerihelionNetworkError(
        `[Perihelion] reportStatus network error for ${hash}: ${e instanceof Error ? e.message : String(e)}`,
        "reportStatus",
        { cause: e },
      );
    }
    if (!res.ok) {
      throw new PerihelionHttpError("reportStatus", res.status, await res.text());
    }
  }

  /**
   * Fetch the current record for an intent by its hash.
   *
   * **Retry policy**: Retries transient failures (network errors and 5xx HTTP responses)
   * up to `maxRetries` times with exponential backoff. Aborts and timeouts are never retried.
   *
   * @throws {@link PerihelionHttpError} on non-2xx responses (e.g. 404 not found).
   * @throws {@link PerihelionTimeoutError} if the request exceeds `requestTimeoutMs`.
   * @throws {@link PerihelionNetworkError} on non-retryable network failure.
   */
  async getIntent(hash: Hex, signal?: AbortSignal): Promise<IntentRecord> {
    const res = await this.fetchWithRetry("getIntent", `${this.base}/intents/${hash}`, {}, signal);
    if (!res.ok) {
      throw new PerihelionHttpError("getIntent", res.status, await res.text());
    }
    let json: unknown;
    try {
      json = await res.json();
    } catch (e) {
      throw new PerihelionNetworkError(
        `[Perihelion] getIntent failed to parse JSON: ${e instanceof Error ? e.message : String(e)}`,
        "getIntent",
        { cause: e },
      );
    }
    return parseIntentRecord(json);
  }

  /**
   * Fetch a single page of intents filtered by status, returning records and
   * an optional `nextCursor` for pagination.
   *
   * **Retry policy**: Retries transient failures (network errors and 5xx HTTP responses)
   * up to `maxRetries` times with exponential backoff.
   *
   * @throws {@link PerihelionHttpError} on non-2xx responses (e.g. 400 invalid status).
   * @throws {@link PerihelionTimeoutError} if the request exceeds `requestTimeoutMs`.
   * @throws {@link PerihelionNetworkError} on non-retryable network failure.
   */
  async listPendingPage(
    status: IntentStatus = "pending",
    cursor?: string,
    limit?: number,
  ): Promise<ListPendingPageResult> {
    const qs = new URLSearchParams({ status });
    if (cursor) qs.set("cursor", cursor);
    if (limit != null) qs.set("limit", String(limit));
    const url = `${this.base}/intents?${qs}`;

    const res = await this.fetchWithRetry("listPendingPage", url, {});
    if (!res.ok) {
      throw new PerihelionHttpError("listPendingPage", res.status, await res.text());
    }

    let body: { records?: unknown; nextCursor?: unknown };
    try {
      body = (await res.json()) as { records?: unknown; nextCursor?: unknown };
    } catch (e) {
      throw new PerihelionNetworkError(
        `[Perihelion] listPendingPage failed to parse response: ${e instanceof Error ? e.message : String(e)}`,
        "listPendingPage",
        { cause: e },
      );
    }
    return {
      records: parseIntentRecordArray(body.records),
      nextCursor: typeof body.nextCursor === "string" ? body.nextCursor : undefined,
    };
  }

  /**
   * Async generator that yields pages of intent records one by one, following
   * `nextCursor` until no further pages remain.
   *
   * **Retry policy**: Each page request retries transient failures up to `maxRetries` times.
   */
  async *listPendingPages(
    status: IntentStatus = "pending",
    limit?: number,
  ): AsyncGenerator<IntentRecord[], void, unknown> {
    let cursor: string | undefined;
    do {
      const page: ListPendingPageResult = await this.listPendingPage(status, cursor, limit);
      yield page.records;
      cursor = page.nextCursor;
    } while (cursor !== undefined);
  }

  /**
   * List intents filtered by status, following pagination cursors until all
   * pages are exhausted. Defaults to `"pending"`, which is the primary solver
   * use-case.
   *
   * **Retry policy**: Retries each page request up to `maxRetries` times on
   * transient network errors and 5xx server responses.
   *
   * The server caps each page at `DEFAULT_LIST_LIMIT` (100) records and
   * returns a `nextCursor` when more remain. This method accumulates all pages
   * so callers always see the full result set, regardless of how many intents
   * are in the mempool. A `maxPages` guard (default 100) prevents a
   * misbehaving server from looping the client forever.
   *
   * For callers that need explicit pagination control (e.g. a solver that wants
   * to rate-limit its own page fetches), use {@link listPendingPage} or {@link listPendingPages} directly.
   *
   * **Bounded requests**: every page request passes an explicit `limit` (default
   * {@link DEFAULT_LIST_LIMIT}) in the query string rather than relying on the
   * server's own default, so page size stays bounded end-to-end (issue #532).
   */
  async listPending(
    status: IntentStatus = "pending",
    maxPages = 100,
    limit: number = DEFAULT_LIST_LIMIT,
  ): Promise<IntentRecord[]> {
    const all: IntentRecord[] = [];
    let cursor: string | undefined;
    let pages = 0;

    do {
      const page = await this.listPendingPage(status, cursor, limit);
      all.push(...page.records);
      cursor = page.nextCursor;
      pages++;
    } while (cursor !== undefined && pages < maxPages);

    return all;
  }

  /**
   * Poll until the intent reaches a terminal state (`settled`, `refunded`, or
   * `expired`) or the timeout elapses.
   *
   * **Retry policy**: Repeatedly polls {@link getIntent} at configured `intervalMs`.
   * Each poll attempt inherits `getIntent`'s retry policy for transient errors,
   * but the total elapsed polling time is strictly bounded by `timeoutMs`.
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
        if (isAbortError(e) || e instanceof PerihelionTimeoutError) {
          throw new PerihelionTimeoutError(
            `[Perihelion] waitForSettlement timed out for ${hash} (last status: ${lastStatus ?? "unknown"})`,
            hash,
            lastStatus,
            { cause: e },
          );
        }
        throw e;
      }

      if (record.status !== lastStatus) {
        lastStatus = record.status;
        opts.onStatus?.(record.status, record);
      }
      if (terminal.has(record.status)) return record;

      const remainingAfterPoll = deadline - Date.now();
      if (remainingAfterPoll <= 0) continue;
      await sleep(Math.min(interval, remainingAfterPoll));
    }
  }

  /**
   * Check if an intent is refundable via `cancelExpired` (issue #175).
   *
   * An intent is refundable if **all three** conditions hold:
   * 1. It exists and has not been settled or previously refunded.
   * 2. Its deadline has passed **and** the confirmation grace period has elapsed.
   * 3. No `FillConfirmed` was received — the status is still `'pending'`.
   *    An intent with status `'claimed'`, `'settling'`, or `'expired'` is **not**
   *    refundable: `settling` means a cross-chain message is already in flight
   *    (calling `cancelExpired` would race it and likely revert with
   *    `AlreadyFinalized`), and `claimed` / `expired` indicate the on-chain
   *    state has already diverged from the refund path.
   *
   * This helper detects when a bridge has definitively failed and the user's
   * funds can be recovered locally without waiting for cross-chain confirmation.
   *
   * **Typical usage**: After `waitForSettlement` times out or returns `'expired'`,
   * check `isRefundable` to see if the user can recover via the local fallback.
   *
   * ```ts
   * const grace = await escrowClient.confirmationGrace(); // live contract value
   * const record = await client.waitForSettlement(hash);
   * if (client.isRefundable(record, grace * 1_000)) {
   *   // Call escrow.cancelExpired(hash) to recover funds
   * }
   * ```
   *
   * @param record The intent record to check.
   * @param confirmationGraceMs Confirmation grace period in **milliseconds**.
   *   This **must** be read from the live contract via
   *   {@link PerihelionEscrowClient.confirmationGrace} and converted to ms —
   *   the value is timelock-governed and can change after deployment.
   *   There is deliberately no default; passing a stale constant will produce
   *   an incorrect verdict.
   * @returns `true` if the intent can be refunded via `cancelExpired`.
   *
   * @see {PerihelionEscrowClient.confirmationGrace} to read the live grace period.
   */
  isRefundable(record: IntentRecord, confirmationGraceMs: number): boolean {
    // Condition 3: only 'pending' intents are candidates — no settlement is
    // in progress or has already completed.
    if (record.status !== "pending") {
      return false;
    }
    // Conditions 1 & 2: deadline + grace must have passed (unix seconds).
    const now = Math.floor(Date.now() / 1_000);
    const deadlineWithGrace = record.intent.deadline + Math.floor(confirmationGraceMs / 1_000);
    return now >= deadlineWithGrace;
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
    operation: string,
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
        if (isAbortError(e)) {
          if (isTimeoutError(e)) {
            throw new PerihelionTimeoutError(
              `[Perihelion] ${operation} timed out after ${this.requestTimeoutMs}ms`,
              undefined,
              undefined,
              { cause: e },
            );
          }
          if (e instanceof PerihelionError) throw e;
          throw new PerihelionNetworkError(
            `[Perihelion] ${operation} aborted: ${e instanceof Error ? e.message : String(e)}`,
            operation,
            { cause: e },
          );
        }
        if (attempt >= this.maxRetries) {
          if (e instanceof PerihelionError) throw e;
          throw new PerihelionNetworkError(
            `[Perihelion] ${operation} network error: ${e instanceof Error ? e.message : String(e)}`,
            operation,
            { cause: e },
          );
        }
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

function isTimeoutError(e: unknown): boolean {
  if (e instanceof PerihelionTimeoutError) return true;
  if (e instanceof Error) {
    if (e.name === "TimeoutError") return true;
    if (e.name === "AbortError" && e.message?.toLowerCase().includes("timed out")) return true;
  }
  return false;
}

function isAbortError(e: unknown): boolean {
  if (e instanceof PerihelionTimeoutError) return true;
  if (e instanceof Error) {
    return e.name === "AbortError" || e.name === "TimeoutError";
  }
  return false;
}

/**
 * Combine two optional AbortSignals so that either aborting aborts the result.
 * Returns undefined if both are undefined.
 * Uses AbortSignal.any for proper teardown of listeners.
 */
function combineSignals(
  a: AbortSignal | undefined,
  b: AbortSignal | undefined,
): AbortSignal | undefined {
  const signals = [a, b].filter((s): s is AbortSignal => s != null);
  if (signals.length === 0) return undefined;
  if (signals.length === 1) return signals[0];
  return AbortSignal.any(signals);
}
