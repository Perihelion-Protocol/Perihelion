// SPDX-License-Identifier: MIT

import express, { type Request, Response, NextFunction } from "express";
import type { Server } from "node:http";
import { hashIntent, verifyIntent, perihelionDomain, parseIntent, isExpired } from "@perihelion/sdk";
import type { Hex, SignedIntent, Address } from "@perihelion/sdk";
import { IntentStore } from "./store.js";
import type { MempoolIntentRecord, IntentStatus } from "./types.js";

const SIGNATURE_RE = /^0x[0-9a-fA-F]+$/;
/** Per-IP submission budget for POST /intents. */
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REQUESTS = 60;

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
}

const DEFAULT_LIST_LIMIT = 100;
const MAX_LIST_LIMIT = 1000;
const SWEEP_INTERVAL_MS = 30_000;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export class MempoolServer {
  private app = express();
  private store = new IntentStore();
  private port: number;
  private host: string;
  private chainId: number;
  private verifyingContract: Address;
  private domain: ReturnType<typeof perihelionDomain>;
  private server?: Server;
  private rateLimitHits = new Map<string, number[]>();
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
    if (this.host !== "localhost" && this.host !== "127.0.0.1") {
      console.warn(
        `PERIHELION_MEMPOOL_HOST is set to ${this.host} — this endpoint has no write authentication and should not be exposed publicly.`,
      );
    }
    this.setupRoutes();
  }

  private setupRoutes(): void {
    this.app.use(express.json({ limit: "8kb" }));

    this.app.get("/healthz", (req: Request, res: Response) => {
      res.status(200).json({ status: "ok" });
    });
    this.app.get("/info", this.handleInfo.bind(this));
    this.app.post("/intents", this.rateLimit.bind(this), this.handleSubmitIntent.bind(this));
    this.app.get("/intents/:hash", this.handleGetIntent.bind(this));
    this.app.get("/intents", this.handleListIntents.bind(this));
    this.app.patch("/intents/:hash/status", this.handleUpdateStatus.bind(this));
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

  /** Rejects an IP once it exceeds a fixed request budget within a sliding window. */
  private rateLimit(req: Request, res: Response, next: NextFunction): void {
    const ip = req.ip ?? "unknown";
    const now = Date.now();
    const recent = (this.rateLimitHits.get(ip) ?? []).filter(
      (t) => now - t < RATE_LIMIT_WINDOW_MS,
    );

    if (recent.length >= RATE_LIMIT_MAX_REQUESTS) {
      res.status(429).json({ error: "Too many requests" });
      return;
    }

    recent.push(now);
    this.rateLimitHits.set(ip, recent);
    next();
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
        createdAt: Date.now(),
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
    // Validate `status` against the canonical vocabulary before it reaches the
    // store, so a typo'd or repeated filter fails loudly instead of silently
    // matching nothing (#348).
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

    const cursor = typeof req.query.cursor === "string" ? req.query.cursor : undefined;
    const limitParam = Number(req.query.limit);
    const limit = Number.isInteger(limitParam) && limitParam > 0
      ? Math.min(limitParam, MAX_LIST_LIMIT)
      : DEFAULT_LIST_LIMIT;

    let records = this.store.all(status);

    // Optional source-chain filter, applied before pagination.
    const chainId = req.query.chainId;
    if (chainId !== undefined) {
      const chainIdNum = Number(chainId);
      records = records.filter((r) => r.intent.sourceChainId === chainIdNum);
    }

    const startIndex = cursor ? records.findIndex((r) => r.hash === cursor) + 1 : 0;
    const page = records.slice(startIndex, startIndex + limit);
    const nextCursor = startIndex + limit < records.length ? page[page.length - 1]?.hash : undefined;

    res.json({ records: page, nextCursor });
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
