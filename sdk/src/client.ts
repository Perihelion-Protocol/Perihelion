/**
 * Client for submitting intents to a Perihelion mempool and tracking status.
 *
 * The common integration path is three calls: sign an intent, submit it, then
 * poll (or `await`) until it settles.
 */

import type { TypedDataDomain, WalletClient } from "viem";
import { hashIntent, INTENT_TYPES, perihelionDomain } from "./intent.js";
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
  /** Override the fetch implementation (defaults to global `fetch`). */
  readonly fetch?: typeof fetch;
}

/** Thin client over a Perihelion mempool endpoint. */
export class PerihelionClient {
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;
  private readonly domain: TypedDataDomain;

  constructor(opts: ClientOptions) {
    this.base = opts.mempoolUrl.replace(/\/$/, "");
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
    this.domain = perihelionDomain(opts.chainId, opts.verifyingContract);
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
      message: {
        user: intent.user,
        destination: intent.destination,
        sourceChainId: BigInt(intent.sourceChainId),
        sourceAsset: intent.sourceAsset,
        sourceAmount: BigInt(intent.sourceAmount),
        destAsset: intent.destAsset,
        minDestAmount: BigInt(intent.minDestAmount),
        deadline: BigInt(intent.deadline),
        nonce: BigInt(intent.nonce),
        preferredSolver: intent.preferredSolver,
      },
    })) as Hex;
    return { intent, signature, hash: hashIntent(intent, this.domain) };
  }

  /** Submit a signed intent to the mempool. Returns its hash (id). */
  async submitIntent(signed: SignedIntent): Promise<Hex> {
    const res = await this.fetchImpl(`${this.base}/intents`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(signed),
    });
    if (!res.ok) {
      throw new Error(`submitIntent failed: ${res.status} ${await res.text()}`);
    }
    const body = (await res.json()) as { hash: Hex };
    return body.hash;
  }

  /** Fetch the current record for an intent by its hash. */
  async getIntent(hash: Hex): Promise<IntentRecord> {
    const res = await this.fetchImpl(`${this.base}/intents/${hash}`);
    if (!res.ok) {
      throw new Error(`getIntent failed: ${res.status} ${await res.text()}`);
    }
    return parseIntentRecord(await res.json());
  }

  /**
   * Poll until the intent reaches a terminal state (`settled`, `refunded`, or
   * `expired`) or the timeout elapses.
   *
   * @param opts.onStatus  Called on every status poll when the status changes.
   *                       Use this to surface progress to the user or react to
   *                       stalls (e.g. `claimed` but never advancing to `settling`
   *                       indicates a stuck relayer; `pending` throughout suggests
   *                       no solver picked up the intent).
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
    const deadline = Date.now() + (opts.timeoutMs ?? 5 * 60_000);
    const terminal = new Set(["settled", "refunded", "expired"]);
    let lastStatus: IntentRecord["status"] | undefined;
    for (;;) {
      const record = await this.getIntent(hash);
      if (record.status !== lastStatus) {
        lastStatus = record.status;
        opts.onStatus?.(record.status, record);
      }
      if (terminal.has(record.status)) return record;
      if (Date.now() > deadline) {
        throw Object.assign(
          new Error(
            `waitForSettlement timed out for ${hash} (last status: ${lastStatus ?? "unknown"})`,
          ),
          { lastStatus },
        );
      }
      await sleep(interval);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
