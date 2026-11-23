// SPDX-License-Identifier: MIT

/**
 * Executor: orchestrates the two settlement legs of a fill.
 *
 * 1. Calls EVM escrow `lock` to lock source funds
 * 2. Calls Soroban `fill_intent` to deliver destination assets
 * 3. Tracks settlement status and handles idempotent retries
 */

import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  http,
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
  Account,
} from "@stellar/stellar-sdk";
import {
  PerihelionEscrowClient,
  ESCROW_ABI,
  MIN_FILL_HEADROOM_SECS,
  OnChainIntentStatus,
  decodeIntentStatus,
  evmAddressToBytes32,
  resolveInclusionFeePolicy,
  submitWithFeeEscalation,
  type InclusionFeePolicy,
} from "@perihelion/sdk";
import type { SignedIntent } from "@perihelion/sdk";
import type { Logger } from "@perihelion/node-common";

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

/**
 * Thrown when the escrow already holds a lock for the intent that is owned by
 * a different solver. This solver can never complete the fill, so the solver
 * retires the intent rather than retrying it.
 *
 * Extends {@link DefiniteFailureError}: no lock of ours was created, so the
 * inventory reservation is released immediately.
 */
export class LockOwnedByOtherError extends DefiniteFailureError {
  /** The solver address that owns the existing lock. */
  readonly owner: `0x${string}`;

  constructor(intentHash: string, owner: `0x${string}`) {
    super(`intent ${intentHash} already locked by another solver ${owner}`);
    this.name = "LockOwnedByOtherError";
    this.owner = owner;
  }
}

/**
 * Derive the solver's EVM address from a configured private key.
 *
 * The escrow enforces `preferredSolver == msg.sender`, so the address the
 * solver uses for eligibility decisions must be the one derived from the key
 * it signs `lock` transactions with.  Exposed so the CLI/config can validate
 * `PERIHELION_SOLVER_ADDRESS` against it at startup.
 */
export function deriveEvmAddress(privateKey: Hex): `0x${string}` {
  return privateKeyToAccount(privateKey).address;
}

/**
 * True when `err` (or any error in its `cause` chain) is a viem
 * `ContractFunctionRevertedError` — i.e. the contract call reverted during
 * simulation, before anything was broadcast.
 */
function isContractFunctionRevertedError(err: unknown): boolean {
  if (err instanceof ContractFunctionRevertedError) return true;
  if (err instanceof BaseError) {
    return err.walk((e) => e instanceof ContractFunctionRevertedError) !== null;
  }
  return false;
}

/** Logger interface for structured logging. */

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
  /**
   * Safety buffer (in stroops) added on top of the quoted LayerZero fee for
   * the FillConfirmed message dispatched by `fill_intent`. Defaults to 0.
   */
  readonly lzFeeBufferStroops?: bigint;
  /**
   * Additional safety buffer as basis points of the quoted LayerZero fee for
   * the FillConfirmed message (e.g. 500 = 5%). Applied on top of
   * {@link lzFeeBufferStroops}. Defaults to 0.
   */
  readonly lzFeeBufferBps?: number;
  /**
   * How often to poll the settlement contract's `status` while waiting for
   * registration, in ms. Defaults to {@link DEFAULT_REGISTRATION_POLL_INTERVAL_MS}.
   */
  readonly registrationPollIntervalMs?: number;
  /**
   * Minimum time (in seconds) that must remain before the intent deadline for
   * the executor to keep waiting for registration or submit `fill_intent`. The
   * settlement contract rejects fills inside its dispatch window, so this can
   * never be lower than the SDK's {@link MIN_FILL_HEADROOM_SECS}. Defaults to it.
   */
  readonly minFillHeadroomSecs?: number;
  /**
   * Operator policy for the Soroban inclusion-fee bid on `fill_intent`: the
   * `getFeeStats` percentile to follow, the floor, and the hard cap.
   */
  readonly inclusionFee?: InclusionFeePolicy;
  /**
   * Number of source-chain confirmations to wait for after the EVM lock
   * before polling Stellar for intent registration. Defaults to 1.
   */
  readonly sourceConfirmations?: number;
  /**
   * Optional persistence hook for per-intent fill progress. Called whenever
   * the executor advances to a new stage so a restart can resume there.
   */
  readonly persistStage?: (intentHash: Hex, stage: FillStage) => void | Promise<void>;
  /**
   * Optional loader for a previously persisted stage. Called at the start of
   * `fill` so a restart resumes at the right stage.
   */
  readonly loadStage?: (intentHash: Hex) => FillStage | undefined | Promise<FillStage | undefined>;
}

