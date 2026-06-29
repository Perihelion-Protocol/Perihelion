/**
 * Mock implementations of LayerZero transport, EVM contracts, and Soroban
 * contracts for deterministic end-to-end testing without external dependencies.
 */

import type { Hex } from "viem";
import type { Intent } from "@perihelion/sdk";

// Wire format constants (matching contracts/soroban/settlement/src/messages.rs)
const VERSION = 0x01;
const MSG_FILL_INSTRUCTION = 0x01;
const MSG_FILL_CONFIRMED = 0x02;
const MSG_CANCEL_INTENT = 0x03;

export interface LzMessage {
  srcEid: number;
  dstEid: number;
  sender: Hex;
  nonce: number;
  payload: Uint8Array;
}

/**
 * Mock LayerZero endpoint that routes messages between EVM and Soroban.
 * Acts as the transport layer, capturing outbound messages and delivering them
 * to the destination chain.
 */
export class MockLayerZeroEndpoint {
  private nonce = 0;
  private readonly messages: LzMessage[] = [];

  /** Send a message from src to dst chain. */
  send(srcEid: number, dstEid: number, sender: Hex, payload: Uint8Array): void {
    this.nonce++;
    this.messages.push({ srcEid, dstEid, sender, nonce: this.nonce, payload });
  }

  /** Get all messages sent to a specific destination EID. */
  getMessagesTo(dstEid: number): LzMessage[] {
    return this.messages.filter((m) => m.dstEid === dstEid);
  }

  /** Get the last message sent (for assertions). */
  lastMessage(): LzMessage | undefined {
    return this.messages[this.messages.length - 1];
  }

  messageCount(): number {
    return this.messages.length;
  }

  clear(): void {
    this.messages.length = 0;
  }
}

/**
 * Mock ERC-20 token with balances tracking.
 */
export class MockERC20 {
  private readonly balances = new Map<string, bigint>();

  constructor(public readonly decimals: number = 6) {}

  mint(address: string, amount: bigint): void {
    const current = this.balances.get(address) ?? 0n;
    this.balances.set(address, current + amount);
  }

  transfer(from: string, to: string, amount: bigint): void {
    const fromBalance = this.balances.get(from) ?? 0n;
    if (fromBalance < amount) {
      throw new Error(`Insufficient balance: ${from} has ${fromBalance}, needs ${amount}`);
    }
    this.balances.set(from, fromBalance - amount);
    const toBalance = this.balances.get(to) ?? 0n;
    this.balances.set(to, toBalance + amount);
  }

  balanceOf(address: string): bigint {
    return this.balances.get(address) ?? 0n;
  }
}

/**
 * Mock Perihelion EVM Escrow contract.
 */
export class MockEscrow {
  private readonly locks = new Map<Hex, LockRecord>();
  private readonly released = new Set<Hex>();
  private readonly refunded = new Set<Hex>();

  constructor(
    private readonly token: MockERC20,
    private readonly lz: MockLayerZeroEndpoint,
    private readonly contractAddress: string,
    private readonly evmEid: number,
    private readonly stellarEid: number,
  ) {}

  /**
   * Lock user funds and emit FillInstruction to Stellar.
   */
  lock(intent: Intent, intentHash: Hex, solver: string): void {
    if (this.locks.has(intentHash)) {
      throw new Error(`AlreadyLocked: ${intentHash}`);
    }

    // Transfer tokens from user to escrow
    this.token.transfer(intent.user, this.contractAddress, BigInt(intent.sourceAmount));

    // Record the lock
    this.locks.set(intentHash, {
      user: intent.user,
      solver,
      amount: BigInt(intent.sourceAmount),
      deadline: intent.deadline,
    });

    // Emit FillInstruction to Stellar
    const payload = this.encodeFillInstruction(intent, intentHash);
    this.lz.send(this.evmEid, this.stellarEid, this.contractAddress as Hex, payload);
  }

