// SPDX-License-Identifier: MIT

import express, { type Request, Response, NextFunction } from "express";
import type { Server } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import {
  hashIntent,
  verifyIntent,
  perihelionDomain,
  parseIntent,
  isExpired,
  MAX_DEADLINE_HORIZON_SEC,
} from "@perihelion/sdk";
import type { Hex, SignedIntent, Address, VerifyIntentOptions } from "@perihelion/sdk";
import { IntentStore } from "./store.js";
import type { MempoolIntentRecord, IntentStatus } from "./types.js";

const SIGNATURE_RE = /^0x[0-9a-fA-F]+$/;

/**
 * Compare a presented `Authorization` header with the expected `Bearer <token>`
 * value in constant time (#965). Both sides are SHA-256 digested first, so the
 * inputs are always the same length, `timingSafeEqual` never throws on a
 * differently sized token, and the comparison time does not reveal how much of
 * the expected token a caller has guessed correctly.
 */
export function bearerTokenMatches(presented: string | undefined, expectedToken: string): boolean {
  if (presented === undefined) return false;
  const a = createHash("sha256").update(presented).digest();
  const b = createHash("sha256").update(`Bearer ${expectedToken}`).digest();
  return timingSafeEqual(a, b);
}

/**
 * Statuses reachable from each non-terminal status (#966). Terminal statuses
 * (`settled`, `refunded`, `expired`) have no outgoing edges, so any attempt to
 * move them is rejected with 409.
 */
const ALLOWED_TRANSITIONS: Partial<Record<IntentStatus, ReadonlySet<IntentStatus>>> = {
  pending: new Set<IntentStatus>(["filled", "settled", "refunded", "expired"]),
  filled: new Set<IntentStatus>(["settled", "refunded"]),
};

/** Failed status-token attempts allowed per client per rate-limit window (#965). */
const DEFAULT_AUTH_FAILURE_LIMIT = 10;

/**
 * Returns the reason a status change is not allowed, or `undefined` if it is.
 * `expired` is only valid once the intent's deadline has passed (#966).
 * Exported for unit tests.
 */
export function transitionRejection(
  record: MempoolIntentRecord,
  to: IntentStatus,
  nowSec: number = Math.floor(Date.now() / 1000),
): string | undefined {
  // Re-sending the current status is an idempotent no-op: relayers retry status
  // reports, and a retry must not fail just because the first one landed.
  if (record.status === to) return undefined;
  if (!ALLOWED_TRANSITIONS[record.status]?.has(to)) {
    return `Cannot change status from ${record.status} to ${to}`;
  }
  if (to === "expired" && record.intent.deadline > nowSec) {
    return "Intent cannot be marked expired before its deadline";
  }
  return undefined;
}

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
  /** Timestamps of failed status-token attempts per client IP (#965). */
  private authFailureHits = new Map<string, number[]>();
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
    // Warn on the absence of a status token, not on the bind host: a loopback
    // bind behind a reverse proxy is still reachable by remote callers, and a
    // configured token is authentication whatever the host (#966).
    if (!this.statusToken) {
      console.warn(
        `[mempool] no status token configured (host ${this.host}): PATCH /intents/:hash/status is unauthenticated. Set PERIHELION_MEMPOOL_STATUS_TOKEN before exposing this server.`,
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
        res.status(429).json({ error: "Too many requests" });
        return;
      }
      hits.push(now);
      this.rateLimitHits.set(key, hits);
      next();
    };
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
    // The EIP-712 domain binds signatures to this chain, but `sourceChainId` is a
    // separate field, so check it explicitly: an intent for another chain would
    // otherwise sit in this mempool where every solver must skip it (#967).
    if (parsed.sourceChainId !== this.chainId) {
      this.submissionStats.rejected++;
      res.status(400).json({
        error: `Invalid intent: sourceChainId must be ${this.chainId} for this mempool (got ${parsed.sourceChainId})`,
      });
      return;
    }
    // The SDK and the Soroban settlement contract both reject deadlines beyond
    // the horizon, so reject them at intake too (#967).
    if (parsed.deadline > Math.floor(Date.now() / 1000) + MAX_DEADLINE_HORIZON_SEC) {
      this.submissionStats.rejected++;
      res.status(400).json({
        error: `Invalid intent: deadline must be at most ${MAX_DEADLINE_HORIZON_SEC} seconds in the future`,
      });
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
      const key = req.ip ?? "unknown";
      if (this.authFailuresExhausted(key)) {
        this.rateLimitRejections++;
        res.status(429).json({ error: "Too many failed authentication attempts" });
        return;
      }
      if (!bearerTokenMatches(req.header("authorization"), this.statusToken)) {
        this.recordAuthFailure(key);
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
    const record = this.store.get(hash);
    if (!record) {
      res.status(404).json({ error: "Intent not found" });
      return;
    }
    const rejection = transitionRejection(record, status as IntentStatus);
    if (rejection) {
      res.status(409).json({ error: rejection });
      return;
    }
    if (record.status !== status) {
      this.store.updateStatus(hash, status as IntentStatus);
    }
    res.status(200).json(this.store.get(hash));
  }

  /** True once a client has used up its failed-authentication budget for the window. */
  private authFailuresExhausted(key: string): boolean {
    const now = Date.now();
    const hits = (this.authFailureHits.get(key) ?? []).filter(
      (t) => now - t < this.rateLimitWindowMs,
    );
    this.authFailureHits.set(key, hits);
    return hits.length >= DEFAULT_AUTH_FAILURE_LIMIT;
  }

  private recordAuthFailure(key: string): void {
    const hits = this.authFailureHits.get(key) ?? [];
    hits.push(Date.now());
    this.authFailureHits.set(key, hits);
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