/** Idempotency check result. */
interface FillStatus {
  filled: boolean;
  unknown?: boolean;
  settlementTx?: string;
}

/**
 * Resumable stages of a fill. Persisted per intent so a retry or restart
 * resumes at the right point instead of re-running completed legs.
 *
 * - `lock`:    EVM escrow lock has not been observed yet
 * - `wait`:    lock exists; waiting for the FillInstruction to register on Stellar
 * - `fill`:    intent is registered on Stellar; `fill_intent` may be submitted
 * - `done`:    fill settled
 * - `lost`:    another solver owns the lock; retire the intent
 */
export type FillStage = "lock" | "wait" | "fill" | "done" | "lost";

/** Names of the settlement contract's `IntentStatus` variants, as returned by {@link Executor.readStatus}. */
export type IntentStatusName = "Locked" | "Filled" | "ConfirmationSent" | "Cancelled";

/** Maps each decoded on-chain status to its variant name. */
const INTENT_STATUS_NAMES: Record<OnChainIntentStatus, IntentStatusName> = {
  [OnChainIntentStatus.Locked]: "Locked",
  [OnChainIntentStatus.Filled]: "Filled",
  [OnChainIntentStatus.ConfirmationSent]: "ConfirmationSent",
  [OnChainIntentStatus.Cancelled]: "Cancelled",
};

/** Result of reading `locks(intentHash)` from the EVM escrow. */
interface EscrowLock {
  user: `0x${string}`;
  solver: `0x${string}`;
  released: boolean;
  refunded: boolean;
}

/** Fee metrics recorded for a fill. */
export interface FillFees {
  sourceGasWei: bigint;
  lzFeeWei: bigint;
  stellarFeeStroops: bigint;
}

/**
 * How many times to poll for a Soroban transaction confirmation before
 * giving up. Each attempt sleeps SOROBAN_POLL_INTERVAL_MS.
 */
const SOROBAN_MAX_POLL_ATTEMPTS = 30;
const SOROBAN_POLL_INTERVAL_MS = 2_000;

/** Default for how often to poll the settlement contract's `status` view, in ms. */
export const DEFAULT_REGISTRATION_POLL_INTERVAL_MS = 2_000;

/**
 * Minimum headroom (in seconds) that must remain before the intent deadline
 * for the executor to attempt a fill. Re-exported from `@perihelion/sdk`.
 */
export { MIN_FILL_HEADROOM_SECS };

/**
 * Execute a fill by orchestrating EVM lock and Soroban fill_intent.
 *
 * Handles idempotent retries: before re-filling, queries current status
 * to avoid double-fills.
 */
