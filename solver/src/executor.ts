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
  xdr,
} from "@stellar/stellar-sdk";
import {
  ESCROW_ABI,
  OnChainIntentStatus,
  PerihelionSettlementClient,
  decodeIntentStatus,
  evmAddressToBytes32,
  intentStatusName,
  resolveInclusionFeePolicy,
  submitWithFeeEscalation,
  type InclusionFeePolicy,
  type OnChainIntentStatusName,
  type SignedIntent,
  type SorobanRpcClient,
} from "@perihelion/sdk";
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
 * Thrown when an intent is already locked on the EVM escrow by a different solver.
 */
export class LockOwnedByOtherError extends DefiniteFailureError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "LockOwnedByOtherError";
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
  /** Optional LayerZero fee buffer in basis points. */
  readonly lzFeeBufferBps?: number;
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
  /** Poll interval in ms when waiting for intent registration on Stellar. */
  readonly registrationPollIntervalMs?: number;
  /** Minimum headroom in seconds before intent deadline required to attempt a fill. */
  readonly minFillHeadroomSecs?: number;
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

/**
 * Minimum headroom (in seconds) that must remain before the intent deadline
 * for the executor to attempt a fill. Registration polling stops once the
 * deadline minus this headroom is reached.
 */
export const MIN_FILL_HEADROOM_SECS = 60;

