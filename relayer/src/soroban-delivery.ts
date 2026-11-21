// SPDX-License-Identifier: MIT

/**
 * Soroban destination delivery: submits verified LayerZero messages to the
 * Stellar settlement contract, restoring archived entries as needed.
 */

import {
  SorobanRpc,
  TransactionBuilder,
  Keypair,
  Contract,
  nativeToScVal,
  scValToNative,
  xdr,
  Address,
  Asset,
  Operation,
  type Account,
  type Transaction,
} from "@stellar/stellar-sdk";
import {
  evmAddressToBytes32,
  resolveInclusionFeePolicy,
  submitAndWait,
  submitWithFeeEscalation,
  type InclusionFeePolicy,
} from "@perihelion/sdk";
import { FatalError, type DestinationDelivery } from "./relayer.js";
import { noopLogger, type Logger } from "@perihelion/node-common";
import {
  CANCEL_INTENT_LENGTH,
  FILL_INSTRUCTION_LENGTH,
  type PendingMessage,
  type MessageKey,
} from "./types.js";

/**
 * Settlement contract `IntentStatus` discriminants.
 *
 * `IntentStatus` is a `#[contracttype]` C-like enum with explicit
 * discriminants, which Soroban encodes as a `u32`. `status()` returns
 * `Option<IntentStatus>`, so `scValToNative` yields a number or `undefined`.
 */
export enum IntentStatus {
  Locked = 0,
  Filled = 1,
  ConfirmationSent = 2,
  Cancelled = 3,
}

/**
 * Decode the return value of the settlement contract's `status(intent_hash)`
 * view into an {@link IntentStatus}.
 *
 * Returns `undefined` when the intent is not registered (`None` / void) or the
 * value is not a recognised discriminant.
 */
export function decodeIntentStatus(retval: xdr.ScVal | undefined | null): IntentStatus | undefined {
  if (!retval) return undefined;
  let native: unknown;
  try {
    native = scValToNative(retval);
  } catch {
    return undefined;
  }
  if (native === undefined || native === null) return undefined;
  const numeric = typeof native === "bigint" ? Number(native) : native;
  if (typeof numeric !== "number" || !Number.isInteger(numeric)) return undefined;
  switch (numeric) {
    case IntentStatus.Locked:
      return IntentStatus.Locked;
    case IntentStatus.Filled:
      return IntentStatus.Filled;
    case IntentStatus.ConfirmationSent:
      return IntentStatus.ConfirmationSent;
    case IntentStatus.Cancelled:
      return IntentStatus.Cancelled;
    default:
      return undefined;
  }
}

/** Configuration for SorobanDestinationDelivery. */
export interface SorobanDeliveryConfig {
  /** Soroban RPC endpoint URL. */
  rpcUrl: string;
  /** Stellar network passphrase (e.g., "Test SDF Network ; September 2015"). */
  networkPassphrase: string;
  /** ID of the settlement contract on Soroban. */
  settlementContractId: string;
  /** Signer keypair or secret key for submitting transactions. */
  signerSecret: string;
  /** EVM escrow contract address on the source chain (for peer fallback). */
  escrowAddress?: string;
  /** Transaction timeout in seconds (default 30). */
  timeoutSeconds?: number;
  /** Structured logger for delivery diagnostics. Defaults to silent. */
  logger?: Logger;
  /**
   * Operator policy for the inclusion fee bid on each submission: which
   * `getFeeStats` percentile to follow, the floor and the hard cap.
   */
  inclusionFee?: InclusionFeePolicy;
}

/**
 * Concrete DestinationDelivery for Soroban: submits lz_receive calls to the
 * settlement contract, prepending RestoreFootprint ops for archived entries.
 */
export class SorobanDestinationDelivery implements DestinationDelivery {
  private rpc: SorobanRpc.Server;
  private networkPassphrase: string;
  private settlementContractId: string;
  private signerSecret: string;
  private signerKeypair: Keypair;
  private timeoutSeconds: number;
  private readonly inclusionFee: Required<InclusionFeePolicy>;
  private readonly logger: Logger;

  constructor(private config: SorobanDeliveryConfig) {
    this.logger = config.logger ?? noopLogger;
    this.rpc = new SorobanRpc.Server(config.rpcUrl);
    this.networkPassphrase = config.networkPassphrase;
    this.settlementContractId = config.settlementContractId;
    this.signerSecret = config.signerSecret;
    this.signerKeypair = Keypair.fromSecret(config.signerSecret);
    this.timeoutSeconds = config.timeoutSeconds ?? 30;
    // Validate the policy up front so a bad cap fails at startup, not mid-delivery.
    this.inclusionFee = resolveInclusionFeePolicy(config.inclusionFee);
  }

