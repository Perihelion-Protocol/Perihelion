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
 * 34      4     stellarEid (uint32, big-endian)
 * 38      56    recipient (Stellar strkey, right-zero-padded)
 * 94      69    destAsset (asset identifier string, right-zero-padded)
 * 163     16    minDestAmount (uint128, non-negative)
 * 179     8     deadline (uint64)
 * 187     32    preferredSolver (EVM address, left-zero-padded)
 * 219     8     reservationWindow (uint64, zero for legacy EVM intents)
 *         ───
 *         227   total bytes
 * ```
 *
 * ## Nonce
 *
 * The LayerZero nonce for a `Locked` event is not directly available from the
 * `Locked` event itself. A production implementation should correlate with the
 * `PacketSent` event emitted by the LayerZero endpoint in the same transaction,
 * or query the endpoint's `outboundNonce` view. For this implementation we use
 * the log index as a proxy nonce, which is sufficient for dedup within a single
 * block but not for cross-restart ordering. Operators requiring strict nonce
 * ordering should integrate with the LayerZero endpoint directly.
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
import type { SourceWatcher } from "./relayer.js";
import type { BridgeMessage, PendingMessage, EndpointId } from "./types.js";

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
 *   uint256 amount
 * )
 */
const LOCKED_EVENT_ABI = [
  {
    type: "event",
    name: "Locked",
    inputs: [
      { name: "intentHash", type: "bytes32", indexed: true },
      { name: "solver",     type: "address", indexed: true },
      { name: "user",       type: "address", indexed: true },
      { name: "asset",      type: "address", indexed: false },
      { name: "amount",     type: "uint256", indexed: false },
    ],
  },
] as const;

/**
 * ABI parameters for decoding the non-indexed `Locked` event data:
 *   (address asset, uint256 amount)
 */
const LOCKED_DATA_PARAMS = parseAbiParameters("address asset, uint256 amount");

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
  private maxBlockRange: number;
  private readonly transactionFetchConcurrency = 10;
  private readonly transactionFetchTimeoutMs = 10_000;

  constructor(private readonly config: EVMSourceWatcherConfig) {
    this.client = createPublicClient({
      transport: http(config.rpcUrl),
    });
    this.maxBlockRange = config.maxBlockRange ?? 2000;
  }

  async poll(
    fromBlock: number,
  ): Promise<{ messages: PendingMessage[]; head: number; headHash?: string; parentHash?: string; blockHeaders?: Array<{ number: number; hash: string; parentHash: string }> }> {
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
          console.warn("EVMSourceWatcher: provider range error, halving max block range", {
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
      }

      // Batch decode with concurrency-limited transaction fetches.
      const pendingDecodings = logs.map((log) => this.decodeLockedLog(log));
      const decodedMessages = await this._batchConcurrent(
        pendingDecodings,
        this.transactionFetchConcurrency,
      );

      for (const pending of decodedMessages) {
        if (pending !== null) {
          messages.push(pending);
        }
      }

      scanHead = toBlock + 1;
    }

    // Collect block headers for the blocks that emitted messages, so the
    // relayer can detect reorgs deeper than one block.
    const blockHeaders: Array<{ number: number; hash: string; parentHash: string }> = [];
    if (headHash !== undefined && parentHash !== undefined) {
      for (const blockNum of blocksWithMessages) {
        try {
          const block = await this.client.getBlock({ blockNumber: BigInt(blockNum) });
          if (block.hash && block.parentHash) {
            blockHeaders.push({
              number: blockNum,
              hash: block.hash,
              parentHash: block.parentHash as string,
            });
          }
        } catch {
          // If we can't fetch a block's header, skip it; reorg detection
          // degrades gracefully but continues.
        }
      }
    }

    return { messages, head, headHash, parentHash, blockHeaders: blockHeaders.length > 0 ? blockHeaders : undefined };
  }

  private _isProviderRangeError(err: unknown): boolean {
    if (!(err instanceof Error)) return false;
    const msg = err.message.toLowerCase();
    return msg.includes("range") || msg.includes("too large") || msg.includes("limit");
  }

  private async _batchConcurrent<T>(
    promises: Promise<T>[],
    concurrency: number,
  ): Promise<T[]> {
    const results: T[] = [];
    for (let i = 0; i < promises.length; i += concurrency) {
      const batch = promises.slice(i, i + concurrency);
      const batchResults = await Promise.allSettled(batch);
      for (const result of batchResults) {
        if (result.status === "fulfilled") {
          results.push(result.value);
        } else {
          console.error("EVMSourceWatcher: error in concurrent batch", { err: result.reason });
          results.push(null as any);
        }
      }
    }
    return results;
  }

  /**
   * Decode a single `Locked` event log into a `PendingMessage`.
   *
   * Strategy:
   * 1. Extract indexed fields (`intentHash`, `solver`, `user`) from the log
   *    topics.
   * 2. Decode non-indexed fields (`asset`, `amount`) from `log.data`.
   * 3. Fetch the originating transaction and decode the `lock(intent, sig)`
   *    calldata to obtain the full `Intent` struct fields (`destination`,
   *    `destAsset`, `minDestAmount`, `deadline`).
   * 4. Assemble a `BridgeMessage` and wrap it in a `PendingMessage`.
   */
  private async decodeLockedLog(log: Log): Promise<PendingMessage | null> {
    if (!log.transactionHash || !log.blockNumber) return null;

    // --- Indexed topics ---
    // topics[0] = event sig, [1] = intentHash, [2] = solver, [3] = user
    const topics = log.topics as Hex[];
    if (!topics || topics.length < 4) return null;

    const intentHash = topics[1] as Hex; // bytes32
    const solver     = ("0x" + topics[2]?.slice(26)) as Hex; // address from 32-byte word
    // user topic available for future use

    // --- Non-indexed data ---
    // The data field is ABI-encoded (address asset, uint256 amount)
    // but since asset is fixed-size and amount is fixed-size, we can
    // use parseAbiParameters for a clean decode.
    let _asset: string;
    let _amount: bigint;
    try {
      const [asset, amount] = decodeAbiParameters(LOCKED_DATA_PARAMS, log.data as Hex);
      _asset  = asset as string;
      _amount = amount as bigint;
    } catch {
      return null;
    }

    // --- Fetch transaction and decode lock() calldata ---
    const tx = await this.client.getTransaction({ hash: log.transactionHash });
    if (!tx?.input || tx.input.length < 10) return null;

    // lock(Intent,bytes) selector = first 4 bytes of keccak256("lock((address,string,uint256,address,uint256,string,uint256,uint256,uint256,address),bytes)")
    // We skip selector (first 4 bytes) and decode the tuple + bytes.
    // The calldata is: selector(4) + abi.encode(Intent tuple, bytes signature)
    // We decode the tuple portion.
    let intentFields: {
      user: string;
      destination: string;
      sourceChainId: bigint;
      sourceAsset: string;
      sourceAmount: bigint;
      destAsset: string;
      minDestAmount: bigint;
      deadline: bigint;
      nonce: bigint;
      preferredSolver: string;
    };

    try {
      // Skip the 4-byte selector, then decode.
      // The calldata encodes (Intent intent, bytes signature) as a tuple.
      // abi.encode packs the Intent struct then the bytes offset+data.
      // We use the full tuple ABI for the Intent struct:
      const calldataWithoutSelector = ("0x" + tx.input.slice(10)) as Hex;

      // Decode as (tuple Intent, bytes signature)
      const decoded = decodeAbiParameters(
        parseAbiParameters(
          "(address user, string destination, uint256 sourceChainId, address sourceAsset, uint256 sourceAmount, string destAsset, uint256 minDestAmount, uint256 deadline, uint256 nonce, address preferredSolver) intent, bytes signature",
        ),
        calldataWithoutSelector,
      );

      const intent = decoded[0] as typeof intentFields;
      intentFields = {
        user: intent.user,
        destination: intent.destination,
        sourceChainId: intent.sourceChainId,
        sourceAsset: intent.sourceAsset,
        sourceAmount: intent.sourceAmount,
        destAsset: intent.destAsset,
        minDestAmount: intent.minDestAmount,
        deadline: intent.deadline,
        nonce: intent.nonce,
        preferredSolver: intent.preferredSolver,
      };
    } catch {
      // Calldata decode failed — possibly a different call or proxy wrapper.
      return null;
    }

    // --- Assemble BridgeMessage ---
    // The nonce used here is the log index within the block, which provides
    // uniqueness within a block. A production integration should correlate with
    // the LayerZero endpoint nonce from the same transaction's PacketSent event.
    const nonce = Number(log.logIndex ?? 0);

    const message: BridgeMessage = {
      srcEid: this.config.sourceEid,
      dstEid: this.config.stellarEid,
      intentHash: intentHash as Hex,
      messageType: "FillInstruction",
      solver: solver as Hex,
      recipient: intentFields.destination,
      destAsset: intentFields.destAsset,
      amount: intentFields.minDestAmount.toString(),
      nonce,
    };

    return {
      message,
      srcTxHash: log.transactionHash,
      srcBlock: Number(log.blockNumber),
    };
  }
}