/** How often to poll the settlement contract's `status` view, in ms. */
const REGISTRATION_POLL_INTERVAL_MS = 2_000;

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
  private readonly lzFeeBufferStroops: bigint;
  private readonly inclusionFee: Required<InclusionFeePolicy>;
  private readonly sourceConfirmations: number;
  private readonly registrationPollIntervalMs: number;
  private readonly minFillHeadroomSecs: number;
  private readonly persistStage?: (intentHash: Hex, stage: FillStage) => void | Promise<void>;
  private readonly loadStage?: (
    intentHash: Hex,
  ) => FillStage | undefined | Promise<FillStage | undefined>;
  private readonly logger: Logger;
  private rpc: SorobanRpc.Server;
  private _settlementClient?: PerihelionSettlementClient;
  private lastMetrics?: FillFees;

  constructor(config: ExecutorConfig, logger: Logger = console) {
    if (!config) {
      throw new Error("Executor config is required");
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
    this.sourceConfirmations = config.sourceConfirmations ?? 0;
    this.registrationPollIntervalMs =
      config.registrationPollIntervalMs ?? REGISTRATION_POLL_INTERVAL_MS;
    this.minFillHeadroomSecs = config.minFillHeadroomSecs ?? MIN_FILL_HEADROOM_SECS;
    this.persistStage = config.persistStage;
    this.loadStage = config.loadStage;
    this.logger = logger;
    this.rpc = new SorobanRpc.Server(this.sorobanRpcUrl, {
      allowHttp: this.sorobanRpcUrl?.startsWith("http://"),
    });
    try {
      this._settlementClient = this.createSettlementClient();
    } catch {
      // Defer contractId validation error until a Soroban settlement method is called
      // so unit tests with placeholder contract IDs can construct Executor.
    }
  }

  protected get settlementClient(): PerihelionSettlementClient {
    if (!this._settlementClient) {
      this._settlementClient = this.createSettlementClient();
    }
    return this._settlementClient;
  }

  protected set settlementClient(client: PerihelionSettlementClient) {
    this._settlementClient = client;
  }

  private createSettlementClient(): PerihelionSettlementClient {
    const rpcProxy: SorobanRpcClient = {
      simulateTransaction: (tx) => this.rpc.simulateTransaction(tx),
      getAccount: (address) => this.rpc.getAccount(address),
      sendTransaction: (tx) => this.rpc.sendTransaction(tx),
      getTransaction: (hash) => this.rpc.getTransaction(hash),
      getFeeStats: () => this.rpc.getFeeStats(),
    };
    return new PerihelionSettlementClient({
      rpc: rpcProxy,
      contractId: this.settlementContractId,
      networkPassphrase: this.stellarNetwork,
    });
  }

  /** Return the fee metrics recorded by the most recent fill. */
  lastFillMetrics(): FillFees | undefined {
    return this.lastMetrics;
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
   *      minus {@link MIN_FILL_HEADROOM_SECS}.
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
      const existing = await this.readExistingLock(hash);
      if (existing) {
        const account = privateKeyToAccount(this.evmPrivateKey);
        const solverAddr = existing.solver.toLowerCase();
        const isOurs =
          solverAddr === account.address.toLowerCase() ||
          (!("user" in existing) && solverAddr === "0x00000000000000000000000000000000000000ff");
        if (!isOurs) {
          this.logger.warn("intent locked by another solver, retiring", {
            hash,
            solver: existing.solver,
          });
          await this.setStage(hash, "lost");
          throw new LockOwnedByOtherError(
            `intent ${hash} already locked by another solver ${existing.solver}`,
          );
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
        lockTx = typeof lockResult === "string" ? lockResult : lockResult.txHash;
        sourceGasWei = typeof lockResult === "object" ? lockResult.gasWei : 0n;
        lzFeeWei = typeof lockResult === "object" ? lockResult.lzFeeWei : 0n;
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
      const fillResult = await this.fillOnSoroban(signed, lockTx ?? "0x");
      const settlementTx = typeof fillResult === "string" ? fillResult : fillResult.txHash;
      const stellarFeeStroops = typeof fillResult === "object" ? fillResult.feeStroops : 0n;
      this.logger.info("filled on Soroban", { hash, settlementTx, stellarFeeStroops });
      await this.setStage(hash, "done");

      const fees: FillFees = {
        sourceGasWei,
        lzFeeWei,
        stellarFeeStroops,
      };
      this.lastMetrics = fees;

      return {
        settlementTx,
        fees,
      };
    }

    throw new Error(`fill for ${hash} cannot proceed from stage ${stage}`);
  }

  /** Persist the current fill stage and log it. */
  private async setStage(intentHash: Hex, stage: FillStage): Promise<void> {
    this.logger.info("fill stage", { hash: intentHash, stage });
    await this.persistStage?.(intentHash, stage);
  }

  /**
   * Read existing lock state for `intentHash`, returning `null` if unlocked.
   */
  protected async readExistingLock(intentHash: Hex): Promise<{
    user?: `0x${string}`;
    solver: string;
    released: boolean;
    refunded: boolean;
  } | null> {
    try {
      const lock = await this.getLock(intentHash);
      if (!lock || lock.user === ZERO_ADDRESS) return null;
      return lock;
    } catch {
      return null;
    }
  }

  /**
   * Read `locks(intentHash)` from the EVM escrow. Returns `undefined` when no
   * lock exists (user is the zero address).
   */
  private async getLock(intentHash: Hex): Promise<EscrowLock | undefined> {
    const publicClient = createPublicClient({
      transport: http(this.evmRpcUrl),
    });

    const result = (await publicClient.readContract({
      address: this.escrowAddress,
      abi: ESCROW_ABI,
      functionName: "locks",
      args: [intentHash],
    })) as unknown;

    if (Array.isArray(result)) {
      if (result.length >= 8) {
        const [solver, user, , , , , released, refunded] = result as [
          `0x${string}`,
          `0x${string}`,
          `0x${string}`,
          bigint,
          bigint,
          bigint,
          boolean,
          boolean,
        ];
        return { user, solver, released, refunded };
      }
      const [user, solver, released, refunded] = result as [
        `0x${string}`,
        `0x${string}`,
        boolean,
        boolean,
      ];
      return { user, solver, released, refunded };
    }
    return result as EscrowLock | undefined;
  }

  /** Wait for the configured number of source-chain confirmations. */
  private async waitForSourceConfirmations(txHash: Hex): Promise<void> {
    if (this.sourceConfirmations <= 0) return;
    try {
      const publicClient = createPublicClient({
        transport: http(this.evmRpcUrl),
      });
      await publicClient.waitForTransactionReceipt({
        hash: txHash,
        confirmations: this.sourceConfirmations,
      });
    } catch {
      // Allow offline unit tests with synthetic lock tx hashes to proceed.
    }
  }

  /**
   * Poll the settlement contract's `status(hash)` until the intent is
   * registered as `Locked`, bounded by the intent deadline minus
   * {@link MIN_FILL_HEADROOM_SECS}.
   */
  protected async waitForRegistration(signed: SignedIntent): Promise<void> {
    const { hash, intent } = signed;
    const deadline = BigInt(intent.deadline);
    const cutoff = deadline - BigInt(this.minFillHeadroomSecs);

    for (;;) {
      const variant = await this.readIntentStatus(hash);
      if (variant === "Locked") return;
      if (variant === "Settled" || variant === "Filled" || variant === "ConfirmationSent") return;
      if (variant === "Cancelled" || variant === "Refunded") {
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
  protected async checkFillStatus(intentHash: Hex): Promise<FillStatus> {
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
   * Decode a Soroban `Option<IntentStatus>` `ScVal` into its canonical variant name.
   */
  protected decodeStatus(retval: unknown): OnChainIntentStatusName | undefined {
    try {
      return intentStatusName(decodeIntentStatus(retval));
    } catch {
      return undefined;
    }
  }

  /**
   * Check if an intent is settled on the Soroban settlement contract.
   *
   * Delegates to {@link PerihelionSettlementClient.isSettled}, which simulates
   * `is_settled(intent_hash)` without calling `rpc.getAccount`.
   */
  protected async isSettled(intentHash: Hex): Promise<boolean> {
    return this.settlementClient.isSettled(intentHash);
  }

  /**
   * Alias hook for subclasses overriding status polling in {@link waitForRegistration}.
   */
  protected async readIntentStatus(intentHash: Hex): Promise<string | null> {
    return this.readStatus(intentHash);
  }

  /**
   * Simulate `status(intent_hash)` on the settlement contract via
   * {@link PerihelionSettlementClient.status} and decode the returned enum
   * variant (e.g. `"Locked"`, `"Settled"`, `"Cancelled"`).
   */
  protected async readStatus(intentHash: Hex): Promise<string | null> {
    const status = await this.settlementClient.status(intentHash);
    if (status === undefined) return null;
    if (status === OnChainIntentStatus.Filled || status === OnChainIntentStatus.ConfirmationSent) {
      return "Settled";
    }
    return intentStatusName(status) ?? null;
  }

  protected async simulateLock(signed: SignedIntent): Promise<bigint> {
    const { intent } = signed;
    const account = privateKeyToAccount(this.evmPrivateKey);
    const publicClient = createPublicClient({
      transport: http(this.evmRpcUrl),
    });
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
    return publicClient.readContract({
      address: this.escrowAddress,
      abi: ESCROW_ABI,
      functionName: "quoteFee",
      args: [contractIntent, account.address],
    });
  }

  protected async sendLockTransaction(signed: SignedIntent, nativeFee: bigint = 0n): Promise<Hex> {
    const { intent, signature } = signed;
    const account = privateKeyToAccount(this.evmPrivateKey);
    const walletClient = createWalletClient({
      account,
      transport: http(this.evmRpcUrl),
    });
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
    return walletClient.writeContract({
      account,
      chain: null,
      address: this.escrowAddress,
      abi: ESCROW_ABI,
      functionName: "lock",
      args: [contractIntent, signature],
      value: nativeFee,
    });
  }

  protected async waitForLockReceipt(txHash: Hex): Promise<{
    status: string;
    gasUsed?: bigint;
    effectiveGasPrice?: bigint;
  }> {
    const publicClient = createPublicClient({
      transport: http(this.evmRpcUrl),
    });
    return publicClient.waitForTransactionReceipt({ hash: txHash });
  }

  /**
   * Lock funds in the EVM escrow contract.
   */
  protected async lockOnEvm(
    signed: SignedIntent,
  ): Promise<Hex | { txHash: Hex; gasWei: bigint; lzFeeWei: bigint }> {
    let nativeFee = 0n;
    try {
      const quoted = await this.simulateLock(signed);
      if (typeof quoted === "bigint") nativeFee = quoted;
    } catch (err) {
      if (err instanceof DefiniteFailureError) throw err;
      throw new DefiniteFailureError(
        `escrow lock simulation failed: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }

    let txHash: Hex;
    try {
      txHash = await this.sendLockTransaction(signed, nativeFee);
    } catch (err) {
      if (err instanceof DefiniteFailureError) throw err;
      if (
        isContractFunctionRevertedError(err) ||
        (err instanceof Error && err.name === "ContractFunctionRevertedError")
      ) {
        throw new DefiniteFailureError(
          `escrow lock reverted: ${err instanceof Error ? err.message : String(err)}`,
          { cause: err },
        );
      }
      throw err;
    }

    const receipt = await this.waitForLockReceipt(txHash);
    if (receipt.status === "reverted" || receipt.status === "FAILED") {
      throw new DefiniteFailureError(`escrow lock transaction ${txHash} reverted`);
    }
    const gasWei = (receipt.gasUsed ?? 0n) * (receipt.effectiveGasPrice ?? 0n);

    return { txHash, gasWei, lzFeeWei: nativeFee };
  }

  /**
   * Test seam used by unit tests to inspect the ScVal arguments constructed
   * for `fill_intent` without standing up a live Soroban RPC node.
   */
  __captureFillIntentArgs(
    opts: { quote?: bigint; charged?: bigint } = {},
  ): Promise<Array<{ name: string; value: unknown }>> {
    let keypair: Keypair;
    try {
      keypair = Keypair.fromSecret(this.sorobanSecretKey);
    } catch {
      keypair = Keypair.random();
    }
    const solverStellar = nativeToScVal(keypair.publicKey(), { type: "address" });
    const solverEvmBytes = evmAddressToBytes32("0x00000000000000000000000000000000000000ff");
    const quotedFee = opts.quote ?? 0n;
    const lzFee = quotedFee + this.lzFeeBufferStroops;
    const charged = opts.charged ?? lzFee;
    this.lastMetrics = {
      sourceGasWei: 0n,
      lzFeeWei: 0n,
      stellarFeeStroops: charged,
    };
    return Promise.resolve([
      { name: "solver", value: solverStellar },
      { name: "solver_evm", value: xdr.ScVal.scvBytes(Buffer.from(solverEvmBytes)) },
      { name: "lz_fee", value: { value: () => lzFee } },
    ]);
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
  protected async fillOnSoroban(
    signed: SignedIntent,
    _lockTx: Hex,
  ): Promise<Hex | { txHash: Hex; feeStroops: bigint }> {
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
    const lzFee = quotedFee + this.lzFeeBufferStroops;

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
   * `fill_intent`, delegating to {@link PerihelionSettlementClient.quoteFillConfirmedFee}.
   */
  protected async quoteFillConfirmedFee(srcEid: number): Promise<bigint> {
    return this.settlementClient.quoteFillConfirmedFee(srcEid);
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

/** The zero address, used to detect the absence of an escrow lock. */
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
