// SPDX-License-Identifier: MIT

/**
 * EVM source watcher: polls the EVM escrow for `Locked` events and decodes
 * each into a `PendingMessage` for relay to the Soroban settlement contract.
 *
 * ## Event model
 *
 * When a solver calls `PerihelionEscrow.lock(intent, signature)`:
 *
 * 1. The escrow validates the intent, pulls the user's funds, and records a
 *    `Lock` storage entry.
 * 2. It emits `Locked(bytes32 indexed intentHash, address indexed solver,
 *    address indexed user, address asset, uint256 amount)`.
 * 3. It calls `endpoint.send(params, refundAddress)` with the encoded
 *    `FillInstruction` payload (227 bytes) directed to the Stellar settlement
 *    contract.
 *
 * The relayer must watch for `Locked` events and reconstruct the full
 * `BridgeMessage` so it can:
 *   - Confirm the lock reached sufficient depth.
 *   - Deliver the message to Soroban if LayerZero has not already done so
 *     (e.g., as a backup relay or during a DVN degraded state).
 *
 * ## Decoding strategy
 *
 * The `Locked` event carries `intentHash`, `solver`, `user`, `asset`, and
 * `amount`, but not the full intent fields needed by `BridgeMessage`
 * (`recipient`, `destAsset`, `minDestAmount`, `deadline`). Those are encoded
 * in the `FillInstruction` payload that the escrow passes to `endpoint.send`,
 * but the endpoint does not expose them in a log the relayer can cheaply read.
 *
 * The most reliable source is the escrow's `lock()` calldata: the full
 * `Intent` struct is the first argument, so decoding the transaction input
 * gives every field needed to reconstruct `BridgeMessage`.
 *
 * ### FillInstruction binary layout (canonical 227-byte format)
 * ```
 * offset  size  field
 * 0       1     PROTOCOL_VERSION (0x01)
 * 1       1     MSG_FILL_INSTRUCTION (0x01)
 * 2       32    intentHash
 * 34      4     reserved (uint32, always zero; the origin eid comes from transport)
 * 38      56    recipient (Stellar strkey, right-zero-padded)
 * 94      69    destAsset (asset identifier string, right-zero-padded)
 * 163     16    minDestAmount (uint128, non-negative)
 * 179     8     deadline (uint64)
 * 187     32    lockedSolver (EVM address, left-zero-padded)
 * 219     8     reservationWindow (uint64, zero for legacy EVM intents)
 *         ───
 *         227   total bytes
 * ```
 *
 * ## Nonce
 *
 * The LayerZero nonce for a `Locked` event is not carried by the `Locked`
 * event itself. The escrow's `lock()` transaction also emits a `PacketSent`
 * event from the LayerZero endpoint; its encoded packet header contains the
 * outbound nonce for the `(sender, dstEid, receiver)` path. The watcher decodes
 * that nonce from the transaction receipt. If the `PacketSent` event cannot be
 * found (e.g., the relayer is impersonating the endpoint during development),
 * the watcher falls back to a strictly increasing per-path counter that is
 * persisted with the checkpoint, so nonces never repeat and are never `0`.
 *
 * The log index is never used as the transport nonce: it repeats in every
 * block and is `0` for the first log, which the settlement contract rejects.
 */

import {
  createPublicClient,
  http,
  decodeAbiParameters,
  parseAbiParameters,
  type PublicClient,
  type Log,
  type Hex,
} from "viem";
import { noopLogger, type Logger } from "@perihelion/node-common";
import {
  FILL_INSTRUCTION_LENGTH,
  type BridgeMessage,
  type EndpointId,
  type EvmRefundObservation,
  type PendingMessage,
  type SourceWatcher,
} from "./types.js";