export class Executor {
  private readonly evmRpcUrl: string;
  private readonly sorobanRpcUrl: string;
  private sorobanRpcServer?: SorobanRpc.Server;
  /** One Soroban RPC client per process, created on first use. */
  private get rpc(): SorobanRpc.Server {
    this.sorobanRpcServer ??= new SorobanRpc.Server(this.sorobanRpcUrl);
    return this.sorobanRpcServer;
  }
  private readonly evmPrivateKey: Hex;
  private readonly sorobanSecretKey: string;
  private readonly escrowAddress: `0x${string}`;
  private readonly settlementContractId: string;
  private readonly sourceChainId: number;
  private readonly stellarNetwork: string;
  private readonly lzFeeBufferStroops: bigint;
  private readonly lzFeeBufferBps: bigint;
  private readonly registrationPollIntervalMs: number;
  private readonly minFillHeadroomSecs: number;
  private readonly inclusionFee: Required<InclusionFeePolicy>;
  private readonly sourceConfirmations: number;
  private readonly persistStage?: (intentHash: Hex, stage: FillStage) => void | Promise<void>;
  private readonly loadStage?: (
    intentHash: Hex,
  ) => FillStage | undefined | Promise<FillStage | undefined>;
  private readonly logger: Logger;

  constructor(config: ExecutorConfig, logger: Logger = console) {
    if (!config) {
      throw new Error("Executor requires an ExecutorConfig");
    }
    this.evmRpcUrl = config.evmRpcUrl;
    this.sorobanRpcUrl = config.sorobanRpcUrl;
    this.evmPrivateKey = config.evmPrivateKey;
    this.sorobanSecretKey = config.sorobanSecretKey;
    this.escrowAddress = config.escrowAddress;
    this.settlementContractId = config.settlementContractId;
    this.sourceChainId = config.sourceChainId;
    this.stellarNetwork = config.stellarNetwork;
    // Validate the policy up front so a bad cap fails at startup, not mid-fill.
    this.inclusionFee = resolveInclusionFeePolicy(config.inclusionFee);
    this.lzFeeBufferStroops = config.lzFeeBufferStroops ?? 0n;
    this.lzFeeBufferBps = BigInt(config.lzFeeBufferBps ?? 0);
    this.registrationPollIntervalMs =
      config.registrationPollIntervalMs ?? DEFAULT_REGISTRATION_POLL_INTERVAL_MS;
    this.minFillHeadroomSecs = config.minFillHeadroomSecs ?? MIN_FILL_HEADROOM_SECS;
    if (this.minFillHeadroomSecs < MIN_FILL_HEADROOM_SECS) {
      throw new Error(
        `minFillHeadroomSecs (${this.minFillHeadroomSecs}) must be at least ${MIN_FILL_HEADROOM_SECS}, the settlement contract's dispatch window`,
      );
    }
    this.sourceConfirmations = config.sourceConfirmations ?? 1;
    this.logger = logger;
  }

  /** The solver's EVM address, derived from the configured private key. */
  get address(): `0x${string}` {
    return deriveEvmAddress(this.evmPrivateKey);
  }

