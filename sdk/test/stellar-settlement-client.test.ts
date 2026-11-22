// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  Account,
  Address,
  Keypair,
  SorobanDataBuilder,
  StrKey,
  nativeToScVal,
  scValToNative,
  xdr,
  type SorobanRpc,
  type Transaction,
} from "@stellar/stellar-sdk";
import {
  CONTRACT_SPEC_ENTRIES,
  DEFAULT_STELLAR_NETWORK_PASSPHRASE,
  DUMMY_STELLAR_SOURCE_ACCOUNT,
  OnChainIntentStatus,
  PerihelionContractError,
  PerihelionError,
  PerihelionSettlementClient,
  PerihelionValidationError,
  SETTLEMENT_CONTRACT_SPEC,
  SETTLEMENT_ERROR_CODES,
  decodeIntentStatus,
  decodeSettlementError,
  decodeSettlementIntentRecord,
  intentStatusName,
  isSettledStatus,
  type Hex,
  type SorobanRpcClient,
} from "../src/index.js";

const CONTRACT_ID = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
const TOKEN_CONTRACT_ID = "CA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJUWDA";
const USER_G_ADDRESS = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
const SOLVER_G_ADDRESS = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H";
const INTENT_HASH: Hex = "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const SOLVER_EVM_BYTES32: Hex =
  "0x0000000000000000000000001111111111111111111111111111111111111111";

interface CapturedCall {
  readonly method: string;
  readonly args: xdr.ScVal[];
  readonly source: string;
  readonly sequence: string;
  readonly fee: string;
}

function extractInvocation(tx: Transaction): CapturedCall {
  const op = tx.operations[0] as unknown as {
    func: {
      invokeContract(): {
        functionName(): Buffer | string;
        args(): xdr.ScVal[];
      };
    };
  };
  const invoke = op.func.invokeContract();
  return {
    method: invoke.functionName().toString(),
    args: invoke.args(),
    source: tx.source,
    sequence: tx.sequence,
    fee: tx.fee,
  };
}

function createStubRpc(
  handler: (
    call: CapturedCall,
    tx: Transaction,
  ) =>
    | SorobanRpc.Api.SimulateTransactionResponse
    | Promise<SorobanRpc.Api.SimulateTransactionResponse>,
) {
  const calls: CapturedCall[] = [];
  let getAccountCalls = 0;

  const rpc: SorobanRpcClient = {
    async simulateTransaction(tx: Transaction) {
      const captured = extractInvocation(tx);
      calls.push(captured);
      return await handler(captured, tx);
    },
    async getAccount(address: string) {
      getAccountCalls += 1;
      return new Account(address, "100");
    },
  };

  return {
    rpc,
    calls,
    get getAccountCalls() {
      return getAccountCalls;
    },
  };
}

function simSuccess(
  retval: xdr.ScVal,
  minResourceFee = "450",
): SorobanRpc.Api.SimulateTransactionResponse {
  return {
    id: "sim-1",
    latestLedger: 1234,
    events: [],
    minResourceFee,
    transactionData: new SorobanDataBuilder(),
    result: {
      auth: [],
      retval,
    },
  } as unknown as SorobanRpc.Api.SimulateTransactionResponse;
}

function simError(error: string): SorobanRpc.Api.SimulateTransactionResponse {
  return {
    id: "sim-err",
    latestLedger: 1234,
    events: [],
    error,
  } as unknown as SorobanRpc.Api.SimulateTransactionResponse;
}