/** Build the exact canonical EVM FillInstruction payload used by the escrow. */
function canonicalFillInstruction(
  intentHash: Hex,
  solver: Hex,
  stellarEid: number,
  destination: string,
  destAsset: string,
  minDestAmount: bigint,
  deadline: bigint,
): Hex {
  if (!/^0x[0-9a-fA-F]{64}$/.test(intentHash)) throw new Error("invalid intent hash");
  if (!/^0x[0-9a-fA-F]{40}$/.test(solver)) throw new Error("invalid solver address");
  if (stellarEid < 0 || stellarEid > 0xffffffff) throw new Error("invalid destination eid");
  if (minDestAmount < 0n || minDestAmount > 0xffffffffffffffffffffffffffffffffn) {
    throw new Error("min destination amount does not fit uint128");
  }
  if (deadline < 0n || deadline > 0xffffffffffffffffn)
    throw new Error("deadline does not fit uint64");

  const recipient = Buffer.from(destination, "utf8");
  const asset = Buffer.from(destAsset, "utf8");
  if (recipient.length > 56 || asset.length > 69)
    throw new Error("canonical field exceeds wire width");

  const out = Buffer.alloc(FILL_INSTRUCTION_LENGTH);
  out[0] = 0x01;
  out[1] = 0x01;
  Buffer.from(intentHash.slice(2), "hex").copy(out, 2);
  // Offset 34 is `reserved` and must be zero; the escrow writes the same value (#1051).
  out.writeUInt32BE(0, 34);
  recipient.copy(out, 38);
  asset.copy(out, 94);
  Buffer.from(minDestAmount.toString(16).padStart(32, "0"), "hex").copy(out, 163);
  Buffer.from(deadline.toString(16).padStart(16, "0"), "hex").copy(out, 179);
  // Canonical locking solver is a left-padded bytes32 EVM address.
  Buffer.from(solver.slice(2), "hex").copy(out, 199);
  // reservation_window is currently zero until included in the signed EVM intent.
  return `0x${out.toString("hex")}`;
}

// ---------------------------------------------------------------------------
// ABIs
// ---------------------------------------------------------------------------

/**
 * Minimal ABI for the PerihelionEscrow `Locked` event.
 *
 * event Locked(
 *   bytes32 indexed intentHash,
 *   address indexed solver,
 *   address indexed user,
 *   address asset,
 *   uint256 amount,
 *   string destination,
 *   string destAsset,
 *   uint128 minDestAmount,
 *   uint64 deadline
 * )
 */
const LOCKED_EVENT_ABI = [
  {
    type: "event",
    name: "Locked",
    inputs: [
      { name: "intentHash", type: "bytes32", indexed: true },
      { name: "solver", type: "address", indexed: true },
      { name: "user", type: "address", indexed: true },
      { name: "asset", type: "address", indexed: false },
      { name: "amount", type: "uint256", indexed: false },
      { name: "destination", type: "string", indexed: false },
      { name: "destAsset", type: "string", indexed: false },
      { name: "minDestAmount", type: "uint128", indexed: false },
      { name: "deadline", type: "uint64", indexed: false },
    ],
  },
] as const;

/**
 * ABI parameters for decoding the non-indexed `Locked` event data:
 *   (address asset, uint256 amount, string destination, string destAsset, uint128 minDestAmount, uint64 deadline)
 */
const LOCKED_DATA_PARAMS = parseAbiParameters(
  "address asset, uint256 amount, string destination, string destAsset, uint128 minDestAmount, uint64 deadline",
);

/**
 * Minimal ABI for the LayerZero endpoint `PacketSent` event.
 *
 * event PacketSent(bytes encodedPayload, bytes options, address sendLibrary)
 *
 * `encodedPayload` is the full LayerZero packet: version (1) | nonce (8,
 * big-endian) | srcEid (4) | sender (32) | dstEid (4) | receiver (32) |
 * guid (32) | message. The outbound nonce for the path is bytes 1..9.
 */
const PACKET_SENT_EVENT_ABI = [
  {
    type: "event",
    name: "PacketSent",
    inputs: [
      { name: "encodedPayload", type: "bytes", indexed: false },
      { name: "options", type: "bytes", indexed: false },
      { name: "sendLibrary", type: "address", indexed: false },
    ],
  },
] as const;

/** ABI parameters for decoding `PacketSent` non-indexed data. */
const PACKET_SENT_DATA_PARAMS = parseAbiParameters(
  "bytes encodedPayload, bytes options, address sendLibrary",
);

