// SPDX-License-Identifier: MIT
import {
  Address,
  Contract,
  Keypair,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";

import type { PendingMessage, SourceWatcher } from "./types.js";
import { MessageType } from "./types.js";

/**
 * Configuration for {@link SorobanSourceWatcher}.
 */
export interface SorobanSourceWatcherConfig {
  /** Soroban RPC endpoint (e.g. `http://localhost:8000/soroban/rpc`). */
  rpcUrl: string;
  /** Network passphrase used to build/parse transactions. */
  networkPassphrase: string;
  /** Address of the settlement contract that emits outbound messages. */
  settlementContractId: string;
  /**
   * Address of the mock LayerZero endpoint on development networks. When set,
   * the watcher follows the endpoint's `PacketSent`-style events instead of the
   * settlement contract's own events.
   */
  mockEndpointContractId?: string;
  /** Optional keypair used to sign read-only simulations. */
  sourceKeypair?: Keypair;
  /** Ledger to start scanning from when no checkpoint is provided. */
  startLedger?: number;
  /** Maximum number of ledgers to scan per poll. */
  maxLedgersPerPoll?: number;
}

/**
 * Shape of a decoded outbound message emitted by the settlement contract (or
 * the mock endpoint standing in for LayerZero).
 */
interface OutboundMessageEvent {
  /** Message type discriminator, e.g. `FillConfirmed` or `CancelIntent`. */
  messageType: MessageType;
  /** Intent identifier the message refers to. */
  intentId: string;
  /** Raw payload bytes carried by the message. */
  payload: Uint8Array;
  /** Ledger sequence the event was observed in. */
  ledger: number;
  /** Transaction hash the event was observed in. */
  txHash: string;
}

/**
 * `SourceWatcher` implementation for the Soroban → EVM leg.
 *
 * The settlement contract dispatches `FillConfirmed` (to release the solver's
 * payment) and `CancelIntent` (to refund the user) through its endpoint. On
 * development networks the relayer stands in for LayerZero, so this watcher
 * polls the mock endpoint's events (or, when no endpoint is configured, the
 * settlement contract's own events) and decodes them into {@link PendingMessage}
 * objects that {@link EvmDestinationDelivery} can deliver to the escrow.
 *
 * In production this leg is handled by LayerZero executors and the watcher is
 * not used.
 */
export class SorobanSourceWatcher implements SourceWatcher {
  private readonly config: SorobanSourceWatcherConfig;
  private readonly server: rpc.Server;
  private readonly contractId: string;
  private readonly maxLedgersPerPoll: number;

  constructor(config: SorobanSourceWatcherConfig) {
    this.config = config;
    this.server = new rpc.Server(config.rpcUrl, {
      allowHttp: config.rpcUrl.startsWith("http://"),
    });
    this.contractId =
      config.mockEndpointContractId ?? config.settlementContractId;
    this.maxLedgersPerPoll = config.maxLedgersPerPoll ?? 100;
  }

  /**
   * Poll the source contract for outbound messages starting at `fromLedger`.
   *
   * Returns the decoded messages along with the ledger to resume from on the
   * next poll. The returned checkpoint is always `latestLedger + 1` so that
   * subsequent polls do not re-scan already-processed ledgers.
   */
  async poll(
    fromLedger?: number,
  ): Promise<{ messages: PendingMessage[]; nextLedger: number }> {
    const latest = await this.server.getLatestLedger();
    const latestLedger = latest.sequence;

    const startLedger = this.resolveStartLedger(fromLedger, latestLedger);
    if (startLedger > latestLedger) {
      return { messages: [], nextLedger: latestLedger + 1 };
    }

    const endLedger = Math.min(
      latestLedger,
      startLedger + this.maxLedgersPerPoll - 1,
    );

    const events = await this.fetchEvents(startLedger, endLedger);
    const decoded = events
      .map((event) => this.decodeEvent(event))
      .filter((event): event is OutboundMessageEvent => event !== undefined);

    const messages = decoded.map((event) => this.toPendingMessage(event));

    // If we did not reach the tip, resume right after the scanned window;
    // otherwise jump past the latest ledger.
    const nextLedger =
      endLedger < latestLedger ? endLedger + 1 : latestLedger + 1;

    return { messages, nextLedger };
  }

  private resolveStartLedger(
    fromLedger: number | undefined,
    latestLedger: number,
  ): number {
    if (fromLedger !== undefined && fromLedger > 0) {
      return fromLedger;
    }
    if (this.config.startLedger !== undefined) {
      return this.config.startLedger;
    }
    // Default to a small lookback window so a fresh relayer does not have to
    // scan the entire chain history.
    return Math.max(1, latestLedger - this.maxLedgersPerPoll + 1);
  }

  private async fetchEvents(
    startLedger: number,
    endLedger: number,
  ): Promise<rpc.Api.EventResponse[]> {
    const filters: rpc.Api.EventFilter[] = [
      {
        type: "contract",
        contractIds: [this.contractId],
      },
    ];

    // @stellar/stellar-sdk 12 has no `endLedger` request field, so the window
    // is bounded client-side: RPC returns events from `startLedger` onward and
    // anything above `endLedger` is dropped here, before the caller advances
    // its cursor to `endLedger + 1`.
    const response = await this.server.getEvents({
      startLedger,
      filters,
      limit: 200,
    });

    return (response.events ?? []).filter((event) => event.ledger <= endLedger);
  }

  /**
   * Decode a single contract event into an {@link OutboundMessageEvent}.
   *
   * Supports two layouts:
   *  - The mock endpoint's `PacketSent`-style event, whose topics are
   *    `["packet_sent", messageType]` and whose value is the payload bytes.
   *  - The settlement contract's own event, whose topics are
   *    `[messageType, intentId]` and whose value is the payload bytes.
   *
   * Returns `undefined` for events that do not represent an outbound message.
   */
  private decodeEvent(
    event: rpc.Api.EventResponse,
  ): OutboundMessageEvent | undefined {
    const topics = (event.topic ?? []).map((topic) => this.safeScValToNative(topic));
    if (topics.length === 0) {
      return undefined;
    }

    const value = this.safeScValToNative(event.value);

    // Mock endpoint layout: ["packet_sent", messageType, intentId?]
    if (topics[0] === "packet_sent" || topics[0] === "PacketSent") {
      const messageType = this.parseMessageType(topics[1]);
      if (messageType === undefined) {
        return undefined;
      }
      const intentId = this.extractIntentId(topics[2], value);
      const payload = this.extractPayload(value);
      if (intentId === undefined || payload === undefined) {
        return undefined;
      }
      return {
        messageType,
        intentId,
        payload,
        ledger: event.ledger,
        txHash: event.txHash,
      };
    }

    // Settlement contract layout: [messageType, intentId]
    const messageType = this.parseMessageType(topics[0]);
    if (messageType === undefined) {
      return undefined;
    }
    const intentId = this.extractIntentId(topics[1], value);
    const payload = this.extractPayload(value);
    if (intentId === undefined || payload === undefined) {
      return undefined;
    }
    return {
      messageType,
      intentId,
      payload,
      ledger: event.ledger,
      txHash: event.txHash,
    };
  }

  private parseMessageType(raw: unknown): MessageType | undefined {
    if (raw === undefined || raw === null) {
      return undefined;
    }
    if (typeof raw === "number") {
      return this.messageTypeFromDiscriminant(raw);
    }
    if (typeof raw === "string") {
      const normalized = raw.toLowerCase();
      if (normalized === "fillconfirmed" || normalized === "fill_confirmed") {
        return MessageType.FillConfirmed;
      }
      if (normalized === "cancelintent" || normalized === "cancel_intent") {
        return MessageType.CancelIntent;
      }
      if (normalized === "locked") {
        return MessageType.Locked;
      }
    }
    return undefined;
  }

  private messageTypeFromDiscriminant(value: number): MessageType | undefined {
    switch (value) {
      case MessageType.Locked:
        return MessageType.Locked;
      case MessageType.FillConfirmed:
        return MessageType.FillConfirmed;
      case MessageType.CancelIntent:
        return MessageType.CancelIntent;
      default:
        return undefined;
    }
  }

  private extractIntentId(
    topicValue: unknown,
    value: unknown,
  ): string | undefined {
    const fromTopic = this.coerceIntentId(topicValue);
    if (fromTopic !== undefined) {
      return fromTopic;
    }
    if (value && typeof value === "object") {
      const record = value as Record<string, unknown>;
      const fromValue =
        this.coerceIntentId(record.intentId) ??
        this.coerceIntentId(record.intent_id) ??
        this.coerceIntentId(record.id);
      if (fromValue !== undefined) {
        return fromValue;
      }
    }
    return undefined;
  }

  private coerceIntentId(raw: unknown): string | undefined {
    if (raw === undefined || raw === null) {
      return undefined;
    }
    if (typeof raw === "string") {
      return raw;
    }
    if (typeof raw === "bigint") {
      return raw.toString();
    }
    if (typeof raw === "number") {
      return raw.toString();
    }
    if (raw instanceof Uint8Array) {
      return Buffer.from(raw).toString("hex");
    }
    if (raw instanceof Address) {
      return raw.toString();
    }
    return undefined;
  }

  /**
   * Extract the raw payload bytes from an event value.
   *
   * The value may be the payload directly (bytes / hex string) or a map
   * containing a `payload` field.
   */
  private extractPayload(value: unknown): Uint8Array | undefined {
    if (value === undefined || value === null) {
      return undefined;
    }
    if (value instanceof Uint8Array) {
      return value;
    }
    if (typeof value === "string") {
      return this.hexToBytes(value);
    }
    if (value && typeof value === "object") {
      const record = value as Record<string, unknown>;
      const nested = record.payload ?? record.data ?? record.message;
      if (nested !== undefined) {
        return this.extractPayload(nested);
      }
    }
    return undefined;
  }

  private hexToBytes(value: string): Uint8Array | undefined {
    const normalized = value.startsWith("0x") ? value.slice(2) : value;
    if (normalized.length === 0 || normalized.length % 2 !== 0) {
      return undefined;
    }
    if (!/^[0-9a-fA-F]+$/.test(normalized)) {
      return undefined;
    }
    return Uint8Array.from(Buffer.from(normalized, "hex"));
  }

  private toPendingMessage(event: OutboundMessageEvent): PendingMessage {
    const base: PendingMessage = {
      type: event.messageType,
      intentId: event.intentId,
      payload: event.payload,
      sourceLedger: event.ledger,
      sourceTxHash: event.txHash,
    };

    if (event.messageType === MessageType.CancelIntent) {
      const reason = this.decodeCancellationReason(event.payload);
      if (reason !== undefined) {
        base.cancellationReason = reason;
      }
    }

    return base;
  }

  /**
   * Decode the cancellation reason carried in a `CancelIntent` payload.
   *
   * The settlement contract encodes the reason as a single UTF-8 string in the
   * payload. If the payload is empty or not valid UTF-8, `undefined` is
   * returned and the delivery layer falls back to a default reason.
   */
  private decodeCancellationReason(payload: Uint8Array): string | undefined {
    if (payload.length === 0) {
      return undefined;
    }
    try {
      const decoded = Buffer.from(payload).toString("utf8");
      // Reject payloads that contain control characters, which indicates the
      // bytes are not a plain UTF-8 reason string.
      // eslint-disable-next-line no-control-regex
      if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(decoded)) {
        return undefined;
      }
      return decoded;
    } catch {
      return undefined;
    }
  }

  private safeScValToNative(value: xdr.ScVal | undefined): unknown {
    if (value === undefined) {
      return undefined;
    }
    try {
      return scValToNative(value);
    } catch {
      return undefined;
    }
  }

  /**
   * Build a read-only simulation of a contract call. Exposed for tests and for
   * callers that need to inspect contract state alongside event polling.
   */
  async simulateRead(
    method: string,
    args: xdr.ScVal[] = [],
  ): Promise<unknown> {
    const source = this.config.sourceKeypair;
    if (source === undefined) {
      throw new Error(
        "SorobanSourceWatcher.simulateRead requires a sourceKeypair",
      );
    }

    const contract = new Contract(this.config.settlementContractId);
    const operation = contract.call(method, ...args);

    const account = await this.server.getAccount(source.publicKey());
    const { TransactionBuilder } = await import("@stellar/stellar-sdk");
    const tx = new TransactionBuilder(account, {
      fee: "100",
      networkPassphrase: this.config.networkPassphrase,
    })
      .addOperation(operation)
      .setTimeout(30)
      .build();

    const simulation = await this.server.simulateTransaction(tx);
    if (rpc.Api.isSimulationError(simulation)) {
      throw new Error(`simulation failed: ${simulation.error}`);
    }
    const result = simulation.result?.retval;
    return result === undefined ? undefined : scValToNative(result);
  }

  /**
   * Helper to encode a string argument as an `ScVal`, useful for callers that
   * need to build arguments for {@link simulateRead}.
   */
  static stringArg(value: string): xdr.ScVal {
    return nativeToScVal(value, { type: "string" });
  }
}