  /**
   * Receive FillConfirmed from Stellar and release to solver.
   */
  lzReceive(intentHash: Hex, solverEvm: string, amount: bigint): void {
    const lock = this.locks.get(intentHash);
    if (!lock) {
      throw new Error(`IntentNotFound: ${intentHash}`);
    }
    if (this.released.has(intentHash) || this.refunded.has(intentHash)) {
      throw new Error(`AlreadyFinalized: ${intentHash}`);
    }

    // Release to solver
    this.token.transfer(this.contractAddress, solverEvm, amount);
    this.released.add(intentHash);
  }

  /**
   * Receive CancelIntent from Stellar and refund to user.
   */
  lzReceiveCancel(intentHash: Hex): void {
    const lock = this.locks.get(intentHash);
    if (!lock) {
      throw new Error(`IntentNotFound: ${intentHash}`);
    }
    if (this.released.has(intentHash) || this.refunded.has(intentHash)) {
      throw new Error(`AlreadyFinalized: ${intentHash}`);
    }

    // Refund to user
    this.token.transfer(this.contractAddress, lock.user, lock.amount);
    this.refunded.add(intentHash);
  }

  /**
   * Local timeout: refund after deadline + grace period.
   */
  cancelExpired(intentHash: Hex, now: number): void {
    const lock = this.locks.get(intentHash);
    if (!lock) {
      throw new Error(`IntentNotFound: ${intentHash}`);
    }
    if (this.released.has(intentHash) || this.refunded.has(intentHash)) {
      throw new Error(`AlreadyFinalized: ${intentHash}`);
    }
    if (now < lock.deadline + 300) {
      // 300s = confirmation grace
      throw new Error(`DeadlineNotPassed: ${intentHash}`);
    }

    this.token.transfer(this.contractAddress, lock.user, lock.amount);
    this.refunded.add(intentHash);
  }

  isReleased(intentHash: Hex): boolean {
    return this.released.has(intentHash);
  }

  isRefunded(intentHash: Hex): boolean {
    return this.refunded.has(intentHash);
  }

  getLock(intentHash: Hex): LockRecord | undefined {
    return this.locks.get(intentHash);
  }

  private encodeFillInstruction(intent: Intent, intentHash: Hex): Uint8Array {
    // Wire format: VERSION(1) || TYPE(1) || intent_hash(32) || ...
    const buf = new Uint8Array(2 + 32);
    buf[0] = VERSION;
    buf[1] = MSG_FILL_INSTRUCTION;
    const hashBytes = hexToBytes(intentHash);
    buf.set(hashBytes, 2);
    return buf;
  }
}

interface LockRecord {
  user: string;
  solver: string;
  amount: bigint;
  deadline: number;
}

/**
 * Mock Stellar asset (SAC token).
 */
export class MockStellarAsset {
  private readonly balances = new Map<string, bigint>();

  constructor(public readonly code: string, public readonly issuer: string) {}

  mint(address: string, amount: bigint): void {
    const current = this.balances.get(address) ?? 0n;
    this.balances.set(address, current + amount);
  }

  transfer(from: string, to: string, amount: bigint): void {
    const fromBalance = this.balances.get(from) ?? 0n;
    if (fromBalance < amount) {
      throw new Error(`Insufficient balance: ${from} has ${fromBalance}, needs ${amount}`);
    }
    this.balances.set(from, fromBalance - amount);
    const toBalance = this.balances.get(to) ?? 0n;
    this.balances.set(to, toBalance + amount);
  }

  balanceOf(address: string): bigint {
    return this.balances.get(address) ?? 0n;
  }
}

/**
 * Mock Soroban settlement contract.
 */
export class MockSettlement {
  private readonly intents = new Map<Hex, IntentRecord>();
  private readonly settled = new Set<Hex>();
  private readonly cancelled = new Set<Hex>();

  constructor(
    private readonly asset: MockStellarAsset,
    private readonly lz: MockLayerZeroEndpoint,
    private readonly stellarEid: number,
    private readonly evmEid: number,
  ) {}

  /**
   * Receive FillInstruction from EVM and register intent.
   */
  lzReceive(intentHash: Hex, recipient: string, minDestAmount: bigint, deadline: number): void {
    if (this.intents.has(intentHash)) {
      throw new Error(`IntentAlreadyRegistered: ${intentHash}`);
    }

    this.intents.set(intentHash, {
      recipient,
      minDestAmount,
      deadline,
      srcEid: this.evmEid,
    });
  }