/** Offset of the nonce field within the encoded LayerZero packet header. */
const PACKET_NONCE_OFFSET = 1;
/** Width of the nonce field within the encoded LayerZero packet header. */
const PACKET_NONCE_WIDTH = 8;

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** Configuration for EVMSourceWatcher. */
export interface EVMSourceWatcherConfig {
  /** EVM RPC endpoint URL. */
  rpcUrl: string;
  /** Address of the PerihelionEscrow contract on the source chain. */
  escrowAddress: string;
  /** LayerZero endpoint ID of the source chain (e.g., 30101 for Ethereum mainnet). */
  sourceEid: EndpointId;
  /** LayerZero endpoint ID of the destination chain (Stellar; e.g., 40161 for testnet). */
  stellarEid: EndpointId;
  /** Maximum block range per getLogs call (default 2000). Adapts downward on range errors. */
  maxBlockRange?: number;
  /** Receives watcher warnings (range halving, callback failures). Defaults to silent. */
  logger?: Logger;
  /**
   * Optional LayerZero endpoint address on the source chain. When set, the
   * watcher decodes the outbound nonce from the endpoint's `PacketSent` event
   * emitted in the same transaction as each `Locked` event.
   */
  endpointAddress?: string;
  /**
   * Optional persisted per-path nonce counter used when the `PacketSent`
   * nonce cannot be recovered (e.g., the relayer impersonates the endpoint).
   * The counter is strictly increasing and never returns `0`.
   */
  nonceCounter?: NonceCounter;
}

/**
 * Persisted, strictly increasing per-path nonce counter.
 *
 * Used only when the real LayerZero outbound nonce cannot be recovered from
 * the transaction. Implementations should persist the value alongside the
 * relayer checkpoint so it survives restarts.
 */
export interface NonceCounter {
  /** Return the next nonce for the given path. Must be strictly increasing and never `0`. */
  next(pathKey: string): Promise<bigint>;
}

// ---------------------------------------------------------------------------
// Watcher implementation
// ---------------------------------------------------------------------------

/**
 * Concrete SourceWatcher for EVM: polls the PerihelionEscrow for `Locked`
 * events and reconstructs `PendingMessage` objects for the relayer.
 *
 * Each `Locked` event corresponds to a solver calling `lock()`, which in the
 * same transaction dispatches a `FillInstruction` to the Stellar settlement
 * contract via LayerZero. The relayer monitors these events to track in-flight
 * fills and act as a backup delivery path.
 */
export class EVMSourceWatcher implements SourceWatcher {
  private readonly client: PublicClient;
  private readonly logger: Logger;
  private maxBlockRange: number;
  private readonly transactionFetchConcurrency = 10;
  private readonly transactionFetchTimeoutMs = 10_000;
  /** In-memory fallback counter used when no persisted counter is configured. */
  private readonly fallbackNonces = new Map<string, bigint>();

  constructor(private readonly config: EVMSourceWatcherConfig) {
    this.client = createPublicClient({
      transport: http(config.rpcUrl),
    });
    this.maxBlockRange = config.maxBlockRange ?? 2000;
    this.logger = config.logger ?? noopLogger;
  }

  async poll(
    fromBlock: number,
  ): Promise<{
    messages: PendingMessage[];
    head: number;
    headHash?: string;
    parentHash?: string;
    blockHeaders?: Array<{ number: number; hash: string; parentHash: string }>;
  }> {
    const currentBlock = await this.client.getBlockNumber();
    const head = Number(currentBlock);

    // Fetch the latest block for reorg-detection hashes.
    const latestBlock = await this.client.getBlock({ blockNumber: currentBlock });
    const headHash = latestBlock.hash ?? undefined;
    const parentHash = latestBlock.parentHash as string | undefined;

    // Query Locked events in chunked ranges to avoid provider limits.
    // Block numbers that emitted messages, accumulated across chunks; their
    // headers are fetched after the scan to enable reorg detection deeper
    // than a single block.
    const blocksWithMessages = new Set<number>();
    const messages: PendingMessage[] = [];
    let scanHead = fromBlock;

    while (scanHead <= head) {
      const toBlock = Math.min(scanHead + this.maxBlockRange - 1, head);
      let logs: Log[] = [];

      try {
        logs = await this.client.getLogs({
          address: this.config.escrowAddress as `0x${string}`,
          event: LOCKED_EVENT_ABI[0],
          fromBlock: BigInt(scanHead),
          toBlock: BigInt(toBlock),
        });
      } catch (err) {
        // Exponential backoff with range halving on provider errors
        if (this._isProviderRangeError(err)) {
          if (this.maxBlockRange <= 1) throw err;
          this.maxBlockRange = Math.max(1, Math.floor(this.maxBlockRange / 2));
          this.logger.warn("EVMSourceWatcher: provider range error, halving max block range", {
            newMaxBlockRange: this.maxBlockRange,
            err: String(err),
          });
          continue; // Retry this chunk with smaller range
        }
        throw err;
      }

      for (const log of logs) {
        if (log.blockNumber !== undefined && log.blockNumber !== null) {
          blocksWithMessages.add(Number(log.blockNumber));
        }
        const pending = await this.decodeLockedLogWithNonce(log);
        if (pending === null) {
          throw new Error(
            `Failed to decode Locked event in transaction ${log.transactionHash ?? "unknown"}`,
          );
        }
        messages.push(pending);
      }

      scanHead = toBlock + 1;
    }

    // Collect block headers for the blocks that emitted messages, so the
    // relayer can detect reorgs deeper than one block.
    const blockHeaders: Array<{ number: number; hash: string; parentHash: string }> = [];
    if (headHash !== undefined && parentHash !== undefined) {
      const headerTasks = [...blocksWithMessages].map((blockNum) => async () => {
        const block = await this._withTimeout(
          this.client.getBlock({ blockNumber: BigInt(blockNum) }),
          this.transactionFetchTimeoutMs,
        );
        if (!block.hash || !block.parentHash) return null;
        return {
          number: blockNum,
          hash: block.hash,
          parentHash: block.parentHash,
        };
      });
      const headers = await this._batchConcurrent(headerTasks, this.transactionFetchConcurrency);
      blockHeaders.push(
        ...headers.filter((header): header is NonNullable<typeof header> => header !== null),
      );
    }

    // Observe refund events on the source chain so the relayer can report
    // `refunded` to the mempool only when a real refund exists.
    await this.scanRefunds(fromBlock, head);

    return {
      messages,
      head,
      headHash,
      parentHash,
      blockHeaders: blockHeaders.length > 0 ? blockHeaders : undefined,
    };
  }

