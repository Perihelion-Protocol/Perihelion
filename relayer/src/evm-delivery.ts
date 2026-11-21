// SPDX-License-Identifier: MIT
import {
  createPublicClient,
  createWalletClient,
  http,
  keccak256,
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
 * ABI fragment for the escrow's delivery marker. Read as a fallback by
 * `isDelivered`. The escrow's `lzReceive` is intentionally not included: only
 * the endpoint may call it.
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
   * Deliveries are routed through its `deliver` function. The relayer never
   * calls `lzReceive` on the escrow directly: the escrow only accepts calls
   * from the endpoint, so an EOA call would always revert.
   */
  mockEndpointAddress: Address;
  /** Destination endpoint id used by the endpoint. Defaults to 0. */
  dstEid?: number;
  /** Source endpoint id of the origin tuple. Required; no default. */
  srcEid: number;
  /**
   * Source sender (`stellarPeer`) recorded in the origin tuple. Required
   * 32-byte hex; the escrow rejects the zero sender.
   */
  srcSender: Hex;
  /** Optional confirmation count for receipts. Defaults to 1. */
  confirmations?: number;
}

/**
 * Rejects configs that lack the origin fields the escrow checks on inbound
 * messages (`srcEid`, `srcSender`). There are no zero defaults: a zero
 * sender or eid can never match the escrow's configured peer.
 */
function validateOriginConfig(config: EvmDestinationDeliveryConfig): void {
  if (!config.mockEndpointAddress) {
    throw new Error("EvmDestinationDelivery: mockEndpointAddress is required");
  }
  if (!Number.isInteger(config.srcEid) || config.srcEid <= 0) {
    throw new Error(`EvmDestinationDelivery: srcEid must be a positive integer, got ${String(config.srcEid)}`);
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(config.srcSender ?? "")) {
    throw new Error("EvmDestinationDelivery: srcSender must be a 32-byte hex value");
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
    validateOriginConfig(config);
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

    const payload = this.encodePayload(message);
    return this.deliverViaEndpoint(payload);
  }

  private isOutboundType(type: MessageType): boolean {
    return type === "FillConfirmed" || type === "CancelIntent";
  }

  private async deliverViaEndpoint(payload: Hex): Promise<Hash> {
    const { request } = await this.publicClient.simulateContract({
      account: this.account,
      address: this.config.mockEndpointAddress,
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
   * Returns the GUID for a message: the message's own 32-byte guid when
   * present, otherwise the keccak256 of its payload (see {@link payloadHash}).
   */
  private guidFor(message: Message): Hex {
    if (message.guid && message.guid.startsWith("0x") && message.guid.length === 66) {
      return message.guid as Hex;
    }
    return this.payloadHash(message);
  }

  /** keccak256 over the raw payload bytes, as a 32-byte hex value. */
  private payloadHash(message: Message): Hex {
    const raw = message.payload.startsWith("0x")
      ? message.payload
      : `0x${message.payload}`;
    return keccak256(raw as Hex);
  }
}