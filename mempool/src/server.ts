// SPDX-License-Identifier: MIT

import express, { type Request, Response, NextFunction } from "express";
import type { Server } from "node:http";
import {
  hashIntent,
  verifyIntent,
  perihelionDomain,
  parseIntent,
  isExpired,
} from "@perihelion/sdk";
import type { Hex, SignedIntent, Address, VerifyIntentOptions } from "@perihelion/sdk";
import { IntentStore } from "./store.js";
import type { MempoolIntentRecord, IntentStatus } from "./types.js";

const SIGNATURE_RE = /^0x[0-9a-fA-F]+$/;

/** Maximum accepted JSON request body. The label is echoed in the 413 message. */
const MAX_BODY_LABEL = "8kb";

/** Default per-IP rate-limit budgets; each is overridable via {@link MempoolServerOptions}. */
const DEFAULT_RATE_LIMIT_WINDOW_MS = 60_000;
const DEFAULT_WRITE_RATE_LIMIT = 60;
const DEFAULT_READ_RATE_LIMIT = 600;

/** A canonical intent hash: `0x` followed by exactly 64 lowercase hex chars. */
const HASH_RE = /^0x[0-9a-f]{64}$/;

/**
 * The set of statuses the mempool assigns.
 * Derived from {@link MempoolIntentStatus} (mempool/src/types.ts) and the SDK.
 * Validating against this set — rather than trusting the query string —
 * means a typo'd or repeated `status` filter fails loudly instead of
 * silently matching nothing.
 */
const INTENT_STATUSES: ReadonlySet<string> = new Set([
  "pending",
  "filled",
  "settled",
  "refunded",
  "expired",
]);

export interface MempoolServerOptions {
  port?: number;
  host?: string;
  /** EVM chain ID the escrow is deployed on. Binds the EIP-712 domain. Required. */
  chainId: number;
  /** PerihelionEscrow contract address. Binds the EIP-712 domain. Required. */
  verifyingContract: Address;
  /**
   * Shared bearer token required on `PATCH /intents/:hash/status`. Only
   * holders of this token (the relayer/solver) may report status changes.
   * If omitted, the endpoint is unauthenticated — fine for local dev/tests,
   * unsafe to expose publicly.
   */
  statusToken?: string;
  /**
   * Maximum number of records the in-memory store retains before evicting.
   * Defaults to the store's own default (50 000). Raise it for a busier
   * corridor so a fresh `pending` intent does not evict an unseen one.
   */
  maxStoreSize?: number;
  /**
   * Grace period (ms) past an intent's deadline before it is swept from the
   * store. Defaults to the store's own default (60 000). Raise it to keep a
   * record readable through the cross-chain settlement window.
   */
  expiryGraceMs?: number;
  /** Sliding window (ms) for per-IP rate limiting. Default 60 000. */
  rateLimitWindowMs?: number;
  /** Per-IP request budget within the window for write routes (POST/PATCH). Default 60. */
  writeRateLimit?: number;
  /** Per-IP request budget within the window for read routes (GET). Default 600. */
  readRateLimit?: number;
  /**
   * Optional viem `PublicClient` used to verify signatures from contract
   * wallets (ERC-1271). When omitted, contract-wallet intents are rejected
   * because their signatures cannot be checked with ECDSA alone.
   */
  client?: VerifyIntentOptions["client"];
}