  async deliver(pending: PendingMessage): Promise<string> {
    try {
      // 1. Restore archived entries first. A RestoreFootprint transaction uses
      // a sequence number of its own, so it must land before step 2 reads it.
      await this.restoreArchivedEntries(pending);

      // 2. Read the sequence once. Every fee attempt reuses it, so at most one
      // attempt can ever apply.
      const account = await this.getSignerAccount();

      // 3. Submit at an inclusion-fee bid taken from network fee stats. A
      // TRY_AGAIN_LATER or an expiry resubmits at a higher bid within the cap.
      const landed = await submitWithFeeEscalation({
        rpc: this.rpc,
        signerPublicKey: this.signerKeypair.publicKey(),
        sequence: account.sequenceNumber(),
        policy: this.inclusionFee,
        logger: this.logger,
        prepare: async (attemptAccount, inclusionFeeStroops) => {
          const { transaction, simulated } = await this.simulateLzReceive(
            attemptAccount,
            pending,
            inclusionFeeStroops,
          );
          if (!SorobanRpc.Api.isSimulationSuccess(simulated)) {
            throw new Error(`Simulation failed: ${String(simulated.error)}`);
          }
          return SorobanRpc.assembleTransaction(transaction, simulated).build();
        },
        sign: (transaction) => transaction.sign(this.signerKeypair),
      });

      // The fee charged comes from the ledger result, not from the bid.
      this.logger.info("delivered to Soroban", {
        hash: landed.hash,
        attempts: landed.attempts,
        inclusionFeeStroops: landed.inclusionFeeStroops,
        feeChargedStroops: landed.feeChargedStroops.toString(),
      });
      return landed.hash;
    } catch (err) {
      if (err instanceof FatalError) throw err;
      if (err instanceof Error && /signer|secret key|network passphrase/i.test(err.message)) {
        throw new FatalError("Soroban delivery configuration is invalid", err);
      }
      throw new Error(`Failed to deliver to Soroban: ${String(err)}`, { cause: err });
    }
  }

  async isDelivered(key: MessageKey): Promise<boolean> {
    try {
      const { intentHash, messageType } = key;
      const status = await this.readStatus(intentHash);

      // Map message type to delivery criteria.
      // FillInstruction is delivered once the intent is registered at all.
      // CancelIntent is delivered when status == Cancelled.
      // FillConfirmed is delivered when the fill is complete (Filled or
      // ConfirmationSent).
      if (messageType === "FillInstruction") {
        return status !== undefined;
      }
      if (messageType === "CancelIntent") {
        return status === IntentStatus.Cancelled;
      }
      if (messageType === "FillConfirmed") {
        return status === IntentStatus.Filled || status === IntentStatus.ConfirmationSent;
      }

      return false;
    } catch (err) {
      // Stringify the error: Error objects serialize to {} in the JSON log stream.
      this.logger.error("Failed to check if delivered", { key, err: String(err) });
      return false;
    }
  }