function buildIntentRecordScVal(opts?: {
  withOptionals?: boolean;
  status?: OnChainIntentStatus;
  srcEid?: number;
}): xdr.ScVal {
  const withOptionals = opts?.withOptionals ?? true;
  const status = opts?.status ?? OnChainIntentStatus.Locked;
  const srcEid = opts?.srcEid ?? 30184;

  return xdr.ScVal.scvMap([
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("deadline"),
      val: nativeToScVal(1_700_000_600n, { type: "u64" }),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("dest_asset"),
      val: new Address(TOKEN_CONTRACT_ID).toScVal(),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("fill_amount"),
      val: nativeToScVal(withOptionals ? 9_950_000n : 0n, { type: "i128" }),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("fill_ledger"),
      val: xdr.ScVal.scvU32(withOptionals ? 1050 : 0),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("intent_hash"),
      val: xdr.ScVal.scvBytes(Buffer.from(INTENT_HASH.slice(2), "hex")),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("min_dest_amount"),
      val: nativeToScVal(9_900_000n, { type: "i128" }),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("preferred_solver"),
      val: withOptionals ? new Address(SOLVER_G_ADDRESS).toScVal() : xdr.ScVal.scvVoid(),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("recipient"),
      val: new Address(USER_G_ADDRESS).toScVal(),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("registered_ledger"),
      val: xdr.ScVal.scvU32(1000),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("reservation_expires"),
      val: nativeToScVal(1_700_000_120n, { type: "u64" }),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("solver"),
      val: withOptionals ? new Address(SOLVER_G_ADDRESS).toScVal() : xdr.ScVal.scvVoid(),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("solver_evm"),
      val: withOptionals
        ? xdr.ScVal.scvBytes(Buffer.from(SOLVER_EVM_BYTES32.slice(2), "hex"))
        : xdr.ScVal.scvVoid(),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("src_eid"),
      val: xdr.ScVal.scvU32(srcEid),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("status"),
      val: xdr.ScVal.scvU32(status),
    }),
  ]);
}

describe("decodeIntentStatus, intentStatusName & isSettledStatus", () => {
  it("decodes real xdr.ScVal u32, i32, symbol, vec, and void instances", () => {
    assert.equal(decodeIntentStatus(xdr.ScVal.scvU32(0)), OnChainIntentStatus.Locked);
    assert.equal(decodeIntentStatus(xdr.ScVal.scvU32(1)), OnChainIntentStatus.Filled);
    assert.equal(decodeIntentStatus(xdr.ScVal.scvU32(2)), OnChainIntentStatus.ConfirmationSent);
    assert.equal(decodeIntentStatus(xdr.ScVal.scvU32(3)), OnChainIntentStatus.Cancelled);

    assert.equal(decodeIntentStatus(xdr.ScVal.scvI32(1)), OnChainIntentStatus.Filled);
    assert.equal(decodeIntentStatus(xdr.ScVal.scvVoid()), undefined);
    assert.equal(decodeIntentStatus(undefined), undefined);
    assert.equal(decodeIntentStatus(null), undefined);

    assert.equal(decodeIntentStatus(xdr.ScVal.scvSymbol("Filled")), OnChainIntentStatus.Filled);
    assert.equal(
      decodeIntentStatus(xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("ConfirmationSent")])),
      OnChainIntentStatus.ConfirmationSent,
    );
  });

  it("decodes numbers, bigints, variant strings, and mock ScVal objects", () => {
    assert.equal(decodeIntentStatus(0), OnChainIntentStatus.Locked);
    assert.equal(decodeIntentStatus(1n), OnChainIntentStatus.Filled);
    assert.equal(decodeIntentStatus("ConfirmationSent"), OnChainIntentStatus.ConfirmationSent);
    assert.equal(decodeIntentStatus("Cancelled"), OnChainIntentStatus.Cancelled);

    assert.equal(
      decodeIntentStatus({ switch: { name: "scvU32" }, u32: 2 }),
      OnChainIntentStatus.ConfirmationSent,
    );
    assert.equal(
      decodeIntentStatus({ switch: { name: "scvU64" }, value: 3n }),
      OnChainIntentStatus.Cancelled,
    );
    assert.equal(decodeIntentStatus({ switch: { name: "scvVoid" } }), undefined);
  });

  it("throws on unknown discriminants or invalid variant names", () => {
    assert.throws(
      () => decodeIntentStatus(xdr.ScVal.scvU32(99)),
      /Unknown IntentStatus discriminant: 99/,
    );
    assert.throws(
      () => decodeIntentStatus("BogusVariant"),
      /Unknown IntentStatus variant: BogusVariant/,
    );
  });

  it("maps OnChainIntentStatus values to canonical names and settled classification", () => {
    assert.equal(intentStatusName(OnChainIntentStatus.Locked), "Locked");
    assert.equal(intentStatusName(OnChainIntentStatus.Filled), "Filled");
    assert.equal(intentStatusName(OnChainIntentStatus.ConfirmationSent), "ConfirmationSent");
    assert.equal(intentStatusName(OnChainIntentStatus.Cancelled), "Cancelled");
    assert.equal(intentStatusName(undefined), undefined);

    assert.equal(isSettledStatus(OnChainIntentStatus.Locked), false);
    assert.equal(isSettledStatus(OnChainIntentStatus.Filled), true);
    assert.equal(isSettledStatus(OnChainIntentStatus.ConfirmationSent), true);
    assert.equal(isSettledStatus(OnChainIntentStatus.Cancelled), false);
    assert.equal(isSettledStatus(undefined), false);
  });
});