  /**
   * Fill an intent: lock source funds and deliver destination assets.
   *
   * The fill is split into resumable stages (see {@link FillStage}) persisted
   * per intent, so a retry after a partial failure resumes at the right stage
   * instead of re-running completed legs:
   *
   *   1. `lock` — submit the EVM escrow lock, unless a lock already exists
   *      (idempotent; a lock owned by another solver retires the intent).
   *   2. `wait` — wait for source-chain confirmations, then poll the
   *      settlement contract's `status(hash)` until the FillInstruction has
   *      registered the intent as `Locked`, bounded by the intent deadline
   *      minus the configured fill headroom.
   *   3. `fill` — call `fill_intent` with the quoted LayerZero fee.
   */
  async fill(signed: SignedIntent): Promise<{
    settlementTx: string;
    fees?: FillFees;
  }> {
    const { hash } = signed;

    // Check if already filled (idempotency)
    const status = await this.checkFillStatus(hash);
    if (status.filled && status.settlementTx) {
      this.logger.info("intent already settled, skipping", { hash });
      await this.setStage(hash, "done");
      return { settlementTx: status.settlementTx };
    }

    // Resume from a persisted stage if one exists.
    let stage: FillStage = (await this.loadStage?.(hash)) ?? "lock";
    this.logger.info("fill stage", { hash, stage });

    let lockTx: Hex | undefined;
    let sourceGasWei = 0n;
    let lzFeeWei = 0n;

    // ── Stage 1: lock ──────────────────────────────────────────────────────
    if (stage === "lock") {
      const existing = await this.getLock(hash);
      if (existing && existing.user !== ZERO_ADDRESS) {
        const account = privateKeyToAccount(this.evmPrivateKey);
        if (existing.solver.toLowerCase() !== account.address.toLowerCase()) {
          this.logger.warn("intent locked by another solver, retiring", {
            hash,
            solver: existing.solver,
          });
          await this.setStage(hash, "lost");
          throw new LockOwnedByOtherError(hash, existing.solver);
        }
        if (existing.released || existing.refunded) {
          throw new DefiniteFailureError(
            `intent ${hash} lock already ${existing.released ? "released" : "refunded"}`,
          );
        }
        // Our own live lock exists: skip locking and resume at the wait stage.
        this.logger.info("existing lock found, skipping lock", { hash });
        stage = "wait";
        await this.setStage(hash, stage);
      } else {
        const lockResult = await this.lockOnEvm(signed);
        lockTx = lockResult.txHash;
        sourceGasWei = lockResult.gasWei;
        lzFeeWei = lockResult.lzFeeWei;
        this.logger.info("locked on EVM", { hash, lockTx });
        stage = "wait";
        await this.setStage(hash, stage);
      }
    }

    // ── Stage 2: wait for registration ─────────────────────────────────────
    if (stage === "wait") {
      if (lockTx) {
        await this.waitForSourceConfirmations(lockTx);
      }
      await this.waitForRegistration(signed);
      stage = "fill";
      await this.setStage(hash, stage);
    }

    // ── Stage 3: fill ──────────────────────────────────────────────────────
    if (stage === "fill") {
      // Re-check headroom at submission time: registration may have completed
      // close to the deadline, and the contract would reject the fill anyway.
      this.assertFillHeadroom(signed);
      const fillResult = await this.fillOnSoroban(signed, lockTx ?? "0x");
      const settlementTx = fillResult.txHash;
      const stellarFeeStroops = fillResult.feeStroops;
      this.logger.info("filled on Soroban", { hash, settlementTx, stellarFeeStroops });
      await this.setStage(hash, "done");

      return {
        settlementTx,
        fees: {
          sourceGasWei,
          lzFeeWei,
          stellarFeeStroops,
        },
      };
    }

    throw new Error(`fill for ${hash} cannot proceed from stage ${stage}`);
  }

  /**
   * Throw when the intent deadline is within the configured fill headroom.
   * The lock already exists at this point, so this is not a definite failure:
   * the reservation must be kept until the lock is resolved.
   */
  private assertFillHeadroom(signed: SignedIntent): void {
    const deadline = BigInt(signed.intent.deadline);
    const now = BigInt(Math.floor(Date.now() / 1000));
    if (now + BigInt(this.minFillHeadroomSecs) >= deadline) {
      throw new Error(
        `intent ${signed.hash} deadline is within the ${this.minFillHeadroomSecs}s fill headroom; not submitting fill_intent`,
      );
    }
  }

  /** Persist the current fill stage and log it. */
  private async setStage(intentHash: Hex, stage: FillStage): Promise<void> {
    this.logger.info("fill stage", { hash: intentHash, stage });
    await this.persistStage?.(intentHash, stage);
  }

  /**
   * Read `locks(intentHash)` from the EVM escrow. Returns `undefined` when no
   * lock exists (user is the zero address).
   */
  private async getLock(intentHash: Hex): Promise<EscrowLock | undefined> {
    // Delegate to the SDK's escrow client, which decodes the full 8-field
    // `locks(bytes32)` getter. Hand-decoding it here previously read `asset`
    // as `released`.
    const escrow = new PerihelionEscrowClient(
      createPublicClient({ transport: http(this.evmRpcUrl) }),
      createWalletClient({
        account: privateKeyToAccount(this.evmPrivateKey),
        transport: http(this.evmRpcUrl),
      }),
      this.escrowAddress,
    );
    const lock = await escrow.getLock(intentHash);
    if (!lock) return undefined;
    return {
      user: lock.user,
      solver: lock.solver,
      released: lock.released,
      refunded: lock.refunded,
    };
  }

