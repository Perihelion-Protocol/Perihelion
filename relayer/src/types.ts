// SPDX-License-Identifier: MIT

/** Types describing LayerZero messages on the Perihelion Stellar ↔ EVM path. */

import type { Hex } from "@perihelion/sdk";

/** LayerZero endpoint identifiers for the chains Perihelion bridges. */
export type EndpointId = number;

/**
 * Discriminated message type carried in every bridge message.
 * Used as part of the composite dedup key so that distinct protocol messages
 * that share the same intentHash are never conflated.
 *
 * - FillInstruction  — EVM → Stellar: instruct Soroban to release solver assets.
 * - FillConfirmed   — Stellar → EVM: confirm that assets were released.
 * - CancelIntent    — either direction: abort and allow a refund.
 */
export type MessageType = "FillInstruction" | "FillConfirmed" | "CancelIntent";

/**
 * A cross-chain message carrying proof that a solver locked source funds for an
 * intent, instructing the destination chain to release the settlement assets.
 */
export interface BridgeMessage {
  /** LayerZero endpoint id of the source chain (where funds were locked). */
  readonly srcEid: EndpointId;
  /** LayerZero endpoint id of the destination chain (where assets release). */
  readonly dstEid: EndpointId;
  /** keccak256 commitment of the intent (its protocol-wide id). */
  readonly intentHash: Hex;
  /** Discriminates distinct protocol messages that share the same intentHash. */
  readonly messageType: MessageType;
  /** Solver that locked the source funds and is owed the destination assets. */
  readonly solver: Hex;
  /** Destination recipient — the user's Stellar address. */
  readonly recipient: string;
  /** Destination asset identifier (e.g. `native` or `CODE:ISSUER`). */
  readonly destAsset: string;
  /** Amount to release, in destination-asset smallest units (decimal string). */
  readonly amount: string;
  /** Monotonic per-source-endpoint nonce for ordering and replay protection. */
  readonly nonce: number;
}

/** A {@link BridgeMessage} observed on-chain, awaiting relay to its destination. */
export interface PendingMessage {
  readonly message: BridgeMessage;
  /** Source-chain tx hash that emitted the message. */
  readonly srcTxHash: string;
  /** Block number the message was emitted in (for confirmation depth). */
  readonly srcBlock: number;
  /**
   * Block hash of srcBlock. Tracked for reorg detection: if the relayer later
   * reads a block at the same height with a different hash, a reorg occurred.
   */
  readonly srcBlockHash?: string;
}

/** Outcome of attempting to relay a single message. */
export interface RelayResult {
  readonly intentHash: Hex;
  /**
   * Full composite identity of the message this result belongs to. Cursor
   * advancement correlates results back to their messages by this key — never
   * by `intentHash` alone, since a single intent accumulates several distinct
   * messages (FillInstruction → FillConfirmed / CancelIntent, retries, or two
   * Locked events in one block after a reorg) that share one intent hash.
   */
  readonly key: MessageKey;
  /** True only when this attempt delivered the message to the destination. */
  readonly delivered: boolean;
  /**
   * True when the message needs no further relay work: it was delivered on
   * this attempt, was already delivered (idempotency short-circuit), or was
   * dead-lettered. The cursor may advance past a resolved message's block;
   * an unresolved (`resolved: false`) message pins the cursor at its block.
   */
  readonly resolved: boolean;
  /**
   * True when `resolved` was reached via the idempotency short-circuit
   * (`isDelivered` returned true) rather than a fresh delivery. Lets metrics
   * keep `delivered` meaning "delivered by this relayer this session".
   */
  readonly alreadyDelivered?: boolean;
  /** Destination-chain tx hash, when delivered. */
  readonly dstTxHash?: string;
  readonly error?: string;
}

/**
 * Composite key that uniquely identifies a bridge message across all protocol
 * legs and directions. Using intentHash alone would conflate distinct messages
 * (e.g. FillInstruction and FillConfirmed) that share the same intentHash.
 *
 * Fields:
 *   srcEid       — LayerZero source endpoint id
 *   dstEid       — LayerZero destination endpoint id
 *   intentHash   — EIP-712 keccak256 commitment of the intent
 *   messageType  — protocol message discriminator
 *   nonce        — per-source monotonic counter
 */
export interface MessageKey {
  readonly srcEid: EndpointId;
  readonly dstEid: EndpointId;
  readonly intentHash: Hex;
  readonly messageType: MessageType;
  readonly nonce: number;
}

/** Serialize a MessageKey to a stable, opaque string for use as a map key. */
export function messageKeyString(k: MessageKey): string {
  return `${k.srcEid}:${k.dstEid}:${k.intentHash}:${k.messageType}:${k.nonce}`;
}