describe("SETTLEMENT_CONTRACT_SPEC & decodeSettlementError", () => {
  it("exposes all Soroban settlement contract entrypoints", () => {
    const names = CONTRACT_SPEC_ENTRIES.map((e) => e.name);
    assert.deepEqual(names, [
      "status",
      "get_intent",
      "is_settled",
      "is_cancelled",
      "resolve_dest_asset",
      "quote_cancel_fee",
      "quote_fill_confirmed_fee",
      "get_peer",
      "cancel_expired_intent",
    ]);
    assert.equal(SETTLEMENT_CONTRACT_SPEC.cancel_expired_intent.readOnly, false);
    assert.equal(SETTLEMENT_CONTRACT_SPEC.status.readOnly, true);
  });

  it("maps Error(Contract, #code) to PerihelionContractError", () => {
    const err140 = decodeSettlementError(
      "HostError: Error(Contract, #140)",
      "cancel_expired_intent",
    );
    assert.ok(err140 instanceof PerihelionContractError);
    assert.equal(err140.errorName, "IntentNotFound");
    assert.equal(err140.selector, "#140");
    assert.deepEqual(err140.args, [140]);

    const err166 = decodeSettlementError(166, "resolve_dest_asset");
    assert.ok(err166 instanceof PerihelionContractError);
    assert.equal(err166.errorName, SETTLEMENT_ERROR_CODES[166]);

    const generic = decodeSettlementError("network timeout", "status");
    assert.ok(generic instanceof PerihelionError);
    assert.ok(!(generic instanceof PerihelionContractError));
  });
});

describe("PerihelionSettlementClient constructor", () => {
  it("supports options object, positional (rpc, contractId), and 64-char hex contractId", () => {
    const { rpc } = createStubRpc(() => simSuccess(xdr.ScVal.scvVoid()));

    const c1 = new PerihelionSettlementClient({ rpc, contractId: CONTRACT_ID });
    assert.equal(c1.contractId, CONTRACT_ID);
    assert.equal(c1.networkPassphrase, DEFAULT_STELLAR_NETWORK_PASSPHRASE);
    assert.equal(c1.sourceAccountId, DUMMY_STELLAR_SOURCE_ACCOUNT);

    const rawHex = Buffer.from(StrKey.decodeContract(CONTRACT_ID)).toString("hex");
    const c2 = new PerihelionSettlementClient(
      rpc,
      `0x${rawHex}`,
      "Public Global Stellar Network ; September 2015",
    );
    assert.equal(c2.contractId, CONTRACT_ID);
    assert.equal(c2.networkPassphrase, "Public Global Stellar Network ; September 2015");

    const c3 = new PerihelionSettlementClient("https://soroban-testnet.stellar.org", CONTRACT_ID);
    assert.equal(c3.contractId, CONTRACT_ID);
  });

  it("rejects invalid contractId, sourceAccountId, or missing rpc/rpcUrl", () => {
    const { rpc } = createStubRpc(() => simSuccess(xdr.ScVal.scvVoid()));

    assert.throws(
      () => new PerihelionSettlementClient({ rpc, contractId: "" }),
      PerihelionValidationError,
    );
    assert.throws(
      () => new PerihelionSettlementClient({ rpc, contractId: USER_G_ADDRESS }),
      PerihelionValidationError,
    );
    assert.throws(
      () =>
        new PerihelionSettlementClient({
          rpc,
          contractId: CONTRACT_ID,
          sourceAccountId: CONTRACT_ID,
        }),
      PerihelionValidationError,
    );
    assert.throws(
      () => new PerihelionSettlementClient({ contractId: CONTRACT_ID }),
      PerihelionValidationError,
    );
  });
});

