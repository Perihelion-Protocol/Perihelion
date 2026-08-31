// SPDX-License-Identifier: MIT

import express, { type Request, Response, NextFunction } from "express";
import type { Server } from "node:http";
import { hashIntent, verifyIntent, perihelionDomain, parseIntent, isExpired } from "@perihelion/sdk";
import type { Hex, SignedIntent, Address } from "@perihelion/sdk";
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

    this.app.get("/healthz", read, (req: Request, res: Response) => {
      res.status(200).json({ status: "ok" });
    });
    this.app.get("/info", read, this.handleInfo.bind(this));
    this.app.post("/intents", write, this.handleSubmitIntent.bind(this));
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

  private handleUpdateStatus(req: Request, res: Response): void {
    if (this.statusToken) {
      const auth = req.header("authorization");
      if (auth !== `Bearer ${this.statusToken}`) {
        res.status(401).json({ error: "Missing or invalid status token" });
        return;
      }
    }

    const { hash } = req.params as { hash: Hex };
    const { status } = req.body as { status?: IntentStatus };

    if (!status || !INTENT_STATUSES.has(status)) {
      res.status(400).json({ error: `status must be one of ${[...INTENT_STATUSES].join(", ")}` });
      return;
    }

    if (!this.store.get(hash as Hex)) {
      res.status(404).json({ error: "Intent not found" });
      return;
    }

    const updated = this.store.updateStatus(hash as Hex, status);
    if (!updated) {
      res.status(409).json({ error: "Cannot change status of a terminal intent" });
      return;
    }

    res.json(this.store.get(hash as Hex));
  }

  /**
   * Builds middleware that rejects an IP once it exceeds `max` requests within
   * the configured sliding window. `bucket` keeps the read and write counters
   * separate so the two budgets are enforced independently.
   */
  private rateLimit(
    bucket: "read" | "write",
    max: number,
  ): (req: Request, res: Response, next: NextFunction) => void {
    return (req: Request, res: Response, next: NextFunction): void => {
      const key = `${bucket}:${req.ip ?? "unknown"}`;
      const now = Date.now();
      const recent = (this.rateLimitHits.get(key) ?? []).filter(
        (t) => now - t < this.rateLimitWindowMs,
      );

      if (recent.length >= max) {
        res.status(429).json({ error: "Too many requests" });
        return;
      }

      recent.push(now);
      this.rateLimitHits.set(key, recent);
      next();
    };
  }

  private async handleSubmitIntent(req: Request, res: Response): Promise<void> {
    try {
      const signed = req.body as SignedIntent;

      if (!signed.intent || !signed.signature || !SIGNATURE_RE.test(signed.signature)) {
        res.status(400).json({ error: "Missing or malformed intent or signature" });
        return;
      }

      // Cheap structural validation before the costly signature recovery below.
      let intent: SignedIntent["intent"];
      try {
        intent = parseIntent(signed.intent);
      } catch (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : "Invalid intent" });
        return;
      }

      if (isExpired(intent)) {
        res.status(400).json({ error: "Intent deadline has passed" });
        return;
      }

      if (signed.intent.sourceChainId !== this.domain.chainId) {
        res.status(400).json({
          error: `Chain ID mismatch: intent is for chain ${signed.intent.sourceChainId}, mempool is configured for chain ${this.domain.chainId}`,
        });
        return;
      }

      // Verify EIP-712 signature
      const isValid = await verifyIntent(intent, signed.signature, this.domain);
      if (!isValid) {
        res.status(400).json({ error: "Invalid signature" });
        return;
      }

      const hash = hashIntent(intent, this.domain);

      // Reject duplicate submissions rather than silently overwriting the
      // existing record (and its status).
      const existing = this.store.get(hash);
      if (existing) {
        res.status(409).json({ error: "Intent already exists", hash, status: existing.status });
        return;
      }

      const record: MempoolIntentRecord = {
        hash,
        intent,
        signature: signed.signature,
        status: "pending",
        createdAt: Math.floor(Date.now() / 1_000),
      };

      this.store.set(hash, record);
      res.json({ hash });
    } catch (err) {
      console.error("[mempool] submitIntent failed:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  }

  private handleGetIntent(req: Request, res: Response): void {
    const raw = String(req.params.hash ?? "").toLowerCase();
    if (!HASH_RE.test(raw)) {
      res.status(400).json({ error: "hash must be a 0x-prefixed 32-byte hex string" });
      return;
    }

    const record = this.store.get(raw as Hex);
    if (!record) {
      res.status(404).json({ error: "Intent not found" });
      return;
    }

    res.json(record);
  }

  private handleListIntents(req: Request, res: Response): void {
    // Every query parameter is validated the same strict way: a malformed
    // value is a 400 that names the parameter, never a silently-substituted
    // default (`limit`) or an empty page (`chainId`) that a caller cannot tell
    // apart from "nothing matched". A repeated parameter arrives as an array
    // rather than a string and is rejected on the `typeof` guard (#566, #348).

    const rawStatus = req.query.status;
    let status: IntentStatus | undefined;
    if (rawStatus !== undefined) {
      if (typeof rawStatus !== "string" || !INTENT_STATUSES.has(rawStatus)) {
        res.status(400).json({
          error: `status must be one of ${[...INTENT_STATUSES].join(", ")}`,
        });
        return;
      }
      status = rawStatus as IntentStatus;
    }

    let limit = DEFAULT_LIST_LIMIT;
    const rawLimit = req.query.limit;
    if (rawLimit !== undefined) {
      if (typeof rawLimit !== "string" || !/^\d+$/.test(rawLimit) || Number(rawLimit) === 0) {
        res.status(400).json({ error: "limit must be a positive integer" });
        return;
      }
      limit = Math.min(Number(rawLimit), MAX_LIST_LIMIT);
    }

    let chainId: number | undefined;
    const rawChainId = req.query.chainId;
    if (rawChainId !== undefined) {
      if (typeof rawChainId !== "string" || !/^\d+$/.test(rawChainId) || Number(rawChainId) === 0) {
        res.status(400).json({ error: "chainId must be a positive integer" });
        return;
      }
      chainId = Number(rawChainId);
    }

    const rawCursor = req.query.cursor;
    if (rawCursor !== undefined && typeof rawCursor !== "string") {
      res.status(400).json({ error: "cursor must be provided at most once" });
      return;
    }
    const cursor = rawCursor as Hex | undefined;

    const { records, nextCursor } = this.store.list({ status, chainId, cursor, limit });
    res.json({ records, nextCursor });
  }

  private handleInfo(_req: Request, res: Response): void {
    res.json({
      name: this.domain.name,
      version: this.domain.version,
      chainId: this.chainId,
      verifyingContract: this.verifyingContract,
    });
  }

  start(): Promise<void> {
    return new Promise((resolve) => {
      console.warn(
        "Mempool store is in-memory only: pending intents are lost on restart.",
      );
      if (!this.statusToken) {
        console.warn(
          "PATCH /intents/:hash/status is unauthenticated (no statusToken configured) — do not expose this port publicly.",
        );
      }
      this.sweepTimer = setInterval(() => this.store.evictExpired(), SWEEP_INTERVAL_MS);
      this.sweepTimer.unref?.();
      this.server = this.app.listen(this.port, this.host, () => {
        console.log(
          `Mempool server listening on http://${this.host}:${this.port} ` +
            `(chainId=${this.domain.chainId}, escrow=${this.domain.verifyingContract})`,
        );
        resolve();
      });
    });
  }

  /** Stop the HTTP listener. Resolves once the server has closed. */
  stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.sweepTimer) {
        clearInterval(this.sweepTimer);
        this.sweepTimer = undefined;
      }
      if (!this.server) {
        resolve();
        return;
      }
      this.server.close((err) => (err ? reject(err) : resolve()));
      this.server = undefined;
    });
  }

  updateStatus(hash: Hex, status: IntentStatus): boolean {
    return this.store.updateStatus(hash, status);
  }
}
