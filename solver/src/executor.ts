// SPDX-License-Identifier: MIT

/**
 * Executor: orchestrates the two settlement legs of a fill.
 *
 * 1. Calls EVM escrow `lock` to lock source funds
 * 2. Calls Soroban `fill_intent` to deliver destination assets
 * 3. Tracks settlement status and handles idempotent retries
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  getAddress,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  SorobanRpc,
  TransactionBuilder,
  Keypair,
  Contract,
  nativeToScVal,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import { ESCROW_ABI } from "@perihelion/sdk";
import type { SignedIntent } from "@perihelion/sdk";

/**
 * Thrown (or re-thrown) by an executor when a fill has *definitively* failed —
 * i.e. the on-chain transaction was rejected or reverted — and the capital was
 * never committed.  The solver catches this specifically in {@link Solver.consider}
 * and immediately releases the in-flight reservation.
 *
 * Contrast with a generic `Error` or a timeout, where the transaction may have
 * already landed (or may still land), so the reservation must be held until the
 * next inventory refresh to avoid double-spending.
 *
 * ## Usage
 *
 * ```ts
 * throw new DefiniteFailureError("escrow lock reverted: InsufficientBalance");
 * // or wrap an underlying cause:
 * throw new DefiniteFailureError("lock reverted", { cause: revertError });
 * ```
 */
export class DefiniteFailureError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "DefiniteFailureError";
  }
}

/** Logger interface for structured logging. */
export interface Logger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

/** Configuration for executor (keys and RPC endpoints). */
export interface ExecutorConfig {
  /** EVM RPC URL (Ethereum, Base, etc.) */
  readonly evmRpcUrl: string;
  /** Soroban RPC URL */
  readonly sorobanRpcUrl: string;
  /** EVM private key (hex-encoded with 0x prefix) */
  readonly evmPrivateKey: Hex;
  /** Soroban secret key (Stellar strkey) */
  readonly sorobanSecretKey: string;
  /** EVM escrow contract address */
  readonly escrowAddress: `0x${string}`;
  /** Soroban settlement contract ID (hash) */
  readonly settlementContractId: string;
  /** Source chain ID (1=mainnet, 8453=Base, etc.) */
  readonly sourceChainId: number;
  /** Stellar network passphrase (e.g. "Test SDF Network ; September 2015"). */
  readonly stellarNetwork: string;
}

/** Idempotency check result. */
interface FillStatus {
  filled: boolean;
  unknown?: boolean;
  settlementTx?: string;
}

/**
 * How many times to poll for a Soroban transaction confirmation before
 * giving up. Each attempt sleeps SOROBAN_POLL_INTERVAL_MS.
 */
const SOROBAN_MAX_POLL_ATTEMPTS = 30;
const SOROBAN_POLL_INTERVAL_MS = 2_000;

/**
 * Execute a fill by orchestrating EVM lock and Soroban fill_intent.
 *
 * Handles idempotent retries: before re-filling, queries current status
 * to avoid double-fills.
 */
export class Executor {
  private readonly evmRpcUrl: string;
  private readonly sorobanRpcUrl: string;
  private readonly evmPrivateKey: Hex;
  private readonly sorobanSecretKey: string;
  private readonly escrowAddress: `0x${string}`;
  private readonly settlementContractId: string;
  private readonly sourceChainId: number;
  private readonly stellarNetwork: string;
  private readonly logger: Logger;

  constructor(config: ExecutorConfig, logger: Logger = console) {
    this.evmRpcUrl = config.evmRpcUrl;
    this.sorobanRpcUrl = config.sorobanRpcUrl;
    this.evmPrivateKey = config.evmPrivateKey;
    this.sorobanSecretKey = config.sorobanSecretKey;
    this.escrowAddress = config.escrowAddress;
    this.settlementContractId = config.settlementContractId;
    this.sourceChainId = config.sourceChainId;
    this.stellarNetwork = config.stellarNetwork;
    this.logger = logger;
  }

  /**
   * Fill an intent: lock source funds and deliver destination assets.
   * Idempotent: checks fill status before attempting retry.
   */
  async fill(signed: SignedIntent): Promise<{ settlementTx: string }> {
    const { hash } = signed;

    // Check if already filled (idempotency)
    const status = await this.checkFillStatus(hash);
    if (status.filled && status.settlementTx) {
      this.logger.info("intent already settled, skipping", { hash });
      return { settlementTx: status.settlementTx };
    }

    // Step 1: Lock on EVM escrow
    const lockTx = await this.lockOnEvm(signed);
    this.logger.info("locked on EVM", { hash, lockTx });

    // Step 2: Fill on Soroban (deliver dest asset, dispatch FillConfirmed)
    const settlementTx = await this.fillOnSoroban(signed, lockTx);
    this.logger.info("filled on Soroban", { hash, settlementTx });

    return { settlementTx };
  }