describe("PerihelionSettlementClient read-only view methods", () => {
  it("status(intentHash) encodes 32-byte intent_hash, decodes all variants, and never calls getAccount", async () => {
    let currentRetval: xdr.ScVal = xdr.ScVal.scvVoid();
    const stub = createStubRpc((call) => {
      assert.equal(call.method, "status");
      assert.equal(call.args.length, 1);
      assert.deepEqual(
        Buffer.from(call.args[0]!.bytes()),
        Buffer.from(INTENT_HASH.slice(2), "hex"),
      );
      assert.equal(call.source, DUMMY_STELLAR_SOURCE_ACCOUNT);
      return simSuccess(currentRetval);
    });

    const client = new PerihelionSettlementClient({
      rpc: stub.rpc,
      contractId: CONTRACT_ID,
    });

    assert.equal(await client.status(INTENT_HASH), undefined);

    for (const expected of [
      OnChainIntentStatus.Locked,
      OnChainIntentStatus.Filled,
      OnChainIntentStatus.ConfirmationSent,
      OnChainIntentStatus.Cancelled,
    ]) {
      currentRetval = xdr.ScVal.scvU32(expected);
      assert.equal(await client.status(INTENT_HASH), expected);
    }

    assert.equal(stub.getAccountCalls, 0);
    assert.equal(stub.calls.length, 5);

    await assert.rejects(() => client.status("0x1234" as Hex), PerihelionValidationError);
  });

  it("getIntent(intentHash) decodes Option<IntentRecord> with Some and None optional fields without calling getAccount", async () => {
    let currentRetval: xdr.ScVal = xdr.ScVal.scvVoid();
    const stub = createStubRpc((call) => {
      assert.equal(call.method, "get_intent");
      assert.equal(call.args.length, 1);
      assert.deepEqual(
        Buffer.from(call.args[0]!.bytes()),
        Buffer.from(INTENT_HASH.slice(2), "hex"),
      );
      return simSuccess(currentRetval);
    });

    const client = new PerihelionSettlementClient({
      rpc: stub.rpc,
      contractId: CONTRACT_ID,
    });

    // 1. None (scvVoid) -> undefined
    assert.equal(await client.getIntent(INTENT_HASH), undefined);

    // 2. Full IntentRecord with Some(preferred_solver), Some(solver), Some(solver_evm)
    currentRetval = buildIntentRecordScVal({
      withOptionals: true,
      status: OnChainIntentStatus.Filled,
      srcEid: 30184,
    });
    const filledRecord = await client.getIntent(INTENT_HASH);
    assert.ok(filledRecord);
    assert.equal(filledRecord.intentHash, INTENT_HASH);
    assert.equal(filledRecord.srcEid, 30184);
    assert.equal(filledRecord.recipient, USER_G_ADDRESS);
    assert.equal(filledRecord.destAsset, TOKEN_CONTRACT_ID);
    assert.equal(filledRecord.minDestAmount, 9_900_000n);
    assert.equal(filledRecord.deadline, 1_700_000_600n);
    assert.equal(filledRecord.preferredSolver, SOLVER_G_ADDRESS);
    assert.equal(filledRecord.reservationExpires, 1_700_000_120n);
    assert.equal(filledRecord.status, OnChainIntentStatus.Filled);
    assert.equal(filledRecord.solver, SOLVER_G_ADDRESS);
    assert.equal(filledRecord.solverEvm, SOLVER_EVM_BYTES32);
    assert.equal(filledRecord.fillAmount, 9_950_000n);
    assert.equal(filledRecord.fillLedger, 1050);
    assert.equal(filledRecord.registeredLedger, 1000);

    // 3. Locked IntentRecord with None (scvVoid) for preferred_solver, solver, solver_evm
    currentRetval = buildIntentRecordScVal({
      withOptionals: false,
      status: OnChainIntentStatus.Locked,
    });
    const lockedRecord = await client.getIntent(INTENT_HASH);
    assert.ok(lockedRecord);
    assert.equal(lockedRecord.status, OnChainIntentStatus.Locked);
    assert.equal(lockedRecord.preferredSolver, undefined);
    assert.equal(lockedRecord.solver, undefined);
    assert.equal(lockedRecord.solverEvm, undefined);
    assert.equal(lockedRecord.fillAmount, 0n);
    assert.equal(lockedRecord.fillLedger, 0);

    assert.equal(stub.getAccountCalls, 0);
  });

  it("decodeSettlementIntentRecord also accepts already-converted plain objects", () => {
    const decoded = decodeSettlementIntentRecord({
      intent_hash: INTENT_HASH,
      src_eid: 30184,
      recipient: USER_G_ADDRESS,
      dest_asset: TOKEN_CONTRACT_ID,
      min_dest_amount: 1000n,
      deadline: 2000n,
      preferred_solver: null,
      reservation_expires: 1500n,
      status: OnChainIntentStatus.Locked,
      solver: null,
      solver_evm: null,
      fill_amount: 0n,
      fill_ledger: 0,
      registered_ledger: 10,
    });
    assert.ok(decoded);
    assert.equal(decoded.intentHash, INTENT_HASH);
    assert.equal(decoded.preferredSolver, undefined);
  });

  it("isSettled(intentHash) invokes is_settled without calling getAccount", async () => {
    let currentRetval: xdr.ScVal = xdr.ScVal.scvBool(false);
    const stub = createStubRpc((call) => {
      assert.equal(call.method, "is_settled");
      assert.deepEqual(
        Buffer.from(call.args[0]!.bytes()),
        Buffer.from(INTENT_HASH.slice(2), "hex"),
      );
      return simSuccess(currentRetval);
    });

    const client = new PerihelionSettlementClient({
      rpc: stub.rpc,
      contractId: CONTRACT_ID,
    });

    assert.equal(await client.isSettled(INTENT_HASH), false);
    currentRetval = xdr.ScVal.scvBool(true);
    assert.equal(await client.isSettled(INTENT_HASH), true);
    assert.equal(stub.getAccountCalls, 0);
  });

  it("resolveDestAsset(destAsset) encodes UTF-8 bytes, decodes Address, and maps #166 / #169 contract errors", async () => {
    let simResponse: SorobanRpc.Api.SimulateTransactionResponse = simSuccess(
      new Address(TOKEN_CONTRACT_ID).toScVal(),
    );
    const stub = createStubRpc((call) => {
      assert.equal(call.method, "resolve_dest_asset");
      return simResponse;
    });

    const client = new PerihelionSettlementClient({
      rpc: stub.rpc,
      contractId: CONTRACT_ID,
    });

    for (const asset of ["native", `USDC:${USER_G_ADDRESS}`, TOKEN_CONTRACT_ID]) {
      const resolved = await client.resolveDestAsset(asset);
      assert.equal(resolved, TOKEN_CONTRACT_ID);
      const lastCall = stub.calls[stub.calls.length - 1]!;
      assert.equal(Buffer.from(lastCall.args[0]!.bytes()).toString("utf8"), asset);
    }

    assert.equal(stub.getAccountCalls, 0);

    // Client-side validation rejects invalid asset strings without RPC call
    const callsBefore = stub.calls.length;
    await assert.rejects(
      () => client.resolveDestAsset("INVALID:NOT_A_G_KEY"),
      PerihelionValidationError,
    );
    assert.equal(stub.calls.length, callsBefore);

    // Contract error #166 UnsupportedDestAsset
    simResponse = simError("HostError: Error(Contract, #166)");
    await assert.rejects(
      () => client.resolveDestAsset(TOKEN_CONTRACT_ID),
      (err: unknown) =>
        err instanceof PerihelionContractError &&
        err.errorName === "UnsupportedDestAsset" &&
        err.selector === "#166",
    );

    // Contract error #169 DestAssetSacNotDeployed
    simResponse = simError("HostError: Error(Contract, #169)");
    await assert.rejects(
      () => client.resolveDestAsset(`USDC:${USER_G_ADDRESS}`),
      (err: unknown) =>
        err instanceof PerihelionContractError &&
        err.errorName === "DestAssetSacNotDeployed" &&
        err.selector === "#169",
    );
  });

  it("quoteCancelFee(dstEid) and quoteFillConfirmedFee(dstEid) encode u32, decode i128, validate dstEid, and map #163", async () => {
    let simResponse: SorobanRpc.Api.SimulateTransactionResponse = simSuccess(
      nativeToScVal(125_000n, { type: "i128" }),
    );
    const stub = createStubRpc(() => simResponse);

    const client = new PerihelionSettlementClient({
      rpc: stub.rpc,
      contractId: CONTRACT_ID,
    });

    const cancelFee = await client.quoteCancelFee(30184);
    assert.equal(cancelFee, 125_000n);
    assert.equal(stub.calls[0]!.method, "quote_cancel_fee");
    assert.equal(stub.calls[0]!.args[0]!.u32(), 30184);

    simResponse = simSuccess(nativeToScVal(250_000n, { type: "i128" }));
    const confirmFee = await client.quoteFillConfirmedFee(30184);
    assert.equal(confirmFee, 250_000n);
    assert.equal(stub.calls[1]!.method, "quote_fill_confirmed_fee");
    assert.equal(stub.calls[1]!.args[0]!.u32(), 30184);

    assert.equal(stub.getAccountCalls, 0);

    for (const badEid of [0, -1, 1.5, Number.NaN, 0x1_0000_0000]) {
      await assert.rejects(() => client.quoteCancelFee(badEid), PerihelionValidationError);
      await assert.rejects(() => client.quoteFillConfirmedFee(badEid), PerihelionValidationError);
    }

    simResponse = simError("HostError: Error(Contract, #163)");
    await assert.rejects(
      () => client.quoteCancelFee(99999),
      (err: unknown) =>
        err instanceof PerihelionContractError &&
        err.errorName === "UntrustedPeer" &&
        err.selector === "#163",
    );
  });

  it("getPeer(eid) decodes 32-byte peer address and scvVoid without calling getAccount", async () => {
    const peerBytes = Buffer.alloc(32, 0xab);
    let currentRetval: xdr.ScVal = xdr.ScVal.scvBytes(peerBytes);
    const stub = createStubRpc((call) => {
      assert.equal(call.method, "get_peer");
      assert.equal(call.args[0]!.u32(), 30184);
      return simSuccess(currentRetval);
    });

    const client = new PerihelionSettlementClient({
      rpc: stub.rpc,
      contractId: CONTRACT_ID,
    });

    const peer = await client.getPeer(30184);
    assert.ok(peer);
    assert.deepEqual(Buffer.from(peer), peerBytes);

    currentRetval = xdr.ScVal.scvVoid();
    assert.equal(await client.getPeer(30184), undefined);
    assert.equal(stub.getAccountCalls, 0);
  });
});