  /**
   * Scan the escrow for `Refunded` / `RefundedLocalTimeout` events and invoke
   * the configured `onRefund` callback for each one.
   *
   * The scan window starts at the greater of `fromBlock` and the last scanned
   * block, so repeated polls do not re-report the same refund. Callers that
   * need a full backfill can construct the watcher with a low `fromBlock`.
   */
  private async scanRefunds(fromBlock: number, head: number): Promise<void> {
    const onRefund = this.config.onRefund;
    if (!onRefund) return;

    const start =
      this.lastRefundScanBlock === null
        ? fromBlock
        : Math.max(fromBlock, this.lastRefundScanBlock + 1);
    if (start > head) return;

    let scanHead = start;
    while (scanHead <= head) {
      const toBlock = Math.min(scanHead + this.maxBlockRange - 1, head);
      let logs: Log[] = [];

      try {
        logs = await this.client.getLogs({
          address: this.config.escrowAddress as `0x${string}`,
          events: REFUND_EVENT_ABIS,
          fromBlock: BigInt(scanHead),
          toBlock: BigInt(toBlock),
        });
      } catch (err) {
        if (this._isProviderRangeError(err)) {
          if (this.maxBlockRange <= 1) throw err;
          this.maxBlockRange = Math.max(1, Math.floor(this.maxBlockRange / 2));
          this.logger.warn(
            "EVMSourceWatcher: provider range error during refund scan, halving max block range",
            {
              newMaxBlockRange: this.maxBlockRange,
              err: String(err),
            },
          );
          continue;
        }
        throw err;
      }

      for (const log of logs) {
        const observation = this.decodeRefundLog(log);
        if (observation === null) continue;
        try {
          await onRefund(observation);
        } catch (err) {
          this.logger.warn("EVMSourceWatcher: onRefund callback failed", {
            intentHash: observation.intentHash,
            err: String(err),
          });
        }
      }

      scanHead = toBlock + 1;
    }

    this.lastRefundScanBlock = head;
  }

  /**
   * Decode a `Refunded` / `RefundedLocalTimeout` log into an observation.
   * Returns `null` if the log does not carry a usable intent hash.
   */
  decodeRefundLog(log: Log): EvmRefundObservation | null {
    if (log.blockNumber === undefined || log.blockNumber === null) return null;
    const topics = log.topics as Hex[];
    if (!topics || topics.length < 2) return null;

    const intentHash = topics[1] as Hex;
    if (!/^0x[0-9a-fA-F]{64}$/.test(intentHash)) return null;

    const eventName = (log as { eventName?: string }).eventName;
    const kind: EvmRefundObservation["kind"] =
      eventName === "RefundedLocalTimeout" ? "RefundedLocalTimeout" : "Refunded";

    return {
      intentHash,
      kind,
      blockNumber: Number(log.blockNumber),
      transactionHash: (log.transactionHash ?? "0x") as Hex,
      logIndex: Number(log.logIndex ?? 0),
    };
  }

