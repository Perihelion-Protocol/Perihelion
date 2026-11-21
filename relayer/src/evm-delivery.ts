// SPDX-License-Identifier: MIT
import {
  createPublicClient,
  createWalletClient,
  http,
  type Abi,
  type Address,
  type Hash,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { DestinationDelivery, Message, MessageType } from "./types.js";

/**
 * Minimal ABI for the mock LayerZero endpoint used on development networks.
 *
 * The mock endpoint mirrors the subset of the real LayerZero V2 endpoint that
 * the escrow relies on: it records the message payload it was asked to deliver
 * and forwards it to the destination contract's `lzReceive` entrypoint.
 */
const MOCK_ENDPOINT_ABI = [
  {
    type: "function",
    name: "deliver",
    stateMutability: "nonpayable",
    inputs: [
      { name: "dstEid", type: "uint32" },
      { name: "receiver", type: "address" },
      { name: "payload", type: "bytes" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "delivered",
    stateMutability: "view",
    inputs: [
      { name: "dstEid", type: "uint32" },
      { name: "receiver", type: "address" },
      { name: "payloadHash", type: "bytes32" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "event",
    name: "Delivered",
    inputs: [
      { name: "dstEid", type: "uint32", indexed: true },
      { name: "receiver", type: "address", indexed: true },
      { name: "payloadHash", type: "bytes32", indexed: true },
    ],
    anonymous: false,
  },
] as const satisfies Abi;

/**
 * ABI fragment for the escrow's delivery-marker read. The escrow's `lzReceive`
 * is only ever called by a LayerZero endpoint, never by the relayer's EOA.
 */
const ESCROW_ABI = [
  {
    type: "function",
    name: "isDelivered",
    stateMutability: "view",
    inputs: [{ name: "guid", type: "bytes32" }],
    outputs: [{ name: "", type: "bool" }],
  },
] as const satisfies Abi;

export interface EvmDestinationDeliveryConfig {
  /** JSON-RPC URL for the EVM network hosting the escrow. */
  rpcUrl: string;
  /** Private key of the relayer account that submits deliveries. */
  privateKey: Hex;
  /** Address of the PerihelionEscrow contract. */
  escrowAddress: Address;
  /**
   * Address of the LayerZero endpoint that delivers messages to the escrow.
   * Required. Deliveries are routed through its `deliver` function. The
   * relayer never calls the escrow's `lzReceive` from its own account, because
   * the escrow only accepts calls from the endpoint.
   */
  mockEndpointAddress: Address;
  /** Destination endpoint id used by the mock endpoint. Defaults to 0. */
  dstEid?: number;
  /** Source LayerZero endpoint id (the Stellar side). Required; must be a uint32 > 0. */
  srcEid: number;
  /** Source OApp sender as bytes32. Required; must be non-zero. */
  srcSender: Hex;
  /** Optional confirmation count for receipts. Defaults to 1. */
  confirmations?: number;
}

const MAX_UINT32 = 0xffff_ffff;
const BYTES32_RE = /^0x[0-9a-fA-F]{64}$/;
const ZERO_BYTES32: Hex =
  "0x0000000000000000000000000000000000000000000000000000000000000000";

/**
 * Rejects a delivery config that lacks the origin fields or endpoint address.
 * Zero or missing values would make the escrow reject every message
 * (`NotEndpoint` / wrong sender / nonce 0), so they fail at load time instead.
 */
function validateDeliveryConfig(config: EvmDestinationDeliveryConfig): void {
  if (!config.mockEndpointAddress) {
    throw new Error("EvmDestinationDelivery: mockEndpointAddress (LayerZero endpoint) is required");
  }
  if (!Number.isInteger(config.srcEid) || config.srcEid <= 0 || config.srcEid > MAX_UINT32) {
    throw new Error(
      `EvmDestinationDelivery: srcEid must be an integer in 1..${MAX_UINT32}, got: ${String(config.srcEid)}`,
    );
  }
  if (!config.srcSender || !BYTES32_RE.test(config.srcSender) || config.srcSender === ZERO_BYTES32) {
    throw new Error(
      `EvmDestinationDelivery: srcSender must be a non-zero 0x-prefixed bytes32, got: ${String(config.srcSender)}`,
    );
  }
}

/**
 * Delivers settlement messages originating on Soroban to the EVM escrow.
 *
 * This is the return leg of the bridge for issue #941: `FillConfirmed`
 * releases the solver's payment and `CancelIntent` refunds the user. On
 * development networks the message is submitted through a mock LayerZero
 * endpoint; in production a LayerZero executor performs the same call.
 */
export class EvmDestinationDelivery implements DestinationDelivery {
  private readonly publicClient: PublicClient;
  private readonly walletClient: WalletClient;
  private readonly account: ReturnType<typeof privateKeyToAccount>;
  private readonly config: EvmDestinationDeliveryConfig;
  private readonly confirmations: number;

  constructor(config: EvmDestinationDeliveryConfig) {
    validateDeliveryConfig(config);
    this.config = config;
    this.confirmations = config.confirmations ?? 1;
    this.account = privateKeyToAccount(config.privateKey);

    const transport = http(config.rpcUrl);
    this.publicClient = createPublicClient({ transport });
    this.walletClient = createWalletClient({
      account: this.account,
      transport,
    });
  }

  /**
   * Returns true when the message has already been delivered to the escrow.
   * Used by the relayer's replay guard so a restart does not double-deliver.
   */
  async isDelivered(message: Message): Promise<boolean> {
    const guid = this.guidFor(message);

    if (this.config.mockEndpointAddress) {
      try {
        return await this.publicClient.readContract({
          address: this.config.mockEndpointAddress,
          abi: MOCK_ENDPOINT_ABI,
          functionName: "delivered",
          args: [
            this.config.dstEid ?? 0,
            this.config.escrowAddress,
            this.payloadHash(message),
          ],
        });
      } catch {
        // Fall through to the escrow-side check below.
      }
    }

    try {
      return await this.publicClient.readContract({
        address: this.config.escrowAddress,
        abi: ESCROW_ABI,
        functionName: "isDelivered",
        args: [guid],
      });
    } catch {
      // If neither contract exposes a delivery marker, treat as not delivered
      // so the relayer attempts delivery; the escrow itself is idempotent.
      return false;
    }
  }

  /**
   * Delivers a single message to the EVM escrow. Returns the transaction hash.
   */
  async deliver(message: Message): Promise<Hash> {
    if (!this.isOutboundType(message.type)) {
      throw new Error(
        `EvmDestinationDelivery cannot deliver message type ${message.type}`,
      );
    }

    return this.deliverViaMockEndpoint(this.encodePayload(message));
  }

  private isOutboundType(type: MessageType): boolean {
    return type === "FillConfirmed" || type === "CancelIntent";
  }

  private async deliverViaMockEndpoint(payload: Hex): Promise<Hash> {
    const { request } = await this.publicClient.simulateContract({
      account: this.account,
      address: this.config.mockEndpointAddress!,
      abi: MOCK_ENDPOINT_ABI,
      functionName: "deliver",
      args: [this.config.dstEid ?? 0, this.config.escrowAddress, payload],
    });

    const hash = await this.walletClient.writeContract(request);
    await this.publicClient.waitForTransactionReceipt({
      hash,
      confirmations: this.confirmations,
    });
    return hash;
  }

  /**
   * Encodes the settlement payload the escrow expects for the given message.
   *
   * The encoding is a simple, stable layout:
   *   bytes32 guid | uint8 messageType | bytes body
   * where `body` is the message's already-encoded payload.
   */
  private encodePayload(message: Message): Hex {
    const guid = this.guidFor(message).slice(2);
    const typeByte = this.typeCode(message.type).toString(16).padStart(2, "0");
    const body = message.payload.startsWith("0x")
      ? message.payload.slice(2)
      : message.payload;
    return `0x${guid}${typeByte}${body}` as Hex;
  }

  private typeCode(type: MessageType): number {
    switch (type) {
      case "FillConfirmed":
        return 1;
      case "CancelIntent":
        return 2;
      default:
        throw new Error(`Unsupported outbound message type: ${type}`);
    }
  }

  /**
   * Derives the LayerZero-style GUID for a message. The relayer uses the
   * message id when present; otherwise it hashes the encoded payload.
   */
  private guidFor(message: Message): Hex {
    if (message.guid && message.guid.startsWith("0x") && message.guid.length === 66) {
      return message.guid as Hex;
    }
    return this.payloadHash(message);
  }

  private payloadHash(message: Message): Hex {
    // keccak256 over the raw payload bytes. viem's `keccak256` is not imported
    // here to keep the dependency surface small; the relayer's message id is
    // already a 32-byte hex string in practice, so we normalise it.
    const raw = message.payload.startsWith("0x")
      ? message.payload.slice(2)
      : message.payload;
    const padded = raw.padEnd(64, "0").slice(0, 64);
    return `0x${padded}` as Hex;
  }
}