const DEFAULT_LIST_LIMIT = 100;
const MAX_LIST_LIMIT = 1000;
const SWEEP_INTERVAL_MS = 30_000;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export class MempoolServer {
  private app = express();
  private store: IntentStore;
  private port: number;
  private host: string;
  private chainId: number;
  private verifyingContract: Address;
  private domain: ReturnType<typeof perihelionDomain>;
  private server?: Server;
  private rateLimitHits = new Map<string, number[]>();
  private rateLimitWindowMs: number;
  private writeRateLimit: number;
  private readRateLimit: number;
  private sweepTimer?: ReturnType<typeof setInterval>;
  private statusToken?: string;
  private client?: VerifyIntentOptions["client"];
  private isReady = false;
  private submissionStats = { accepted: 0, rejected: 0 };
  private rateLimitRejections = 0;

  constructor(opts: MempoolServerOptions) {
    if (opts.chainId === undefined || opts.chainId === null || Number.isNaN(opts.chainId)) {
      throw new Error("MempoolServer requires a chainId — omitting it defaults signature verification to no real domain.");
    }
    if (!opts.verifyingContract || opts.verifyingContract.toLowerCase() === ZERO_ADDRESS) {
      throw new Error(
        "MempoolServer requires a non-zero verifyingContract (escrow address) — the zero address verifies against no deployed contract.",
      );
    }
    this.port = opts.port ?? 3000;
    this.host = opts.host ?? "localhost";
    this.chainId = opts.chainId;
    this.verifyingContract = opts.verifyingContract;
    this.domain = perihelionDomain(this.chainId, this.verifyingContract);
    this.statusToken = opts.statusToken;
    this.client = opts.client;
    this.store = new IntentStore({
      maxSize: opts.maxStoreSize,
      expiryGraceMs: opts.expiryGraceMs,
    });
    this.rateLimitWindowMs = opts.rateLimitWindowMs ?? DEFAULT_RATE_LIMIT_WINDOW_MS;
    this.writeRateLimit = opts.writeRateLimit ?? DEFAULT_WRITE_RATE_LIMIT;
    this.readRateLimit = opts.readRateLimit ?? DEFAULT_READ_RATE_LIMIT;
    if (this.host !== "localhost" && this.host !== "127.0.0.1") {
      console.warn(
        `PERIHELION_MEMPOOL_HOST is set to ${this.host} — this endpoint has no write authentication and should not be exposed publicly.`,
      );
    }
    this.setupRoutes();
  }

  private setupRoutes(): void {
    this.app.use(express.json({ limit: MAX_BODY_LABEL }));

    // Every route carries a rate limit; reads and writes draw on separate
    // per-IP budgets so a burst of reads cannot starve the write path (and
    // vice versa).
    const read = this.rateLimit("read", this.readRateLimit);
    const write = this.rateLimit("write", this.writeRateLimit);

    this.app.get("/healthz", (req: Request, res: Response) => {
      res.status(200).json({ status: "ok" });
    });
    this.app.get("/readyz", (req: Request, res: Response) => {
      if (!this.isReady) {
        res.status(503).json({ status: "not ready", reason: "sweep timer not started" });
        return;
      }
      res.status(200).json({ status: "ready" });
    });
    this.app.get("/metrics", (req: Request, res: Response) => {
      res.setHeader("Content-Type", "text/plain; version=0.0.4");
      res.status(200).send(this.getPrometheusMetrics());
    });
    this.app.get("/info", read, this.handleInfo.bind(this));
    this.app.post("/intents", write, (req: Request, res: Response) => void this.handleSubmitIntent(req, res));
    this.app.get("/intents/:hash", read, this.handleGetIntent.bind(this));
    this.app.get("/intents", read, this.handleListIntents.bind(this));
    this.app.patch("/intents/:hash/status", write, this.handleUpdateStatus.bind(this));

    // An unmatched route or method returns the same JSON error shape as every
    // handler above, not Express's default HTML 404.
    this.app.use((_req: Request, res: Response) => {
      res.status(404).json({ error: "Not found" });
    });

    // Convert framework-generated errors — chiefly body-parser failures — into
    // the server's JSON error shape. Registered after the routes so it catches
    // errors forwarded from any middleware above. Without it, Express's default
    // handler replies with HTML (and, outside production, a stack trace).
    this.app.use(
      (err: unknown, _req: Request, res: Response, next: NextFunction): void => {
        if (res.headersSent) {
          next(err);
          return;
        }
        const e = (err ?? {}) as { type?: string; status?: number; statusCode?: number };
        if (e.type === "entity.too.large") {
          res
            .status(413)
            .json({ error: `Request body exceeds the ${MAX_BODY_LABEL} limit` });
          return;
        }
        if (
          e.type === "entity.parse.failed" ||
          e.type === "encoding.unsupported" ||
          e.type === "charset.unsupported" ||
          e.type === "request.aborted"
        ) {
          res.status(400).json({ error: "Malformed JSON request body" });
          return;
        }
        const status = e.status ?? e.statusCode;
        if (typeof status === "number" && status >= 400 && status < 500) {
          res.status(status).json({ error: "Bad request" });
          return;
        }
        console.error("[mempool] unhandled error:", err);
        res.status(500).json({ error: "Internal server error" });
      },
    );
  }

  /**
   * Normalise and validate a `:hash` path parameter. Records are keyed by the
   * lower-case hash `hashIntent` produces and {@link IntentStore} keys an exact
   * Map, so a mixed-case hash — from EIP-55 checksum habits or display tooling
   * that upper-cases hex — must be folded before lookup. Returns the canonical
   * hash, or sends a `400` and returns `undefined`. Shared by every route that
   * takes a `:hash` so the two cannot drift apart (#561).
   */
  private parseHashParam(req: Request, res: Response): Hex | undefined {
    const raw = req.params.hash;
    if (typeof raw !== "string" || !HASH_RE.test(raw.toLowerCase())) {
      res.status(400).json({ error: "Invalid intent hash" });
      return undefined;
    }
    return raw.toLowerCase() as Hex;
  }

  private rateLimit(kind: "read" | "write", limit: number) {
    return (req: Request, res: Response, next: NextFunction): void => {
      const now = Date.now();
      const key = `${kind}:${req.ip ?? "unknown"}`;
      const hits = (this.rateLimitHits.get(key) ?? []).filter(
        (t) => now - t < this.rateLimitWindowMs,
      );
      if (hits.length >= limit) {
        this.rateLimitRejections++;
        // Re-write the compacted (window-filtered) array so stale timestamps
        // don't accumulate while the key is still over budget.
        this.rateLimitHits.set(key, hits);
        res.status(429).json({ error: "Too many requests" });
        return;
      }
      hits.push(now);
      this.rateLimitHits.set(key, hits);
      next();
    };
  }

  /**
   * Prune every entry in the rate-limit map whose timestamp array is entirely
   * outside the current window. Called from the sweep timer so stale keys are
   * reclaimed without waiting for the keyed IP to make another request.
   * Satisfies the acceptance criterion for #964: after the window elapses with
   * no traffic, `rateLimitHits.size` returns to zero.
   */
  private sweepRateLimitMap(): void {
    const now = Date.now();
    for (const [key, hits] of this.rateLimitHits) {
      const live = hits.filter((t) => now - t < this.rateLimitWindowMs);
      if (live.length === 0) {
        this.rateLimitHits.delete(key);
      } else {
        this.rateLimitHits.set(key, live);
      }
    }
  }

  /**
   * Exposed for testing only: returns the current number of entries in the
   * per-IP rate-limit map. Production code should not rely on this value.
   */
  get rateLimitMapSize(): number {
    return this.rateLimitHits.size;
  }

  /**
   * Exposed for testing only: directly update the status of a stored intent,
   * bypassing HTTP. Delegates to {@link IntentStore.updateStatus} and returns
   * its result (`true` if the record was found and updated, `false` if it was
   * not found or is in a terminal status). Production code should call
   * `PATCH /intents/:hash/status` instead.
   */
  updateStatus(hash: Hex, status: IntentStatus): boolean {
    return this.store.updateStatus(hash, status);
  }

  /**
   * Exposed for testing only: trigger an immediate sweep of the rate-limit
   * map, removing entries whose timestamp arrays are entirely outside the
   * current window. In production this is called automatically by the sweep
   * timer every {@link SWEEP_INTERVAL_MS}. Tests that use a short
   * `rateLimitWindowMs` can call this directly instead of waiting 30 s.
   */
  sweepRateLimits(): void {
    this.sweepRateLimitMap();
  }

  private handleInfo(_req: Request, res: Response): void {
    res.status(200).json({
      chainId: this.chainId,
      verifyingContract: this.verifyingContract,
      domain: this.domain,
    });
  }

  private async handleSubmitIntent(req: Request, res: Response): Promise<void> {
    const body = req.body as Partial<SignedIntent> | undefined;
    if (!body || typeof body !== "object") {
      this.submissionStats.rejected++;
      res.status(400).json({ error: "Missing request body" });
      return;
    }
    const { intent, signature } = body;
    if (!intent || typeof intent !== "object") {
      this.submissionStats.rejected++;
      res.status(400).json({ error: "Missing intent" });
      return;
    }
    if (typeof signature !== "string" || !SIGNATURE_RE.test(signature)) {
      this.submissionStats.rejected++;
      res.status(400).json({ error: "Invalid signature" });
      return;
    }
    let parsed;
    try {
      parsed = parseIntent(intent);
    } catch (err) {
      this.submissionStats.rejected++;
      res.status(400).json({ error: `Invalid intent: ${(err as Error).message}` });
      return;
    }
    if (isExpired(parsed)) {
      this.submissionStats.rejected++;
      res.status(400).json({ error: "Intent has expired" });
      return;
    }
    // verifyIntent is async: without the await the check below sees a Promise
    // (always truthy), so no signature would ever be rejected. A throw from
    // malformed input is treated as a failed verification, since Express 4 does
    // not forward rejected promises from async handlers.
    //
    // Contract wallets (Safe, ERC-4337 accounts) cannot produce an ECDSA
    // signature that recovers to their address, so their signatures are
    // checked through ERC-1271 `isValidSignature` over RPC instead. Without a
    // configured client the check fails closed.
    const signatureValid = await this.verifySignature(parsed, signature).catch(() => false);
    if (!signatureValid) {
      this.submissionStats.rejected++;
      res.status(400).json({ error: "Signature verification failed" });
      return;
    }
    const hash = hashIntent(parsed, this.domain);
    const existing = this.store.get(hash);
    if (existing) {
      // Re-submitting the exact same signed intent is a no-op. Return the
      // stored record (including its current status) so the caller can see
      // whether it has already been settled, refunded, etc. We never overwrite
      // an existing record from POST: doing so would reset terminal states such
      // as `settled` and `refunded` back to `pending`, reinjecting the intent
      // into every solver's order book and undoing replay protection.
      res.status(409).json(existing);
      return;
    }
    const record: MempoolIntentRecord = {
      hash,
      intent: parsed,
      signature: signature,
      status: "pending",
      createdAt: Math.floor(Date.now() / 1000),
    };
    this.store.set(hash, record);
    this.submissionStats.accepted++;
    res.status(201).json({ hash });
  }

  /**
   * Verify a submitted signature against the intent's user. EOA users keep the
   * pure ECDSA path; contract users are verified on-chain via ERC-1271. The
   * result is always awaited so a rejected verification is never mistaken for
   * a truthy Promise (#888).
   */
  private async verifySignature(intent: SignedIntent["intent"], signature: Hex): Promise<boolean> {
    return verifyIntent(intent, signature, this.domain, { client: this.client });
  }

  private handleGetIntent(req: Request, res: Response): void {
    const hash = this.parseHashParam(req, res);
    if (!hash) return;
    const record = this.store.get(hash);
    if (!record) {
      res.status(404).json({ error: "Intent not found" });
      return;
    }
    res.status(200).json(record);
  }

  private handleListIntents(req: Request, res: Response): void {
    const statusParam = req.query.status;
    let status: IntentStatus | undefined;
    if (statusParam !== undefined) {
      if (typeof statusParam !== "string" || !INTENT_STATUSES.has(statusParam)) {
        res.status(400).json({ error: "Invalid status filter" });
        return;
      }
      status = statusParam as IntentStatus;
    }

    const chainIdParam = req.query.chainId;
    let chainId: number | undefined;
    if (chainIdParam !== undefined) {
      const parsed = typeof chainIdParam === "string" ? Number(chainIdParam) : NaN;
      if (!Number.isInteger(parsed) || parsed < 1) {
        res.status(400).json({ error: "Invalid chainId filter" });
        return;
      }
      chainId = parsed;
    }

    const limitParam = req.query.limit;
    let limit = DEFAULT_LIST_LIMIT;
    if (limitParam !== undefined) {
      const parsed = typeof limitParam === "string" ? Number(limitParam) : NaN;
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_LIST_LIMIT) {
        res.status(400).json({ error: "Invalid limit" });
        return;
      }
      limit = parsed;
    }

    const cursorParam = req.query.cursor;
    let cursor: Hex | undefined;
    if (cursorParam !== undefined) {
      if (typeof cursorParam !== "string" || !HASH_RE.test(cursorParam.toLowerCase())) {
        res.status(400).json({ error: "Invalid cursor" });
        return;
      }
      cursor = cursorParam.toLowerCase() as Hex;
      // An unknown cursor is a client error, not an empty page: the caller is
      // paginating against a snapshot that no longer exists.
      if (!this.store.get(cursor)) {
        res.status(400).json({ error: "Invalid cursor" });
        return;
      }
    }

    const result = this.store.list({ status, chainId, cursor, limit });
    res.status(200).json(result);
  }

  private handleUpdateStatus(req: Request, res: Response): void {
    if (this.statusToken) {
      const auth = req.header("authorization");
      if (auth !== `Bearer ${this.statusToken}`) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }
    }
    const hash = this.parseHashParam(req, res);
    if (!hash) return;
    const body = req.body as { status?: unknown } | undefined;
    const status = body?.status;
    if (typeof status !== "string" || !INTENT_STATUSES.has(status)) {
      res.status(400).json({ error: "Invalid status" });
      return;
    }
    const updated = this.store.updateStatus(hash, status as IntentStatus);
    if (!updated) {
      res.status(404).json({ error: "Intent not found" });
      return;
    }
    res.status(200).json(updated);
  }

  private getPrometheusMetrics(): string {
    const records = this.store.all();
    const recordsByStatus = {
      pending: records.filter((r) => r.status === "pending").length,
      filled: records.filter((r) => r.status === "filled").length,
      settled: records.filter((r) => r.status === "settled").length,
      refunded: records.filter((r) => r.status === "refunded").length,
      expired: records.filter((r) => r.status === "expired").length,
    };

    const lines: string[] = [
      "# HELP mempool_store_size Total number of records in the store",
      "# TYPE mempool_store_size gauge",
      `mempool_store_size ${records.length}`,
      "# HELP mempool_store_pending_intents Number of pending intents",
      "# TYPE mempool_store_pending_intents gauge",
      `mempool_store_pending_intents ${recordsByStatus.pending}`,
      "# HELP mempool_store_filled_intents Number of filled intents (delivered on Stellar, awaiting source-chain release)",
      "# TYPE mempool_store_filled_intents gauge",
      `mempool_store_filled_intents ${recordsByStatus.filled}`,
      "# HELP mempool_store_settled_intents Number of settled intents",
      "# TYPE mempool_store_settled_intents gauge",
      `mempool_store_settled_intents ${recordsByStatus.settled}`,
      "# HELP mempool_store_refunded_intents Number of refunded intents",
      "# TYPE mempool_store_refunded_intents gauge",
      `mempool_store_refunded_intents ${recordsByStatus.refunded}`,
      "# HELP mempool_store_expired_intents Number of expired intents",
      "# TYPE mempool_store_expired_intents gauge",
      `mempool_store_expired_intents ${recordsByStatus.expired}`,
      "# HELP mempool_submissions_accepted Total number of accepted submissions",
      "# TYPE mempool_submissions_accepted counter",
      `mempool_submissions_accepted ${this.submissionStats.accepted}`,
      "# HELP mempool_submissions_rejected Total number of rejected submissions",
      "# TYPE mempool_submissions_rejected counter",
      `mempool_submissions_rejected ${this.submissionStats.rejected}`,
      "# HELP mempool_rate_limit_rejections Total number of rate-limit rejections",
      "# TYPE mempool_rate_limit_rejections counter",
      `mempool_rate_limit_rejections ${this.rateLimitRejections}`,
    ];

    return lines.join("\n") + "\n";
  }

  async start(): Promise<void> {
    if (this.server) return;
    this.sweepTimer = setInterval(() => {
      this.store.evictExpired();
      this.sweepRateLimitMap();
    }, SWEEP_INTERVAL_MS);
    if (typeof this.sweepTimer.unref === "function") this.sweepTimer.unref();
    this.isReady = true;
    await new Promise<void>((resolve) => {
      this.server = this.app.listen(this.port, this.host, () => resolve());
    });
  }

  async stop(): Promise<void> {
    this.isReady = false;
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = undefined;
    }
    if (!this.server) return;
    const server = this.server;
    this.server = undefined;
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
}