  /**
   * Check if an intent has already been filled (idempotency check).
   * Queries Soroban to see if status() returns 'Settled'.
   */
  private async checkFillStatus(intentHash: Hex): Promise<FillStatus> {
    try {
      const settled = await this.isSettled(intentHash);
      if (settled) {
        // Soroban doesn't expose the tx hash from a view call; use the
        // intent hash as the idempotency marker.
        return { filled: true, settlementTx: intentHash };
      }
    } catch {
      // Query failure is not fatal; proceed with fill attempt.
    }
  }

  /**
   * Check if an intent is settled on the Soroban settlement contract.
   *
   * Mirrors the relayer's readStatus pattern: simulates a single-invocation
   * transaction calling `status(intent_hash)` and decodes the return value.
   */
  private async isSettled(intentHash: Hex): Promise<boolean> {
    const rpc = new SorobanRpc.Server(this.sorobanRpcUrl);
    const keypair = Keypair.fromSecret(this.sorobanSecretKey);
    const account = await rpc.getAccount(keypair.publicKey());

    const contract = new Contract(this.settlementContractId);

    // intentHash is 0x-prefixed 32-byte hex; decode to raw bytes for the
    // Soroban bytes32 argument.
    const hashBytes = hexToBytes(intentHash);

    const tx = new TransactionBuilder(account, {
      fee: "100",
      networkPassphrase: this.stellarNetwork,
    })
      .addOperation(
        contract.call("status", xdr.ScVal.scvBytes(Buffer.from(hashBytes))),
      )
      .setTimeout(30)
      .build();

    const simulated = await rpc.simulateTransaction(tx);
    if (!SorobanRpc.Api.isSimulationSuccess(simulated) || !simulated.result) {
      return false;
    }

    // The status enum decodes to a bare symbol string (e.g. "Settled") or a
    // [tag, ...payload] array — same pattern as soroban-delivery.ts readStatus.
    const native: unknown = scValToNative(simulated.result.retval);
    const variant = typeof native === "string"
      ? native
      : Array.isArray(native) && typeof native[0] === "string"
        ? native[0]
        : null;

    return variant === "Settled";
  }

  /**
   * Lock funds in the EVM escrow contract.
   *
   * 1. Derives the solver address from the private key.
   * 2. Quotes the LayerZero messaging fee.
   * 3. Calls `escrow.lock(intent, signature, value)`.
   * 4. Waits for the receipt and returns the tx hash.
   */
  private async lockOnEvm(signed: SignedIntent): Promise<Hex> {
    const { intent, signature } = signed;

    const account = privateKeyToAccount(this.evmPrivateKey);

    const publicClient = createPublicClient({
      transport: http(this.evmRpcUrl),
    });

    const walletClient = createWalletClient({
      account,
      transport: http(this.evmRpcUrl),
    });

    // Convert the SDK intent to the contract tuple format expected by the ABI.
    const contractIntent = {
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
    };

    // Quote the LayerZero fee. The contract returns the native token amount
    // that must accompany the lock() call as msg.value.
    const nativeFee = await publicClient.readContract({
      address: this.escrowAddress,
      abi: ESCROW_ABI,
      functionName: "quoteFee",
      args: [contractIntent, account.address],
    }) as bigint;

    const txHash = await walletClient.writeContract({
      account,
      chain: null, // chain is resolved from the RPC endpoint
      address: this.escrowAddress,
      abi: ESCROW_ABI,
      functionName: "lock",
      args: [contractIntent, signature],
      value: nativeFee,
    });

    // Wait for the transaction to be included in a block.
    await publicClient.waitForTransactionReceipt({ hash: txHash });

    return txHash;
  }

