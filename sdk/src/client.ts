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
  PerihelionPaginationError,
  PerihelionTimeoutError,
  PerihelionValidationError,
} from "./errors.js";
import { parseIntentRecord, parseIntentRecordArray } from "./validate.js";

/** A 32-byte `0x`-prefixed intent hash, as accepted in mempool URLs. */
const INTENT_HASH_RE = /^0x[0-9a-fA-F]{64}$/;
import type {
  Address,
  Hex,
  Intent,
  IntentRecord,
  MempoolIntentStatus,
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
 * Default page size {@link PerihelionClient.listPending} requests explicitly
 * (issue #532). It equals the mempool server's default page size; the server
 * accepts any `limit` from 1 to 1000. Passing an explicit value (rather than
 * relying on the server's default) keeps page sizes bounded even against a
 * server whose own default changes or is misconfigured.
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
 *   Resubmitting an intent is not rejected: the mempool replies `201` and overwrites the stored
 *   record (resetting its status to `pending`), so a blind retry is not a safe no-op.
 * - **Reads ({@link getIntent}, {@link listPending}, {@link listPendingPage})**: Retry transient failures
 *   (network connection errors and 5xx HTTP responses) up to `maxRetries` times with exponential backoff.
 *   Timeouts and caller-initiated aborts are never retried.
 * - **Polling ({@link waitForSettlement})**: Repeatedly calls {@link getIntent} until a terminal status
 *   (`settled`, `refunded`, `expired`) is reached or `timeoutMs` elapses. The intermediate
 *   `filled` status (delivered on the destination chain, awaiting source-chain release) is
 *   **not** terminal, so polling continues through it.
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

  /**
   * Build the URL for an intent resource after checking that `hash` really is
   * a 32-byte `0x` hex string. `Hex` is only a compile-time type; a value from
   * JSON or user input such as `../admin` or `x?y=` would otherwise change the
   * request path or query, and `reportStatus` would attach its bearer token to
   * that URL. The hash is lower-cased and percent-encoded before use.
   */
  private intentUrl(method: string, hash: unknown, suffix = ""): string {
    if (typeof hash !== "string" || !INTENT_HASH_RE.test(hash)) {
      throw new PerihelionValidationError(
        `[Perihelion] ${method}: hash must be a 32-byte 0x-prefixed hex string, got: ${JSON.stringify(hash)}`,
        "hash",
      );
    }
    return new URL(`${this.base}/intents/${encodeURIComponent(hash.toLowerCase())}${suffix}`).toString();
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
    * **Retry policy**: Does NOT retry automatically. Resubmitting an intent
    * with the same hash returns `409 Conflict`; the server keeps the existing
    * record unchanged, including its current status.
   *
   * The locally-computed `signed.hash` is treated as authoritative. If the
   * server echoes a different hash, {@link PerihelionHashMismatchError} is thrown.
   *
    * @throws {@link PerihelionHttpError} on non-2xx responses (e.g. 400 validation or
    *   signature failure, 409 duplicate intent, 413 oversized body, 429 rate limited).
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
   * Report a status transition for an intent (e.g. `"filled"`, `"settled"`).
   * `status` must be one of the {@link MempoolIntentStatus} values the mempool
   * accepts — `pending`, `filled`, `settled`, `refunded` or `expired` — anything
   * else is rejected with `400`.
   * Restricted server-side to holders of the mempool's shared status token —
   * intended for relayer/solver services, not end users.
   *
   * **Retry policy**: Does NOT retry automatically (PATCH updates intent state).
   *
   * @throws {@link PerihelionHttpError} on non-2xx responses (400 invalid hash or
   *   status, 401 unauthorized, 404 unknown intent or one already in a terminal
   *   status — `settled`, `refunded` or `expired` — 429 rate limited).
   * @throws {@link PerihelionTimeoutError} if the request exceeds `requestTimeoutMs`.
   * @throws {@link PerihelionNetworkError} on network / transport failure.
   */
  async reportStatus(hash: Hex, status: MempoolIntentStatus, statusToken: string): Promise<void> {
    const url = this.intentUrl("reportStatus", hash, "/status");
    let res: Response;
    try {
      res = await this.fetchWithTimeout(url, {
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
   * @throws {@link PerihelionValidationError} if `hash` is not a 32-byte hex string (no request is made).
   * @throws {@link PerihelionHttpError} on non-2xx responses (e.g. 404 not found).
   * @throws {@link PerihelionTimeoutError} if the request exceeds `requestTimeoutMs`.
   * @throws {@link PerihelionNetworkError} on non-retryable network failure.
   */
  async getIntent(hash: Hex, signal?: AbortSignal): Promise<IntentRecord> {
    const url = this.intentUrl("getIntent", hash);
    const res = await this.fetchWithRetry("getIntent", url, {}, signal);
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
    status: MempoolIntentStatus = "pending",
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
   *
   * @throws {@link PerihelionPaginationError} (`reason: "repeated_cursor"`) if the
   * server returns a cursor it already returned, which would otherwise loop
   * forever. Its `records` is empty, because every page was already yielded.
   */
  async *listPendingPages(
    status: MempoolIntentStatus = "pending",
    limit?: number,
  ): AsyncGenerator<IntentRecord[], void, unknown> {
    let cursor: string | undefined;
    const seen = new Set<string>();
    let pages = 0;
    do {
      const page: ListPendingPageResult = await this.listPendingPage(status, cursor, limit);
      pages++;
      yield page.records;
      cursor = page.nextCursor;
      if (cursor !== undefined) {
        if (seen.has(cursor)) {
          throw new PerihelionPaginationError("repeated_cursor", [], cursor, pages);
        }
        seen.add(cursor);
      }
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
   * Each page holds at most `limit` records (default {@link DEFAULT_LIST_LIMIT},
   * 100; the server accepts 1–1000 and rejects anything else with `400`), and
   * the server returns a `nextCursor` when more remain. This method accumulates all pages
   * so callers always see the full result set, regardless of how many intents
   * are in the mempool.
   *
   * It never returns a partial result silently. If `maxPages` pages (default
   * 100) have been fetched and the server still returns a `nextCursor`, or if
   * the server repeats a cursor it already returned (which would loop
   * forever), it throws {@link PerihelionPaginationError}. The error carries the
   * records fetched so far and the cursor to resume from.
   *
   * For callers that need explicit pagination control (e.g. a solver that wants
   * to rate-limit its own page fetches), use {@link listPendingPage} or {@link listPendingPages} directly.
   *
   * **Bounded requests**: every page request passes an explicit `limit` (default
   * {@link DEFAULT_LIST_LIMIT}) in the query string rather than relying on the
   * server's own default, so page size stays bounded end-to-end (issue #532).
   */
  async listPending(
    status: MempoolIntentStatus = "pending",
    maxPages = 100,
    limit: number = DEFAULT_LIST_LIMIT,
  ): Promise<IntentRecord[]> {
    const all: IntentRecord[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    let pages = 0;

    do {
      const page = await this.listPendingPage(status, cursor, limit);
      all.push(...page.records);
      cursor = page.nextCursor;
      pages++;
      if (cursor === undefined) break;
      if (seen.has(cursor)) {
        throw new PerihelionPaginationError("repeated_cursor", all, cursor, pages);
      }
      seen.add(cursor);
    } while (pages < maxPages);

    if (cursor !== undefined) {
      throw new PerihelionPaginationError("max_pages", all, cursor, pages);
    }
    return all;
  }

  /**
   * Poll until the intent reaches a terminal state (`settled`, `refunded`, or
   * `expired`) or the timeout elapses.
   *
   * The intermediate `filled` status is **not** terminal: it means the intent
   * has been delivered on the destination chain but the source chain has not
   * yet released the escrowed funds. Polling continues through `filled` until
   * the record becomes `settled` (source-chain `Released` observed) or another
   * terminal state is reached.
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
   * **Off-chain hint only** — estimate from a mempool record whether the
   * intent looks refundable via `cancelExpired` (issue #175).
   *
   * Do not use this to decide whether to call `cancelExpired`. Mempool
   * statuses are best-effort reports from relayers and solvers, and the status
   * endpoint is unauthenticated unless the operator configures a token. A wrong
   * or malicious `settled` report hides a refundable lock, and a stale
   * `pending` after an on-chain release suggests a call that will revert. Use
   * {@link PerihelionEscrowClient.isRefundable} (or
   * {@link PerihelionEscrowClient.refundStatus}), which reads the escrow's
   * `locks` record, `confirmationGrace` and block time and mirrors
   * `cancelExpired`'s checks exactly.
   *
   * This hint returns `true` when both conditions hold:
   * 1. The mempool status is still `'pending'`. Every other
   *    {@link MempoolIntentStatus} is treated as not refundable: `filled`
   *    means the intent was delivered on the destination chain and is awaiting
   *    source-chain release, `settled` and `refunded` are terminal, and
   *    `expired` indicates the record has diverged from the refund path.
   * 2. Its deadline has passed **and** the confirmation grace period has elapsed.
   *
   * It is useful for cheaply filtering a list of records (e.g. in a UI) before
   * confirming each candidate on-chain.
   *
   * ```ts
   * const record = await client.waitForSettlement(hash);
   * const grace = await escrowClient.confirmationGrace(); // bigint seconds
   * if (client.isRefundable(record, Number(grace) * 1_000)) {
   *   // Hint only: confirm on-chain before sending the transaction.
   *   if (await escrowClient.isRefundable(hash)) await escrowClient.cancelExpired(hash);
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
   * @param now Current time in unix seconds. Defaults to the local clock, but
   *   pass chain time here when available to avoid client-clock disagreements
   *   with the on-chain `block.timestamp` check that `cancelExpired` performs.
   * @param clockSkew Seconds to bias toward "not yet refundable" near the
   *   boundary, mirroring {@link isExpired}'s `clockSkew` parameter. Useful
   *   when `now` comes from a client clock that may run fast.
   *   Default: `0`.
   * @returns `true` if the mempool record suggests the intent is refundable.
   *
   * @see {PerihelionEscrowClient.isRefundable} for the authoritative on-chain check.
   * @see {PerihelionEscrowClient.confirmationGrace} to read the live grace period.
   */
  isRefundable(
    record: IntentRecord,
    confirmationGraceMs: number,
    now: number = Math.floor(Date.now() / 1_000),
    clockSkew = 0,
  ): boolean {
    // Condition 3: only 'pending' intents are candidates — no settlement is
    // in progress or has already completed. This excludes 'filled', which has
    // been delivered on the destination chain and is awaiting source-chain
    // release and must not be treated as refundable purely on elapsed time.
    if (record.status !== "pending") {
      return false;
    }
    // Conditions 1 & 2: deadline + grace must have passed (unix seconds).
    const deadlineWithGrace = record.intent.deadline + Math.floor(confirmationGraceMs / 1_000);
    return now - clockSkew >= deadlineWithGrace;
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