  /** Wait for the configured number of source-chain confirmations. */
  private async waitForSourceConfirmations(txHash: Hex): Promise<void> {
    if (this.sourceConfirmations <= 0) return;
    const publicClient = createPublicClient({
      transport: http(this.evmRpcUrl),
    });
    await publicClient.waitForTransactionReceipt({
      hash: txHash,
      confirmations: this.sourceConfirmations,
    });
  }

  /**
   * Poll the settlement contract's `status(hash)` until the intent is
   * registered as `Locked`, bounded by the intent deadline minus the
   * configured fill headroom.
   */
  private async waitForRegistration(signed: SignedIntent): Promise<void> {
    const { hash, intent } = signed;
    const deadline = BigInt(intent.deadline);
    const cutoff = deadline - BigInt(this.minFillHeadroomSecs);

    for (;;) {
      const variant = await this.readStatus(hash);
      // Registered (Locked), or already past registration (Filled/ConfirmationSent).
      if (variant === "Locked" || variant === "Filled" || variant === "ConfirmationSent") return;
      if (variant === "Cancelled") {
        throw new DefiniteFailureError(`intent ${hash} is ${variant} before fill`);
      }

      const now = BigInt(Math.floor(Date.now() / 1000));
      if (now >= cutoff) {
        throw new Error(
          `intent ${hash} not registered before deadline headroom (status=${variant ?? "unknown"})`,
        );
      }
      await sleep(this.registrationPollIntervalMs);
    }
  }

  /**
   * Check if an intent has already been filled (idempotency check).
   * Queries Soroban to see if status() reports a completed fill.
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
    return { filled: false };
  }

  /**
   * Check if an intent is settled on the Soroban settlement contract.
   *
   * Simulates a single-invocation transaction calling `status(intent_hash)`
   * and decodes the returned `Option<IntentStatus>` (a `u32` discriminant,
   * or void when the intent is not registered).
   *
   * For idempotency purposes an intent counts as complete once the
   * destination assets have been delivered, i.e. status is `Filled` or
   * `ConfirmationSent`. `Locked` and `Cancelled` are not complete, and
   * `undefined` means the intent is not registered at all.
   */
  private async isSettled(intentHash: Hex): Promise<boolean> {
    const status = await this.readStatus(intentHash);
    return status === "Filled" || status === "ConfirmationSent";
  }

  /**
   * Simulate `status(intent_hash)` on the settlement contract and decode the
   * returned enum variant, or `null` when the intent is not registered or the
   * simulation fails.
   */
  private async readStatus(intentHash: Hex): Promise<IntentStatusName | null> {
    const rpc = this.rpc;
    // A view simulation does not need a real sequence number, so use a
    // zero-sequence source account instead of a getAccount round-trip. This
    // also works before the signer account is funded.
    const account = new Account(Keypair.fromSecret(this.sorobanSecretKey).publicKey(), "0");

    const contract = new Contract(this.settlementContractId);

    // intentHash is 0x-prefixed 32-byte hex; decode to raw bytes for the
    // Soroban bytes32 argument.
    const hashBytes = hexToBytes(intentHash);

    const tx = new TransactionBuilder(account, {
      fee: "100",
      networkPassphrase: this.stellarNetwork,
    })
      .addOperation(contract.call("status", xdr.ScVal.scvBytes(Buffer.from(hashBytes))))
      .setTimeout(30)
      .build();

    const simulated = await rpc.simulateTransaction(tx);
    if (!SorobanRpc.Api.isSimulationSuccess(simulated) || !simulated.result) {
      return null;
    }

    const status = decodeIntentStatus(simulated.result.retval);
    return status === undefined ? null : INTENT_STATUS_NAMES[status];
  }