  /**
   * Fill the intent on Soroban: deliver destination assets and dispatch
   * FillConfirmed back to the source chain over LayerZero.
   *
   * Calls `fill_intent(solver, solver_evm, intent_hash, fill_amount, lz_fee)`:
   *   - solver:       this solver's Stellar address (derived from the secret key)
   *   - solver_evm:   this solver's EVM address padded to 32 bytes, for the
   *                   FillConfirmed payout destination on the source chain
   *   - intent_hash:  32-byte raw bytes derived from the 0x-prefixed intentHash
   *   - fill_amount:  intent.minDestAmount (i128)
   *   - lz_fee:       quoted via quote_lz_fee; 0 when the mock endpoint is used
   */
  private async fillOnSoroban(signed: SignedIntent, _lockTx: Hex): Promise<Hex> {
    const { intent, hash: intentHash } = signed;

    const keypair = Keypair.fromSecret(this.sorobanSecretKey);
    const rpc = new SorobanRpc.Server(this.sorobanRpcUrl);
    const account = await rpc.getAccount(keypair.publicKey());

    const contract = new Contract(this.settlementContractId);

    // intent_hash: 0x-prefixed 32-byte hex → raw bytes → Soroban BytesN<32>
    const hashBytes = hexToBytes(intentHash);

    // solver_evm: derive from the EVM private key, pad 20-byte address to 32
    // bytes (right-padded with zeros as BytesN<32>; the contract stores the
    // address in the leftmost 20 bytes).
    const solverEvm = privateKeyToAccount(this.evmPrivateKey).address;
    const solverEvmBytes = evmAddressTo32Bytes(solverEvm);

    // solver Stellar address (authorizing the call)
    const solverStellar = nativeToScVal(keypair.publicKey(), { type: "address" });

    // fill_amount = minDestAmount as i128
    const fillAmount = BigInt(intent.minDestAmount);

    const args = [
      solverStellar,
      xdr.ScVal.scvBytes(Buffer.from(solverEvmBytes)),  // solver_evm: BytesN<32>
      xdr.ScVal.scvBytes(Buffer.from(hashBytes)),        // intent_hash: BytesN<32>
      nativeToScVal(fillAmount, { type: "i128" }),  // fill_amount: i128
      nativeToScVal(0n, { type: "i128" }),          // lz_fee: i128 (0 for mock)
    ];

    const tx = new TransactionBuilder(account, {
      fee: "10000",
      networkPassphrase: this.stellarNetwork,
    })
      .addOperation(contract.call("fill_intent", ...args))
      .setTimeout(60)
      .build();

    // Simulate to obtain the resource fee and prepared transaction.
    const simulated = await rpc.simulateTransaction(tx);
    if (!SorobanRpc.Api.isSimulationSuccess(simulated)) {
      throw new Error(`fill_intent simulation failed: ${String((simulated as SorobanRpc.Api.SimulateTransactionErrorResponse).error)}`);
    }

    const prepared = SorobanRpc.assembleTransaction(tx, simulated).build();
    prepared.sign(keypair);

    const result = await rpc.sendTransaction(prepared);
    if (result.status === "ERROR") {
      throw new Error(`fill_intent submission failed: ${result.errorResult?.toXDR("base64") ?? "unknown"}`);
    }

    // Poll until the transaction is confirmed.
    for (let attempt = 0; attempt < SOROBAN_MAX_POLL_ATTEMPTS; attempt++) {
      const txStatus = await rpc.getTransaction(result.hash);
      if (txStatus.status === SorobanRpc.Api.GetTransactionStatus.SUCCESS) {
        return result.hash as Hex;
      }
      if (txStatus.status === SorobanRpc.Api.GetTransactionStatus.FAILED) {
        throw new Error(`fill_intent transaction failed: ${txStatus.resultXdr?.toXDR("base64") ?? "unknown"}`);
      }
      await sleep(SOROBAN_POLL_INTERVAL_MS);
    }

    throw new Error(`fill_intent confirmation timeout after ${SOROBAN_MAX_POLL_ATTEMPTS} attempts: ${result.hash}`);
  }
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Decode a 0x-prefixed hex string to a Uint8Array.
 * Strips the "0x" prefix before parsing.
 */
function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) throw new Error(`Invalid hex length: ${hex}`);
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/**
 * Encode a 20-byte EVM address into a 32-byte buffer, left-justified
 * (address in bytes 0–19, zeros in bytes 20–31).
 *
 * The Soroban contract stores `solver_evm` as `BytesN<32>` and decodes
 * the payout address from the first 20 bytes when emitting FillConfirmed.
 */
function evmAddressTo32Bytes(address: string): Uint8Array {
  const clean = address.startsWith("0x") ? address.slice(2) : address;
  if (clean.length !== 40) throw new Error(`Invalid EVM address length: ${address}`);
  const buf = new Uint8Array(32);
  for (let i = 0; i < 20; i++) {
    buf[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return buf;
}