  /**
   * Solver fills the intent: transfer assets to recipient and emit FillConfirmed.
   */
  fillIntent(
    intentHash: Hex,
    solver: string,
    solverEvm: Hex,
    fillAmount: bigint,
    now: number,
  ): void {
    const intent = this.intents.get(intentHash);
    if (!intent) {
      throw new Error(`IntentNotFound: ${intentHash}`);
    }
    if (this.settled.has(intentHash) || this.cancelled.has(intentHash)) {
      throw new Error(`IntentFinalized: ${intentHash}`);
    }
    if (now >= intent.deadline) {
      throw new Error(`IntentExpired: ${intentHash}`);
    }
    if (fillAmount < intent.minDestAmount) {
      throw new Error(`InsufficientFillAmount: ${fillAmount} < ${intent.minDestAmount}`);
    }

    // Transfer destination asset to recipient
    this.asset.transfer(solver, intent.recipient, fillAmount);
    this.settled.add(intentHash);

    // Emit FillConfirmed to EVM
    const payload = this.encodeFillConfirmed(intentHash, solverEvm, fillAmount);
    this.lz.send(this.stellarEid, this.evmEid, "0xSTELLAR" as Hex, payload);
  }

  /**
   * Cancel expired intent and emit CancelIntent to EVM.
   */
  cancelExpiredIntent(intentHash: Hex, now: number): void {
    const intent = this.intents.get(intentHash);
    if (!intent) {
      throw new Error(`IntentNotFound: ${intentHash}`);
    }
    if (this.settled.has(intentHash) || this.cancelled.has(intentHash)) {
      throw new Error(`IntentFinalized: ${intentHash}`);
    }
    if (now < intent.deadline) {
      throw new Error(`DeadlineNotPassed: ${intentHash}`);
    }

    this.cancelled.add(intentHash);

    // Emit CancelIntent to EVM
    const payload = this.encodeCancelIntent(intentHash);
    this.lz.send(this.stellarEid, this.evmEid, "0xSTELLAR" as Hex, payload);
  }

  isSettled(intentHash: Hex): boolean {
    return this.settled.has(intentHash);
  }

  isCancelled(intentHash: Hex): boolean {
    return this.cancelled.has(intentHash);
  }

  getIntent(intentHash: Hex): IntentRecord | undefined {
    return this.intents.get(intentHash);
  }

  private encodeFillConfirmed(intentHash: Hex, solverEvm: Hex, amount: bigint): Uint8Array {
    // VERSION(1) || TYPE(1) || intent_hash(32) || solver_evm(32) || amount(16) || ledger(8)
    const buf = new Uint8Array(90);
    buf[0] = VERSION;
    buf[1] = MSG_FILL_CONFIRMED;
    buf.set(hexToBytes(intentHash), 2);
    buf.set(hexToBytes(solverEvm), 34);
    // amount as big-endian u128 at offset 66
    const amountBytes = bigintToBytes(amount, 16);
    buf.set(amountBytes, 66);
    // ledger number (mock value)
    buf.set(new Uint8Array([0, 0, 0, 0, 0, 0, 0, 42]), 82);
    return buf;
  }

  private encodeCancelIntent(intentHash: Hex): Uint8Array {
    // VERSION(1) || TYPE(1) || intent_hash(32) || reason(1)
    const buf = new Uint8Array(35);
    buf[0] = VERSION;
    buf[1] = MSG_CANCEL_INTENT;
    buf.set(hexToBytes(intentHash), 2);
    buf[34] = 0; // CANCEL_REASON_EXPIRED
    return buf;
  }
}

interface IntentRecord {
  recipient: string;
  minDestAmount: bigint;
  deadline: number;
  srcEid: number;
}

// --- Utilities ----------------------------------------------------------------

function hexToBytes(hex: Hex): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function bigintToBytes(value: bigint, length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  let v = value;
  for (let i = length - 1; i >= 0; i--) {
    bytes[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return bytes;
}