  /**
   * Lock funds in the EVM escrow contract.
   *
   * 1. Derives the solver address from the private key.
   * 2. Quotes the LayerZero messaging fee.
   * 3. Calls `escrow.lock(intent, signature, value)`.
   * 4. Waits for the receipt and returns the tx hash.
   */
  private async lockOnEvm(
    signed: SignedIntent,
  ): Promise<{ txHash: Hex; gasWei: bigint; lzFeeWei: bigint }> {
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
    const nativeFee = (await publicClient.readContract({
      address: this.escrowAddress,
      abi: ESCROW_ABI,
      functionName: "quoteFee",
      args: [contractIntent, account.address],
    })) as bigint;

    let txHash: Hex;
    try {
      txHash = await walletClient.writeContract({
        account,
        chain: null, // chain is resolved from the RPC endpoint
        address: this.escrowAddress,
        abi: ESCROW_ABI,
        functionName: "lock",
        args: [contractIntent, signature],
        value: nativeFee,
      });
    } catch (err) {
      // A revert surfaced by writeContract happens during simulation, before
      // broadcast: no capital moved, so the reservation can be released.
      if (isContractFunctionRevertedError(err)) {
        throw new DefiniteFailureError("escrow lock reverted", { cause: err });
      }
      throw err;
    }

    // Wait for the transaction to be included in a block.
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    const gasWei = (receipt.gasUsed ?? 0n) * (receipt.effectiveGasPrice ?? 0n);

    return { txHash, gasWei, lzFeeWei: nativeFee };
  }

