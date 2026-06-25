import express, { type Request, Response } from "express";
import { hashIntent, verifyIntent } from "@perihelion/sdk";
import type { Hex, SignedIntent } from "@perihelion/sdk";
import { IntentStore } from "./store.js";
import type { MempoolIntentRecord, IntentStatus } from "./types.js";

export interface MempoolServerOptions {
  port?: number;
  host?: string;
}

export class MempoolServer {
  private app = express();
  private store = new IntentStore();
  private port: number;
  private host: string;

  constructor(opts: MempoolServerOptions = {}) {
    this.port = opts.port ?? 3000;
    this.host = opts.host ?? "localhost";
    this.setupRoutes();
  }

  private setupRoutes(): void {
    this.app.use(express.json());

    this.app.post("/intents", this.handleSubmitIntent.bind(this));
    this.app.get("/intents/:hash", this.handleGetIntent.bind(this));
    this.app.get("/intents", this.handleListIntents.bind(this));
  }

  private async handleSubmitIntent(req: Request, res: Response): Promise<void> {
    try {
      const signed = req.body as SignedIntent;

      if (!signed.intent || !signed.signature) {
        res.status(400).json({ error: "Missing intent or signature" });
        return;
      }

      // Verify EIP-712 signature
      const isValid = await verifyIntent(signed.intent, signed.signature);
      if (!isValid) {
        res.status(400).json({ error: "Invalid signature" });
        return;
      }

      const hash = hashIntent(signed.intent);
      const record: MempoolIntentRecord = {
        hash,
        intent: signed.intent,
        signature: signed.signature,
        status: "pending",
        submittedAt: Date.now(),
      };

      this.store.set(hash, record);
      res.json({ hash });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  }

  private handleGetIntent(req: Request, res: Response): void {
    const { hash } = req.params as { hash: Hex };
    const record = this.store.get(hash as Hex);

    if (!record) {
      res.status(404).json({ error: "Intent not found" });
      return;
    }

    res.json(record);
  }

  private handleListIntents(req: Request, res: Response): void {
    const { status } = req.query as { status?: IntentStatus };

    let records = this.store.all();
    if (status) {
      records = records.filter((r) => r.status === status);
    }

    res.json(records);
  }

  start(): Promise<void> {
    return new Promise((resolve) => {
      this.app.listen(this.port, this.host, () => {
        console.log(`Mempool server listening on http://${this.host}:${this.port}`);
        resolve();
      });
    });
  }

  updateStatus(hash: Hex, status: IntentStatus): boolean {
    return this.store.updateStatus(hash, status);
  }
}
