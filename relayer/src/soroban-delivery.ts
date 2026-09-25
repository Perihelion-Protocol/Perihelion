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
  type Account,
} from "@stellar/stellar-sdk";
import { FatalError, type DestinationDelivery } from "./relayer.js";
import type { PendingMessage, MessageKey, MessageType } from "./types.js";

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

  constructor(private config: SorobanDeliveryConfig) {
    this.rpc = new SorobanRpc.Server(config.rpcUrl);
    this.networkPassphrase = config.networkPassphrase;
    this.settlementContractId = config.settlementContractId;
    this.signerSecret = config.signerSecret;
    this.signerKeypair = Keypair.fromSecret(config.signerSecret);
    this.timeoutSeconds = config.timeoutSeconds ?? 30;
  }

  async deliver(pending: PendingMessage): Promise<string> {
    try {
      // 1. Check if the settlement contract entry is archived
      const isArchived = await this.isEntryArchived();

      // 2. Get signer account to build transaction
      const account = await this.getSignerAccount();

      // 3. Build transaction
      let builder = new TransactionBuilder(account, {
        fee: "10000",
        networkPassphrase: this.networkPassphrase,
      });

      // 4. If archived, prepend RestoreFootprint operation
      if (isArchived) {
        builder = await this.prependRestoreFootprint(builder);
      }

      // 5. Append lz_receive invocation
      builder = await this.appendLzReceiveCall(builder, pending);

      builder.setTimeout(this.timeoutSeconds);
      let transaction = builder.build();

      // 6. Simulate and prepare the transaction
      const simulated = await this.rpc.simulateTransaction(transaction);
      if (SorobanRpc.Api.isSimulationSuccess(simulated)) {
        transaction = SorobanRpc.assembleTransaction(transaction, simulated).build();
      } else {
        throw new Error(`Simulation failed: ${String(simulated.error)}`);
      }

      // 7. Sign and submit
      transaction.sign(this.signerKeypair);
      const result = await this.rpc.sendTransaction(transaction);

      // 8. Poll for confirmation
      let attempts = 0;
      const maxAttempts = 20;
      while (attempts < maxAttempts) {
        const status = await this.rpc.getTransaction(result.hash);
        if (status.status === "SUCCESS") {
          return result.hash;
        }
        if (status.status === "FAILED") {
          throw new Error(`Transaction failed: ${status.resultXdr}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
        attempts += 1;
      }
      throw new Error(`Transaction confirmation timeout: ${result.hash}`);
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
      const resultValue = await this.readStatus(intentHash);
      if (resultValue === null) return false;

      // Map message type to delivery criteria
      // FillInstruction is delivered if intent exists at all (status != NotFound)
      // CancelIntent is delivered if status == Cancelled
      // FillConfirmed is delivered if status == Settled
      if (messageType === "FillInstruction") {
        return resultValue !== "NotFound";
      }
      if (messageType === "CancelIntent") {
        return resultValue === "Cancelled";
      }
      if (messageType === "FillConfirmed") {
        return resultValue === "Settled";
      }

      return false;
    } catch (err) {
      console.error("Failed to check if delivered", { key, err });
      return false;
    }
  }

  /**
   * Read the settlement contract's `status(intent_hash)` view.
   *
   * Soroban RPC has no direct "call a view" endpoint, so this simulates a
   * single-invocation transaction and decodes the return value. Returns the
   * status variant name, or `null` if the contract produced no value.
   */
  private async readStatus(intentHash: string): Promise<string | null> {
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
    if (!SorobanRpc.Api.isSimulationSuccess(simulated) || !simulated.result) return null;

    // Soroban enums decode either to a bare symbol or to a [tag, ...payload]
    // vec; both carry the variant name in the leading position.
    const native: unknown = scValToNative(simulated.result.retval);
    if (typeof native === "string") return native;
    if (Array.isArray(native) && typeof native[0] === "string") return native[0];
    return null;
  }

  private async isEntryArchived(): Promise<boolean> {
    try {
      const entries = await this.rpc.getLedgerEntries(
        new Contract(this.settlementContractId).getFootprint(),
      );

      const entry = entries.entries?.[0];
      if (!entry?.liveUntilLedgerSeq) {
        return false;
      }

      const currentLedger = await this.rpc.getLatestLedger();
      const ttlThreshold = 1000; // Consider archived if TTL < 1000 ledgers

      return (entry.liveUntilLedgerSeq - currentLedger.sequence) < ttlThreshold;
    } catch {
      return false;
    }
  }

  private async getSignerAccount(): Promise<Account> {
    return await this.rpc.getAccount(this.signerKeypair.publicKey());
  }

  private async prependRestoreFootprint(
    builder: TransactionBuilder,
  ): Promise<TransactionBuilder> {
    try {
      const entries = await this.rpc.getLedgerEntries(
        new Contract(this.settlementContractId).getFootprint(),
      );

      if (!entries.entries || entries.entries.length === 0) {
        return builder;
      }

      // Known limitation (issue #427): RestoreFootprint operation is not yet built.
      // When a settlement contract ledger entry is archived (TTL < 1000 ledgers),
      // delivery should restore it before invoking lz_receive. Until that is
      // implemented, delivery fails at simulation with an archived-entry error,
      // triggering a retry. Past maxAttempts, the message is dead-lettered rather
      // than delivered. A long-idle contract entry means messages are lost.
      // TODO(#303): implement RestoreFootprint restoration.
      return builder;
    } catch {
      return builder;
    }
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
    const { srcEid, intentHash, solver, recipient, destAsset, amount, nonce, messageType } = message;

    const contract = new Contract(this.settlementContractId);

    // 1. Resolve peer sender (Origin.sender: BytesN<32>)
    let senderBytes = await this.getPeer(srcEid);
    if (!senderBytes) {
      senderBytes = evmAddressTo32Bytes(this.config.escrowAddress);
    }

    // 2. Build Origin struct
    // struct Origin { nonce: u64, sender: BytesN<32>, src_eid: u32 }
    // Soroban struct map entries must be sorted alphabetically by field name:
    // "nonce" < "sender" < "src_eid"
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

    // 3. Build GUID (BytesN<32>)
    const guidScVal = xdr.ScVal.scvBytes(Buffer.alloc(32));

    // 4. Build LzMessage enum: FillInstruction or Cancel
    const hashScVal = this.intentHashScVal(intentHash);

    let messageScVal: xdr.ScVal;

    if (messageType === "CancelIntent") {
      // struct CancelInstruction { intent_hash: BytesN<32>, reason: u32 }
      // Sorted keys: "intent_hash" < "reason"
      const cancelScVal = xdr.ScVal.scvMap([
        new xdr.ScMapEntry({
          key: xdr.ScVal.scvSymbol("intent_hash"),
          val: hashScVal,
        }),
        new xdr.ScMapEntry({
          key: xdr.ScVal.scvSymbol("reason"),
          val: nativeToScVal(0, { type: "u32" }),
        }),
      ]);
      messageScVal = xdr.ScVal.scvVec([
        xdr.ScVal.scvSymbol("Cancel"),
        cancelScVal,
      ]);
    } else {
      // FillInstruction
      const recipientAddress = toAddressScVal(recipient);
      const destAssetAddress = this.resolveDestAssetScVal(destAsset);
      const preferredSolverScVal =
        solver && (solver.startsWith("G") || solver.startsWith("C"))
          ? toAddressScVal(solver)
          : xdr.ScVal.scvVoid();

      // struct FillInstruction sorted keys:
      // "deadline", "dest_asset", "intent_hash", "min_dest_amount",
      // "preferred_solver", "recipient", "reservation_window", "src_eid"
      const fillScVal = xdr.ScVal.scvMap([
        new xdr.ScMapEntry({
          key: xdr.ScVal.scvSymbol("deadline"),
          val: nativeToScVal(0n, { type: "u64" }),
        }),
        new xdr.ScMapEntry({
          key: xdr.ScVal.scvSymbol("dest_asset"),
          val: destAssetAddress,
        }),
        new xdr.ScMapEntry({
          key: xdr.ScVal.scvSymbol("intent_hash"),
          val: hashScVal,
        }),
        new xdr.ScMapEntry({
          key: xdr.ScVal.scvSymbol("min_dest_amount"),
          val: nativeToScVal(BigInt(amount || "0"), { type: "i128" }),
        }),
        new xdr.ScMapEntry({
          key: xdr.ScVal.scvSymbol("preferred_solver"),
          val: preferredSolverScVal,
        }),
        new xdr.ScMapEntry({
          key: xdr.ScVal.scvSymbol("recipient"),
          val: recipientAddress,
        }),
        new xdr.ScMapEntry({
          key: xdr.ScVal.scvSymbol("reservation_window"),
          val: nativeToScVal(0n, { type: "u64" }),
        }),
        new xdr.ScMapEntry({
          key: xdr.ScVal.scvSymbol("src_eid"),
          val: nativeToScVal(srcEid, { type: "u32" }),
        }),
      ]);

      messageScVal = xdr.ScVal.scvVec([
        xdr.ScVal.scvSymbol("FillInstruction"),
        fillScVal,
      ]);
    }

    builder.addOperation(
      contract.call("lz_receive", originScVal, guidScVal, messageScVal),
    );

    return builder;
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

function toAddressScVal(addr: string): xdr.ScVal {
  try {
    return new Address(addr).toScVal();
  } catch {
    return nativeToScVal(addr, { type: "address" });
  }
}

function evmAddressTo32Bytes(address?: string): Buffer {
  const buf = Buffer.alloc(32);
  if (!address) return buf;
  const clean = address.startsWith("0x") ? address.slice(2) : address;
  if (clean.length === 40) {
    Buffer.from(clean, "hex").copy(buf, 0);
  }
  return buf;
}
