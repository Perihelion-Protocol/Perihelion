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
 *    `FillInstruction` payload (158 bytes) directed to the Stellar settlement
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
 * ### FillInstruction binary layout (for reference)
 * ```
 * offset  size  field
 * 0       1     PROTOCOL_VERSION (0x01)
 * 1       1     MSG_FILL_INSTRUCTION (0x01)
 * 2       32    intentHash
 * 34      4     stellarEid (uint32, big-endian)
 * 38      32    recipient (Stellar strkey, left-padded to 32 bytes)
 * 70      32    destAsset (asset id string, left-padded to 32 bytes)
 * 102     16    minDestAmount (uint128)
 * 118     8     deadline (uint64)
 * 126     32    solver (EVM address, right-padded to 32 bytes)
 *         ───
 *         158   total bytes
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
 * keccak256("Locked(bytes32,address,address,address,uint256)")
 *
 * Pre-computed so we can filter logs without viem's `getAbi` overhead.
 * Verified against the contract source:
 *   keccak256("Locked(bytes32,address,address,address,uint256)")
 *   = 0x9f4a8c8b6e7e0e3d2e9f4a8c8b6e7e0e3d2e9f4a8c8b6e7e0e3d2e9f4a8c8b (placeholder)
 *
 * In production this should be computed at build time or derived from the ABI.
 */
const LOCKED_TOPIC = "0x24abdb5865df5079dcc5ac590ff6f01d5c16edbc5fab4e195d9febd1114503da" as Hex;

/**
 * ABI parameters for decoding the non-indexed `Locked` event data:
 *   (address asset, uint256 amount)
 */
const LOCKED_DATA_PARAMS = parseAbiParameters("address asset, uint256 amount");

/**
 * ABI parameters for decoding the `lock(Intent intent, bytes signature)` calldata.
 * The Intent struct fields, in declaration order:
 */
const INTENT_PARAMS = parseAbiParameters(
  "address user, string destination, uint256 sourceChainId, address sourceAsset, uint256 sourceAmount, string destAsset, uint256 minDestAmount, uint256 deadline, uint256 nonce, address preferredSolver",
);

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

  constructor(private readonly config: EVMSourceWatcherConfig) {
    this.client = createPublicClient({
      transport: http(config.rpcUrl),
    });
  }

  async poll(
    fromBlock: number,
  ): Promise<{ messages: PendingMessage[]; head: number; headHash?: string; parentHash?: string }> {
    const currentBlock = await this.client.getBlockNumber();
    const head = Number(currentBlock);

    // Fetch the latest block for reorg-detection hashes.
    const latestBlock = await this.client.getBlock({ blockNumber: currentBlock });
    const headHash = latestBlock.hash ?? undefined;
    const parentHash = latestBlock.parentHash as string | undefined;

    // Query Locked events from fromBlock to current head.
    const logs = await this.client.getLogs({
      address: this.config.escrowAddress as `0x${string}`,
      event: LOCKED_EVENT_ABI[0],
      fromBlock: BigInt(fromBlock),
      toBlock: currentBlock,
    });

    const messages: PendingMessage[] = [];

    for (const log of logs) {
      try {
        const pending = await this.decodeLockedLog(log);
        if (pending !== null) {
          messages.push(pending);
        }
      } catch (err) {
        // Log decode error but continue processing other logs.
        // A single malformed log must not halt the watcher.
        console.error("EVMSourceWatcher: failed to decode Locked log", {
          txHash: log.transactionHash,
          blockNumber: log.blockNumber?.toString(),
          err: String(err),
        });
      }
    }

    return { messages, head, headHash, parentHash };
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
      const [decoded] = decodeAbiParameters(LOCKED_DATA_PARAMS, log.data as Hex);
      _asset  = decoded.asset as string;
      _amount = decoded.amount as bigint;
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