  private _isProviderRangeError(err: unknown): boolean {
    if (!(err instanceof Error)) return false;
    const msg = err.message.toLowerCase();
    return msg.includes("range") || msg.includes("too large") || msg.includes("limit");
  }

  private async _batchConcurrent<T>(
    tasks: Array<() => Promise<T>>,
    concurrency: number,
  ): Promise<T[]> {
    const results: T[] = new Array(tasks.length);
    let next = 0;

    const worker = async (): Promise<void> => {
      while (next < tasks.length) {
        const index = next++;
        results[index] = await tasks[index]!();
      }
    };

    await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker()));
    return results;
  }

  private async _withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<T>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`RPC request timed out after ${timeoutMs}ms`)),
            timeoutMs,
          );
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /**
   * Decode a `Locked` event and resolve its LayerZero transport nonce.
   *
   * The nonce is taken from the endpoint's `PacketSent` event in the same
   * transaction when available; otherwise a strictly increasing per-path
   * counter is used. The log index is never used as the nonce.
   */
  async decodeLockedLogWithNonce(log: Log): Promise<PendingMessage | null> {
    const base = this.decodeLockedLog(log);
    if (base === null) return null;

    const nonce = await this.resolveTransportNonce(log);
    return {
      ...base,
      message: { ...base.message, nonce },
    };
  }

  /**
   * Resolve the LayerZero outbound nonce for a `Locked` event.
   *
   * 1. If an endpoint address is configured, decode the `PacketSent` event
   *    emitted in the same transaction and read the nonce from the packet
   *    header.
   * 2. Otherwise (or if the event is missing), use the configured persisted
   *    per-path counter, or an in-memory fallback counter.
   */
  private async resolveTransportNonce(log: Log): Promise<number> {
    if (this.config.endpointAddress && log.transactionHash) {
      const nonce = await this.fetchPacketSentNonce(log.transactionHash as Hex);
      if (nonce !== null) return Number(nonce);
    }

    const pathKey = `${this.config.sourceEid}:${this.config.stellarEid}`;
    const next = this.config.nonceCounter
      ? await this.config.nonceCounter.next(pathKey)
      : this.nextFallbackNonce(pathKey);
    // The settlement contract rejects nonce 0; ensure the counter never yields it.
    return Number(next === 0n ? 1n : next);
  }

  /** Return the next strictly increasing fallback nonce for a path. */
  private nextFallbackNonce(pathKey: string): bigint {
    const current = this.fallbackNonces.get(pathKey) ?? 0n;
    const next = current + 1n;
    this.fallbackNonces.set(pathKey, next);
    return next;
  }

  /**
   * Fetch the transaction receipt and decode the LayerZero outbound nonce from
   * the endpoint's `PacketSent` event. Returns `null` if the event is absent or
   * cannot be decoded.
   */
  private async fetchPacketSentNonce(txHash: Hex): Promise<bigint | null> {
    let receipt: Awaited<ReturnType<PublicClient["getTransactionReceipt"]>>;
    try {
      receipt = await this._withTimeout(
        this.client.getTransactionReceipt({ hash: txHash }),
        this.transactionFetchTimeoutMs,
      );
    } catch {
      return null;
    }

    const endpoint = this.config.endpointAddress!.toLowerCase();
    for (const receiptLog of receipt.logs) {
      if (receiptLog.address.toLowerCase() !== endpoint) continue;
      // topics[0] is the PacketSent event signature; all fields are non-indexed.
      if (!receiptLog.topics || receiptLog.topics.length < 1) continue;
      try {
        const [encodedPayload] = decodeAbiParameters(PACKET_SENT_DATA_PARAMS, receiptLog.data);
        const nonce = decodePacketNonce(encodedPayload);
        if (nonce !== null) return nonce;
      } catch {
        // Not a PacketSent log or malformed payload; keep scanning.
      }
    }
    return null;
  }

  /**
   * Decode a single `Locked` event log into a `PendingMessage`.
   *
   * Strategy:
   * 1. Extract indexed fields (`intentHash`, `solver`, `user`) from the log
   *    topics.
   * 2. Decode non-indexed fields (`asset`, `amount`, `destination`, `destAsset`,
   *    `minDestAmount`, `deadline`) directly from `log.data`.
   * 3. Assemble a `BridgeMessage` and wrap it in a `PendingMessage`.
   *
   * The `nonce` field is a placeholder here; callers should use
   * `decodeLockedLogWithNonce` to resolve the real LayerZero transport nonce.
   */
  decodeLockedLog(log: Log): PendingMessage | null {
    if (!log.blockNumber) return null;

    // --- Indexed topics ---
    // topics[0] = event sig, [1] = intentHash, [2] = solver, [3] = user
    const topics = log.topics as Hex[];
    if (!topics || topics.length < 4) return null;

    const intentHash = topics[1] as Hex; // bytes32
    const solver = ("0x" + topics[2]?.slice(26)) as Hex; // address from 32-byte word
    // user topic available for future use

    // --- Non-indexed data ---
    let destination: string;
    let destAsset: string;
    let minDestAmount: bigint;
    let deadline: bigint;
    try {
      const [, , dst, assetStr, minDest, deadlineValue] = decodeAbiParameters(
        LOCKED_DATA_PARAMS,
        log.data,
      );
      destination = dst;
      destAsset = assetStr;
      minDestAmount = minDest;
      deadline = deadlineValue;
    } catch {
      return null;
    }

    // --- Assemble BridgeMessage ---
    // The nonce is resolved by `decodeLockedLogWithNonce`; the log index is
    // never used because it repeats across blocks and is 0 for the first log.
    const message: BridgeMessage = {
      srcEid: this.config.sourceEid,
      dstEid: this.config.stellarEid,
      intentHash: intentHash,
      messageType: "FillInstruction",
      solver: solver,
      recipient: destination,
      destAsset: destAsset,
      amount: minDestAmount.toString(),
      deadline: deadline.toString(),
      nonce: 0,
      rawPayload: canonicalFillInstruction(
        intentHash,
        solver,
        this.config.stellarEid,
        destination,
        destAsset,
        minDestAmount,
        deadline,
      ),
    };

    return {
      message,
      srcTxHash: log.transactionHash ?? "",
      srcBlock: Number(log.blockNumber),
    };
  }

  /**
   * Decode a single `CancelIntent` event log into a `PendingMessage`.
   *
   * The cancellation `reason` code is decoded from the non-indexed event data
   * and carried on the `BridgeMessage` so delivery records the true cause
   * rather than a hard-coded default.
   */
  decodeCancelIntentLog(log: Log): PendingMessage | null {
    if (!log.blockNumber) return null;

    // topics[0] = event sig, [1] = intentHash, [2] = solver, [3] = user
    const topics = log.topics as Hex[];
    if (!topics || topics.length < 4) return null;

    const intentHash = topics[1] as Hex; // bytes32
    const solver = ("0x" + topics[2]?.slice(26)) as Hex; // address from 32-byte word

    let reason: number;
    try {
      const [reasonValue] = decodeAbiParameters(CANCEL_INTENT_DATA_PARAMS, log.data);
      reason = Number(reasonValue);
    } catch {
      return null;
    }

    const nonce = Number(log.logIndex ?? 0);

    const message: BridgeMessage = {
      srcEid: this.config.sourceEid,
      dstEid: this.config.stellarEid,
      intentHash: intentHash,
      messageType: "CancelInstruction",
      solver: solver,
      recipient: "",
      destAsset: "",
      amount: "0",
      nonce,
      reason,
      rawPayload: "0x",
    };

    return {
      message,
      srcTxHash: log.transactionHash ?? "",
      srcBlock: Number(log.blockNumber),
    };
  }
}

/**
 * Decode the outbound nonce from an encoded LayerZero packet header.
 *
 * Layout: version (1) | nonce (8, big-endian) | srcEid (4) | sender (32) |
 * dstEid (4) | receiver (32) | guid (32) | message.
 *
 * Returns `null` if the payload is too short to contain a nonce.
 */
function decodePacketNonce(encodedPayload: Hex): bigint | null {
  const hex = encodedPayload.startsWith("0x") ? encodedPayload.slice(2) : encodedPayload;
  const headerBytes = PACKET_NONCE_OFFSET + PACKET_NONCE_WIDTH;
  if (hex.length < headerBytes * 2) return null;
  const nonceHex = hex.slice(PACKET_NONCE_OFFSET * 2, headerBytes * 2);
  return BigInt(`0x${nonceHex}`);
}