  /**
   * Read the settlement contract's `status(intent_hash)` view.
   *
   * Soroban RPC has no direct "call a view" endpoint, so this simulates a
   * single-invocation transaction and decodes the return value. Returns the
   * numeric {@link IntentStatus}, or `undefined` if the intent is not
   * registered.
   */
  private async readStatus(intentHash: string): Promise<IntentStatus | undefined> {
    const contract = new Contract(this.settlementContractId);
    const account = await this.getSignerAccount();
    const tx = new TransactionBuilder(account, {
      fee: "100",
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(contract.call("status", this.intentHashScVal(intentHash)))
      .setTimeout(this.timeoutSeconds)
      .build();

    const simulated = await this.rpc.simulateTransaction(tx);
    if (!SorobanRpc.Api.isSimulationSuccess(simulated) || !simulated.result) return undefined;

    return decodeIntentStatus(simulated.result.retval);
  }

  /** Build and simulate the lz_receive transaction at the given per-operation fee. */
  private async simulateLzReceive(
    account: Account,
    pending: PendingMessage,
    inclusionFeeStroops: number,
  ): Promise<{ transaction: Transaction; simulated: SorobanRpc.Api.SimulateTransactionResponse }> {
    const builder = new TransactionBuilder(account, {
      fee: String(inclusionFeeStroops),
      networkPassphrase: this.networkPassphrase,
    });
    await this.appendLzReceiveCall(builder, pending);
    builder.setTimeout(this.timeoutSeconds);
    const transaction = builder.build();
    const simulated = await this.rpc.simulateTransaction(transaction);
    return { transaction, simulated };
  }

  /** Restore the footprint of archived entries when a simulation asks for it. */
  private async restoreArchivedEntries(pending: PendingMessage): Promise<void> {
    const account = await this.getSignerAccount();
    const { simulated } = await this.simulateLzReceive(account, pending, 100);
    if (SorobanRpc.Api.isSimulationRestore(simulated)) {
      await this.restoreFootprint(simulated.restorePreamble);
    }
  }

  private async getSignerAccount(): Promise<Account> {
    return await this.rpc.getAccount(this.signerKeypair.publicKey());
  }

  /**
   * Submit a `RestoreFootprint` transaction for the footprint provided by a
   * simulation's `restorePreamble`, and wait for it to be included.
   */
  private async restoreFootprint(preamble: SorobanRpc.Api.RestorePreamble): Promise<void> {
    const account = await this.getSignerAccount();
    const transaction = new TransactionBuilder(account, {
      fee: preamble.minResourceFee,
      networkPassphrase: this.networkPassphrase,
    })
      .setSorobanData(preamble.transactionData.build())
      .addOperation(Operation.restoreFootprint({}))
      .setTimeout(this.timeoutSeconds)
      .build();

    transaction.sign(this.signerKeypair);
    await submitAndWait(this.rpc, transaction);
  }

  private async getPeer(srcEid: number): Promise<Buffer | null> {
    try {
      const contract = new Contract(this.settlementContractId);
      const account = await this.getSignerAccount();
      const tx = new TransactionBuilder(account, {
        fee: "100",
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(contract.call("get_peer", nativeToScVal(srcEid, { type: "u32" })))
        .setTimeout(this.timeoutSeconds)
        .build();

      const simulated = await this.rpc.simulateTransaction(tx);
      if (!SorobanRpc.Api.isSimulationSuccess(simulated) || !simulated.result) return null;
      const native = scValToNative(simulated.result.retval);
      if (Buffer.isBuffer(native) && native.length === 32) return native;
      if (native instanceof Uint8Array && native.length === 32) return Buffer.from(native);
      return null;
    } catch {
      return null;
    }
  }

  private resolveDestAssetScVal(destAsset: string): xdr.ScVal {
    try {
      if (destAsset === "native" || !destAsset) {
        const contractId = Asset.native().contractId(this.networkPassphrase);
        return new Address(contractId).toScVal();
      }
      if (destAsset.includes(":")) {
        const [code, issuer] = destAsset.split(":");
        if (code && issuer) {
          const contractId = new Asset(code, issuer).contractId(this.networkPassphrase);
          return new Address(contractId).toScVal();
        }
      }
      return new Address(destAsset).toScVal();
    } catch {
      return nativeToScVal(destAsset, { type: "address" });
    }
  }

  private async appendLzReceiveCall(
    builder: TransactionBuilder,
    pending: PendingMessage,
  ): Promise<TransactionBuilder> {
    const { message } = pending;
    const { srcEid, nonce, rawPayload } = message;
    if (!/^0x[0-9a-fA-F]+$/.test(rawPayload)) {
      throw new FatalError("Missing canonical LayerZero message payload");
    }
    const payloadLength = (rawPayload.length - 2) / 2;
    const expectedLength =
      message.messageType === "FillInstruction" ? FILL_INSTRUCTION_LENGTH : CANCEL_INTENT_LENGTH;
    if (payloadLength !== expectedLength) {
      throw new FatalError(`Invalid canonical payload length: ${payloadLength}`);
    }
    if (message.messageType === "FillInstruction") {
      const deadline = message.deadline;
      if (deadline === undefined || deadline === null) {
        throw new FatalError("Missing deadline on FillInstruction message");
      }
      const deadlineValue = typeof deadline === "bigint" ? deadline : BigInt(deadline);
      if (deadlineValue <= 0n) {
        throw new FatalError(`Invalid deadline on FillInstruction message: ${String(deadline)}`);
      }
    }
    const contract = new Contract(this.settlementContractId);
    const senderBytes = await this.getPeer(srcEid);
    if (!senderBytes) {
      throw new FatalError(`No trusted peer configured for source eid ${srcEid}`);
    }
    const reason = message.reason ?? 0;
    const originScVal = xdr.ScVal.scvMap([
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol("nonce"),
        val: nativeToScVal(BigInt(nonce), { type: "u64" }),
      }),
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol("sender"),
        val: xdr.ScVal.scvBytes(senderBytes),
      }),
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol("src_eid"),
        val: nativeToScVal(srcEid, { type: "u32" }),
      }),
    ]);
    const guidScVal = xdr.ScVal.scvBytes(Buffer.alloc(32));
    builder.addOperation(
      contract.call(
        "lz_receive_bytes",
        originScVal,
        guidScVal,
        nativeToScVal(Buffer.from(rawPayload.slice(2), "hex"), { type: "bytes" }),
      ),
    );
    return builder;
  }

  private cancelReasonScVal(reason: number): xdr.ScVal {
    return nativeToScVal(reason, { type: "u32" });
  }

  private escrowSenderBytes(): Buffer {
    if (!this.config.escrowAddress) {
      throw new FatalError("No escrow address configured for peer fallback");
    }
    return evmAddressToBytes32(this.config.escrowAddress);
  }

  private intentHashScVal(intentHash: string) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(intentHash)) {
      throw new FatalError("Invalid intent hash: expected a 32-byte hex value");
    }

    const bytes = Buffer.from(intentHash.slice(2), "hex");
    if (bytes.length !== 32) {
      throw new FatalError("Invalid intent hash: expected exactly 32 bytes");
    }
    return nativeToScVal(bytes, { type: "bytes" });
  }
}