describe("PerihelionSettlementClient.buildCancelExpiredTx", () => {
  it("builds, simulates, and assembles cancel_expired_intent(caller, intent_hash, lz_fee) for options and positional overloads", async () => {
    const stub = createStubRpc((call) => {
      assert.equal(call.method, "cancel_expired_intent");
      assert.equal(call.args.length, 3);
      assert.equal(Address.fromScVal(call.args[0]!).toString(), USER_G_ADDRESS);
      assert.deepEqual(
        Buffer.from(call.args[1]!.bytes()),
        Buffer.from(INTENT_HASH.slice(2), "hex"),
      );
      assert.equal(scValToNative(call.args[2]!), 150_000n);
      return simSuccess(xdr.ScVal.scvVoid(), "500");
    });

    const client = new PerihelionSettlementClient({
      rpc: stub.rpc,
      contractId: CONTRACT_ID,
    });

    // Options overload
    const tx1 = await client.buildCancelExpiredTx({
      caller: USER_G_ADDRESS,
      intentHash: INTENT_HASH,
      lzFee: 150_000n,
    });
    assert.equal(extractInvocation(tx1).method, "cancel_expired_intent");
    // Assembled fee = base fee (100) + minResourceFee (500) = 600
    assert.equal(tx1.fee, "600");

    // Positional overload with simulate: false
    const simCallsBefore = stub.calls.length;
    const rawTx = await client.buildCancelExpiredTx(USER_G_ADDRESS, INTENT_HASH, 150_000n, {
      simulate: false,
      fee: "250",
    });
    assert.equal(
      stub.calls.length,
      simCallsBefore,
      "simulate: false must skip simulateTransaction",
    );
    assert.equal(rawTx.fee, "250");
    assert.equal(extractInvocation(rawTx).method, "cancel_expired_intent");
  });

  it("auto-quotes lzFee via quoteCancelFee and looks up srcEid via getIntent when lzFee is omitted", async () => {
    const stub = createStubRpc((call) => {
      if (call.method === "get_intent") {
        return simSuccess(
          buildIntentRecordScVal({
            srcEid: 30184,
            status: OnChainIntentStatus.Locked,
          }),
        );
      }
      if (call.method === "quote_cancel_fee") {
        assert.equal(call.args[0]!.u32(), 30184);
        return simSuccess(nativeToScVal(100_000n, { type: "i128" }));
      }
      if (call.method === "cancel_expired_intent") {
        // Quoted 100_000n + buffer 5_000n = 105_000n
        assert.equal(scValToNative(call.args[2]!), 105_000n);
        return simSuccess(xdr.ScVal.scvVoid());
      }
      throw new Error(`Unexpected method: ${call.method}`);
    });

    const client = new PerihelionSettlementClient({
      rpc: stub.rpc,
      contractId: CONTRACT_ID,
    });

    const tx = await client.buildCancelExpiredTx({
      caller: USER_G_ADDRESS,
      intentHash: INTENT_HASH,
      lzFeeBufferStroops: 5_000n,
    });
    assert.equal(extractInvocation(tx).method, "cancel_expired_intent");
    assert.deepEqual(
      stub.calls.map((c) => c.method),
      ["get_intent", "quote_cancel_fee", "cancel_expired_intent"],
    );
  });

  it("maps cancel_expired_intent contract errors (#140, #141, #143, #146, #164) to PerihelionContractError", async () => {
    let activeCode = 140;
    const stub = createStubRpc(() => simError(`HostError: Error(Contract, #${activeCode})`));

    const client = new PerihelionSettlementClient({
      rpc: stub.rpc,
      contractId: CONTRACT_ID,
    });

    const expectedCases: ReadonlyArray<[number, string]> = [
      [140, "IntentNotFound"],
      [141, "IntentFinalized"],
      [143, "DeadlineNotPassed"],
      [146, "AlreadyFilled"],
      [164, "InsufficientLzFee"],
    ];

    for (const [code, expectedName] of expectedCases) {
      activeCode = code;
      await assert.rejects(
        () =>
          client.buildCancelExpiredTx({
            caller: USER_G_ADDRESS,
            intentHash: INTENT_HASH,
            lzFee: 100_000n,
          }),
        (err: unknown) =>
          err instanceof PerihelionContractError &&
          err.errorName === expectedName &&
          err.selector === `#${code}`,
      );
    }
  });
});