  /**
   * Fill the intent on Soroban: deliver destination assets and dispatch
   * FillConfirmed back to the source chain over LayerZero.
   *
   * Calls `fill_intent(solver, solver_evm, intent_hash, fill_amount, lz_fee)`:
   *   - solver:       this solver's Stellar address (derived from the secret key)
   *   - solver_evm:   this solver's EVM address as `bytes32(uint256(uint160(addr)))`
   *                   (left-padded, address at offset 12). The settlement
   *                   contract forwards these 32 bytes verbatim in the
   *                   FillConfirmed message; the EVM escrow's
   *                   `_decodeFillConfirmed` rejects any value whose upper 12
   *                   bytes are non-zero.
   *   - intent_hash:  32-byte raw bytes derived from the 0x-prefixed intentHash
   *   - fill_amount:  intent.minDestAmount (i128)
   *   - lz_fee:       quoted from the settlement contract's
   *                   `quote_fill_confirmed_fee(src_eid)` plus the configured
   *                   safety buffer; the endpoint rejects underpayment with
   *                   `InsufficientLzFee`.
   *
   * Returns the transaction hash and the Stellar-side fee actually charged
   * (read from the transaction result), for fee metrics.
   */
  private async fillOnSoroban(
    signed: SignedIntent,
    _lockTx: Hex,
  ): Promise<{ txHash: Hex; feeStroops: bigint }> {
    const { intent, hash: intentHash } = signed;

    const keypair = Keypair.fromSecret(this.sorobanSecretKey);
    const rpc = this.rpc;
    const account = await rpc.getAccount(keypair.publicKey());

    const contract = new Contract(this.settlementContractId);

    // intent_hash: 0x-prefixed 32-byte hex → raw bytes → Soroban BytesN<32>
    const hashBytes = hexToBytes(intentHash);

    // solver_evm: derive from the EVM private key and encode as a 32-byte
    // word with the address left-padded (offset 12), matching the EVM escrow's
    // `bytes32(uint256(uint160(addr)))` expectation.
    const solverEvm = privateKeyToAccount(this.evmPrivateKey).address;
    const solverEvmBytes = evmAddressToBytes32(solverEvm);

    // solver Stellar address (authorizing the call)
    const solverStellar = nativeToScVal(keypair.publicKey(), { type: "address" });

    // fill_amount = minDestAmount as i128
    const fillAmount = BigInt(intent.minDestAmount);

    // Quote the LayerZero fee for the FillConfirmed message and add the
    // configured safety buffer.
    const quotedFee = await this.quoteFillConfirmedFee(intent.sourceChainId);
    const lzFee =
      quotedFee + this.lzFeeBufferStroops + (quotedFee * this.lzFeeBufferBps) / 10_000n;

    const args = [
      solverStellar,
      xdr.ScVal.scvBytes(Buffer.from(solverEvmBytes)), // solver_evm: BytesN<32>
      xdr.ScVal.scvBytes(Buffer.from(hashBytes)), // intent_hash: BytesN<32>
      nativeToScVal(fillAmount, { type: "i128" }), // fill_amount: i128
      nativeToScVal(lzFee, { type: "i128" }), // lz_fee: i128 (quoted)
    ];

    // Each attempt is built and simulated at its own inclusion-fee bid. A
    // TRY_AGAIN_LATER or an expiry escalates the bid within the operator's cap
    // and resubmits with the same sequence number, so at most one attempt applies.
    const landed = await submitWithFeeEscalation({
      rpc,
      signerPublicKey: keypair.publicKey(),
      sequence: account.sequenceNumber(),
      policy: this.inclusionFee,
      logger: this.logger,
      prepare: async (attemptAccount, inclusionFeeStroops) => {
        const attempt = new TransactionBuilder(attemptAccount, {
          fee: String(inclusionFeeStroops),
          networkPassphrase: this.stellarNetwork,
        })
          .addOperation(contract.call("fill_intent", ...args))
          .setTimeout(60)
          .build();

        // Simulation failure: the transaction was never submitted.
        const simulated = await rpc.simulateTransaction(attempt);
        if (!SorobanRpc.Api.isSimulationSuccess(simulated)) {
          throw new DefiniteFailureError(
            `fill_intent simulation failed: ${String(simulated.error)}`,
          );
        }
        return SorobanRpc.assembleTransaction(attempt, simulated).build();
      },
      sign: (transaction) => transaction.sign(keypair),
      submitOptions: {
        maxAttempts: SOROBAN_MAX_POLL_ATTEMPTS,
        pollIntervalMs: SOROBAN_POLL_INTERVAL_MS,
      },
    });

    // The fee is the one the ledger charged, so fee metrics reflect what was paid.
    return { txHash: landed.hash as Hex, feeStroops: landed.feeChargedStroops };
  }

  /**
   * Quote the LayerZero fee for the FillConfirmed message dispatched by
   * `fill_intent`, by simulating `quote_fill_confirmed_fee(src_eid)` on the
   * settlement contract.
   */
  private async quoteFillConfirmedFee(srcEid: number): Promise<bigint> {
    const rpc = this.rpc;
    // View simulation: a zero-sequence source account is sufficient (see readStatus).
    const account = new Account(Keypair.fromSecret(this.sorobanSecretKey).publicKey(), "0");

    const contract = new Contract(this.settlementContractId);

    const tx = new TransactionBuilder(account, {
      fee: "100",
      networkPassphrase: this.stellarNetwork,
    })
      .addOperation(
        contract.call("quote_fill_confirmed_fee", nativeToScVal(BigInt(srcEid), { type: "u32" })),
      )
      .setTimeout(30)
      .build();

    const simulated = await rpc.simulateTransaction(tx);
    if (!SorobanRpc.Api.isSimulationSuccess(simulated) || !simulated.result) {
      throw new Error(
        `quote_fill_confirmed_fee simulation failed: ${String((simulated as { error?: unknown }).error)}`,
      );
    }

    return BigInt(scValToNative(simulated.result.retval) as bigint);
  }
}

// ─── Utilities ────────────────────────────────────────────────────────────────

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

/** Resolve after `ms` milliseconds. Used for registration and confirmation polling. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The zero address, used to detect the absence of an escrow lock. */
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;