describe("PerihelionSettlementClient footprint restoration & fee escalation", () => {
  it("restores archived footprint entries via RestoreFootprint and escalates fees on TRY_AGAIN_LATER", async () => {
    const signer = Keypair.random();
    const callerAddress = signer.publicKey();
    let currentSeq = 200n;
    let cancelSimCount = 0;

    const sentTxs: Array<{
      sequence: string;
      fee: string;
      opType: string;
    }> = [];

    const sendQueue = [
      // 1. RestoreFootprint tx lands on first send
      { status: "PENDING", hash: "tx-restore" },
      // 2. First cancel_expired_intent attempt is refused with TRY_AGAIN_LATER
      { status: "TRY_AGAIN_LATER", hash: "tx-cancel-1" },
      // 3. Second cancel_expired_intent attempt (escalated fee) succeeds
      { status: "PENDING", hash: "tx-cancel-2" },
    ];

    const rpc: SorobanRpcClient = {
      async getAccount(address: string) {
        return new Account(address, currentSeq.toString());
      },
      async getFeeStats() {
        return {
          sorobanInclusionFee: {
            p50: "10000",
            p70: "10000",
            p90: "10000",
            p95: "10000",
            p99: "10000",
          },
        } as unknown as SorobanRpc.Api.GetFeeStatsResponse;
      },
      async simulateTransaction(tx: Transaction) {
        cancelSimCount += 1;
        if (cancelSimCount === 1) {
          // First simulation reports that persistent entries need restoration
          return {
            id: "sim-restore",
            latestLedger: 1234,
            events: [],
            result: {
              auth: [],
              retval: xdr.ScVal.scvVoid(),
            },
            restorePreamble: {
              minResourceFee: "888",
              transactionData: new SorobanDataBuilder(),
            },
          } as unknown as SorobanRpc.Api.SimulateTransactionResponse;
        }
        return simSuccess(xdr.ScVal.scvVoid(), "500");
      },
      async sendTransaction(tx: Transaction) {
        const opType = (tx.operations[0] as { type: string }).type;
        sentTxs.push({
          sequence: tx.sequence,
          fee: tx.fee,
          opType,
        });
        if (opType === "restoreFootprint") {
          currentSeq += 1n;
        }
        return sendQueue.shift() as unknown as SorobanRpc.Api.SendTransactionResponse;
      },
      async getTransaction(hash: string) {
        if (hash === "tx-restore" || hash === "tx-cancel-2") {
          return {
            status: "SUCCESS",
            latestLedger: 1235,
            latestLedgerCloseTime: 1,
            oldestLedger: 1200,
            oldestLedgerCloseTime: 1,
            ledger: 1235,
            createdAt: 1,
            applicationOrder: 1,
            feeBump: false,
            resultXdr: {
              feeCharged: () => ({ toString: () => "15500" }),
            },
          } as unknown as SorobanRpc.Api.GetTransactionResponse;
        }
        return {
          status: "NOT_FOUND",
        } as unknown as SorobanRpc.Api.GetTransactionResponse;
      },
    };

    const client = new PerihelionSettlementClient({
      rpc,
      contractId: CONTRACT_ID,
    });

    const result = await client.submitCancelExpired({
      signer,
      intentHash: INTENT_HASH,
      lzFee: 100_000n,
      policy: {
        floorStroops: 10_000,
        capStroops: 100_000,
        bumpFactor: 1.5,
      },
      submitOptions: {
        pollIntervalMs: 0,
        backoffMs: 0,
        maxAttempts: 1,
      },
    });

    assert.equal(result.hash, "tx-cancel-2");
    assert.equal(result.attempts, 2);
    assert.equal(result.inclusionFeeStroops, 15_000);
    assert.equal(result.feeChargedStroops, 15_500n);

    // 3 transactions sent: 1 restoreFootprint + 2 invokeHostFunction (fee escalated)
    assert.equal(sentTxs.length, 3);
    assert.equal(sentTxs[0]!.opType, "restoreFootprint");
    assert.equal(sentTxs[0]!.sequence, "201");
    assert.equal(sentTxs[0]!.fee, "888");

    assert.equal(sentTxs[1]!.opType, "invokeHostFunction");
    assert.equal(sentTxs[1]!.sequence, "202");
    // Assembled fee = 10_000 inclusion bid + 500 minResourceFee = 10_500
    assert.equal(sentTxs[1]!.fee, "10500");

    assert.equal(sentTxs[2]!.opType, "invokeHostFunction");
    assert.equal(sentTxs[2]!.sequence, "202", "fee-escalated retry reuses sequence number");
    // Assembled fee = 15_000 escalated inclusion bid + 500 minResourceFee = 15_500
    assert.equal(sentTxs[2]!.fee, "15500");
  });
});
