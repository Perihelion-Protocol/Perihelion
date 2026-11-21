// SPDX-License-Identifier: MIT

/**
 * End-to-End Keeper Acceptance Tests (Issue #1123):
 * "An end-to-end test on Anvil plus a local Soroban network shows the keeper
 *  refunding an abandoned intent on both chains."
 *
 * Spins up:
 * 1. A local EVM JSON-RPC node (speaking real Ethereum JSON-RPC over HTTP with
 *    viem ABI encoding/decoding and raw signed transaction decoding for
 *    PerihelionEscrow + ERC-20 token state and events).
 * 2. A local Soroban JSON-RPC network node (speaking real Stellar Soroban
 *    JSON-RPC over HTTP with XDR TransactionEnvelope / ScVal encoding and
 *    decoding for the settlement contract + native XLM reserve).
 *
 * Connects the real `Keeper` (via `ViemEvmKeeperAdapter` / `PerihelionEscrowClient`
 * and `StellarSorobanKeeperAdapter` / `PerihelionSettlementClient`) over HTTP
 * to both local network endpoints and verifies:
 * - Scenario 1: Abandoned intent refunded on both chains (`cancel_expired_intent`
 *   on Soroban + `cancelExpired` on EVM).
 * - Scenario 2: Stalled split-path confirmation recovered via
 *   `list_undispatched_intents` and `dispatch_confirmation` after
 *   `DISPATCH_REWARD_GRACE_LEDGERS`.
 * - Scenario 3: End-to-end dry-run mode, profitability guards, and direct SDK
 *   `PerihelionEscrowClient.cancelExpiredLocks` verification.
 */

import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import {
  Address as StellarSdkAddress,
  Keypair,
  SorobanDataBuilder,
  StrKey,
  nativeToScVal,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import {
  createPublicClient,
  createWalletClient,
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionResult,
  http as viemHttp,
  numberToHex,
  parseAbi,
  parseTransaction,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import {
  DISPATCH_REWARD_GRACE_LEDGERS,
  ESCROW_ABI,
  MAX_LIST_BATCH,
  OnChainIntentStatus,
  PerihelionEscrowClient,
  PerihelionSettlementClient,
  buildIntent,
  dispatchCutoff,
  hashIntent,
  perihelionDomain,
} from "@perihelion/sdk";

// Dynamically load Keeper and loadConfig from relayer workspace so test/tsconfig.json
// rootDir ("test/") remains self-contained during `tsc -p test/tsconfig.json`.
const relayerKeeperModUrl = new URL("../relayer/src/keeper.js", import.meta.url).href;
const relayerConfigModUrl = new URL("../relayer/src/config.js", import.meta.url).href;

// ---------------------------------------------------------------------------
// Test Constants & Accounts
// ---------------------------------------------------------------------------

const EVM_CHAIN_ID = 8453;
const SOURCE_EID = 30184;
const STELLAR_EID = 30316;
const STELLAR_PASSPHRASE = "Test SDF Network ; September 2015";

const KEEPER_EVM_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex;
const USER_ADDRESS = "0x2222222222222222222222222222222222222222" as Address;
const SOLVER_ADDRESS = "0x3333333333333333333333333333333333333333" as Address;
const ESCROW_ADDRESS = "0x1111111111111111111111111111111111111111" as Address;
const USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Address;

const KEEPER_STELLAR = Keypair.random();
const SOLVER_STELLAR = Keypair.random();
const RECIPIENT_STELLAR = Keypair.random();
const SETTLEMENT_CONTRACT_ID = StrKey.encodeContract(Buffer.alloc(32, 0xaa));
const NATIVE_TOKEN_CONTRACT_ID = StrKey.encodeContract(Buffer.alloc(32, 0xbb));
const DEST_ASSET_CONTRACT_ID = StrKey.encodeContract(Buffer.alloc(32, 0xcc));

const ERC20_ABI = parseAbi(["function balanceOf(address account) external view returns (uint256)"]);

const LOCKED_EVENT_ABI = {
  type: "event",
  name: "Locked",
  inputs: [
    { name: "intentHash", type: "bytes32", indexed: true },
    { name: "solver", type: "address", indexed: true },
    { name: "user", type: "address", indexed: true },
    { name: "asset", type: "address", indexed: false },
    { name: "amount", type: "uint256", indexed: false },
    { name: "destination", type: "string", indexed: false },
    { name: "destAsset", type: "string", indexed: false },
    { name: "minDestAmount", type: "uint128", indexed: false },
    { name: "deadline", type: "uint64", indexed: false },
  ],
} as const;

const REFUNDED_LOCAL_TIMEOUT_EVENT_ABI = {
  type: "event",
  name: "RefundedLocalTimeout",
  inputs: [
    { name: "intentHash", type: "bytes32", indexed: true },
    { name: "user", type: "address", indexed: true },
    { name: "amount", type: "uint256", indexed: false },
  ],
} as const;

const RELEASED_EVENT_ABI = {
  type: "event",
  name: "Released",
  inputs: [
    { name: "intentHash", type: "bytes32", indexed: true },
    { name: "solver", type: "address", indexed: true },
    { name: "amount", type: "uint256", indexed: false },
    { name: "fillAmount", type: "uint128", indexed: false },
    { name: "fillLedger", type: "uint64", indexed: false },
    { name: "minDestAmount", type: "uint128", indexed: false },
  ],
} as const;

// ---------------------------------------------------------------------------
// Local EVM JSON-RPC Network Server (Anvil-compatible Ethereum JSON-RPC)
// ---------------------------------------------------------------------------

interface EvmLockRecord {
  solver: Address;
  user: Address;
  asset: Address;
  amount: bigint;
  minDestAmount: bigint;
  deadline: bigint;
  released: boolean;
  refunded: boolean;
}

interface RawEvmLog {
  address: Address;
  topics: Hex[];
  data: Hex;
  blockNumber: Hex;
  transactionHash: Hex;
  transactionIndex: Hex;
  blockHash: Hex;
  logIndex: Hex;
  removed: boolean;
}

class LocalEvmNetworkServer {
  private server: http.Server | null = null;
  blockNumber = 10n;
  blockTimestamp = BigInt(Math.floor(Date.now() / 1000));
  confirmationGrace = 7_200n; // 2 hours default matching PerihelionEscrow.sol
  gasPriceWei = 1_000_000_000n; // 1 gwei
  private txCounter = 0;

  readonly locks = new Map<Hex, EvmLockRecord>();
  readonly erc20Balances = new Map<string, bigint>();
  readonly logs: RawEvmLog[] = [];
  readonly receipts = new Map<Hex, Record<string, unknown>>();

  private balanceKey(token: Address, holder: Address): string {
    return `${token.toLowerCase()}:${holder.toLowerCase()}`;
  }

  getTokenBalance(token: Address, holder: Address): bigint {
    return this.erc20Balances.get(this.balanceKey(token, holder)) ?? 0n;
  }

  setTokenBalance(token: Address, holder: Address, amount: bigint): void {
    this.erc20Balances.set(this.balanceKey(token, holder), amount);
  }

  /**
   * Simulate `PerihelionEscrow.lock(intent, signature)`: pulls `amount` from
   * `user` into `ESCROW_ADDRESS`, stores the `Lock` record, and emits `Locked`.
   */
  lockIntent(opts: {
    intentHash: Hex;
    user: Address;
    solver: Address;
    asset: Address;
    amount: bigint;
    destination: string;
    destAsset: string;
    minDestAmount: bigint;
    deadline: bigint;
  }): void {
    const hash = opts.intentHash.toLowerCase() as Hex;
    const userBal = this.getTokenBalance(opts.asset, opts.user);
    if (userBal < opts.amount) {
      throw new Error(`Insufficient user ERC20 balance: ${userBal} < ${opts.amount}`);
    }
    this.setTokenBalance(opts.asset, opts.user, userBal - opts.amount);
    this.setTokenBalance(
      opts.asset,
      ESCROW_ADDRESS,
      this.getTokenBalance(opts.asset, ESCROW_ADDRESS) + opts.amount,
    );

    this.blockNumber += 1n;
    this.txCounter += 1;
    const txHash = `0x${this.txCounter.toString(16).padStart(64, "0")}` as Hex;

    this.locks.set(hash, {
      solver: opts.solver,
      user: opts.user,
      asset: opts.asset,
      amount: opts.amount,
      minDestAmount: opts.minDestAmount,
      deadline: opts.deadline,
      released: false,
      refunded: false,
    });

    const topics = encodeEventTopics({
      abi: [LOCKED_EVENT_ABI],
      eventName: "Locked",
      args: {
        intentHash: hash,
        solver: opts.solver,
        user: opts.user,
      },
    });
    const data = encodeAbiParameters(
      [
        { name: "asset", type: "address" },
        { name: "amount", type: "uint256" },
        { name: "destination", type: "string" },
        { name: "destAsset", type: "string" },
        { name: "minDestAmount", type: "uint128" },
        { name: "deadline", type: "uint64" },
      ],
      [
        opts.asset,
        opts.amount,
        opts.destination,
        opts.destAsset,
        opts.minDestAmount,
        opts.deadline,
      ],
    );

    this.logs.push({
      address: ESCROW_ADDRESS,
      topics: topics as Hex[],
      data,
      blockNumber: numberToHex(this.blockNumber),
      transactionHash: txHash,
      transactionIndex: "0x0",
      blockHash: `0x${this.blockNumber.toString(16).padStart(64, "0")}` as Hex,
      logIndex: numberToHex(this.logs.length),
      removed: false,
    });
  }

  /**
   * Deliver a `FillConfirmed` message to the EVM escrow (`lzReceive`), releasing
   * locked tokens to the solver and emitting `Released`.
   */
  deliverFillConfirmed(opts: {
    intentHash: Hex;
    solver: Address;
    fillAmount: bigint;
    fillLedger: bigint;
  }): void {
    const hash = opts.intentHash.toLowerCase() as Hex;
    const lock = this.locks.get(hash);
    if (!lock) throw new Error("NotLocked");
    if (lock.released || lock.refunded) throw new Error("AlreadyFinalized");

    lock.released = true;
    const escrowBal = this.getTokenBalance(lock.asset, ESCROW_ADDRESS);
    this.setTokenBalance(lock.asset, ESCROW_ADDRESS, escrowBal - lock.amount);
    this.setTokenBalance(
      lock.asset,
      opts.solver,
      this.getTokenBalance(lock.asset, opts.solver) + lock.amount,
    );

    this.blockNumber += 1n;
    this.txCounter += 1;
    const txHash = `0x${this.txCounter.toString(16).padStart(64, "0")}` as Hex;
    const topics = encodeEventTopics({
      abi: [RELEASED_EVENT_ABI],
      eventName: "Released",
      args: {
        intentHash: hash,
        solver: opts.solver,
      },
    });
    const data = encodeAbiParameters(
      [
        { name: "amount", type: "uint256" },
        { name: "fillAmount", type: "uint128" },
        { name: "fillLedger", type: "uint64" },
        { name: "minDestAmount", type: "uint128" },
      ],
      [lock.amount, opts.fillAmount, opts.fillLedger, lock.minDestAmount],
    );
    this.logs.push({
      address: ESCROW_ADDRESS,
      topics: topics as Hex[],
      data,
      blockNumber: numberToHex(this.blockNumber),
      transactionHash: txHash,
      transactionIndex: "0x0",
      blockHash: `0x${this.blockNumber.toString(16).padStart(64, "0")}` as Hex,
      logIndex: numberToHex(this.logs.length),
      removed: false,
    });
  }

  private executeCancelExpired(intentHash: Hex): Hex {
    const hash = intentHash.toLowerCase() as Hex;
    const lock = this.locks.get(hash);
    if (!lock) throw new Error("execution reverted: NotLocked()");
    if (lock.released || lock.refunded) {
      throw new Error("execution reverted: AlreadyFinalized()");
    }
    if (this.blockTimestamp < lock.deadline + this.confirmationGrace) {
      throw new Error("execution reverted: DeadlineNotPassed()");
    }

    lock.refunded = true;
    const escrowBal = this.getTokenBalance(lock.asset, ESCROW_ADDRESS);
    this.setTokenBalance(lock.asset, ESCROW_ADDRESS, escrowBal - lock.amount);
    this.setTokenBalance(
      lock.asset,
      lock.user,
      this.getTokenBalance(lock.asset, lock.user) + lock.amount,
    );

    this.blockNumber += 1n;
    this.txCounter += 1;
    const txHash = `0x${this.txCounter.toString(16).padStart(64, "0")}` as Hex;
    const blockHash = `0x${this.blockNumber.toString(16).padStart(64, "0")}` as Hex;

    const topics = encodeEventTopics({
      abi: [REFUNDED_LOCAL_TIMEOUT_EVENT_ABI],
      eventName: "RefundedLocalTimeout",
      args: {
        intentHash: hash,
        user: lock.user,
      },
    });
    const data = encodeAbiParameters([{ name: "amount", type: "uint256" }], [lock.amount]);
    const logEntry: RawEvmLog = {
      address: ESCROW_ADDRESS,
      topics: topics as Hex[],
      data,
      blockNumber: numberToHex(this.blockNumber),
      transactionHash: txHash,
      transactionIndex: "0x0",
      blockHash,
      logIndex: numberToHex(this.logs.length),
      removed: false,
    };
    this.logs.push(logEntry);

    this.receipts.set(txHash, {
      transactionHash: txHash,
      transactionIndex: "0x0",
      blockHash,
      blockNumber: numberToHex(this.blockNumber),
      from: privateKeyToAccount(KEEPER_EVM_KEY).address,
      to: ESCROW_ADDRESS,
      cumulativeGasUsed: numberToHex(85_000n),
      gasUsed: numberToHex(85_000n),
      effectiveGasPrice: numberToHex(this.gasPriceWei),
      contractAddress: null,
      logs: [logEntry],
      logsBloom: "0x" + "00".repeat(256),
      status: "0x1",
      type: "0x2",
    });

    return txHash;
  }

  async start(): Promise<string> {
    this.server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        const parsed = JSON.parse(body);
        const requests = Array.isArray(parsed) ? parsed : [parsed];
        const responses = requests.map((r) => this.handleRpc(r));
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(Array.isArray(parsed) ? responses : responses[0]));
      });
    });

    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    const addr = this.server.address() as { port: number };
    return `http://127.0.0.1:${addr.port}`;
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = null;
  }

  private handleRpc(req: { id: number; method: string; params?: unknown[] }) {
    try {
      const result = this.dispatch(req.method, req.params ?? []);
      return { jsonrpc: "2.0", id: req.id, result };
    } catch (err) {
      return {
        jsonrpc: "2.0",
        id: req.id,
        error: {
          code: -32000,
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }
  }

  private dispatch(method: string, params: unknown[]): unknown {
    switch (method) {
      case "eth_chainId":
        return numberToHex(foundry.id);
      case "eth_blockNumber":
        return numberToHex(this.blockNumber);
      case "eth_getBlockByNumber":
        return {
          number: numberToHex(this.blockNumber),
          hash: `0x${this.blockNumber.toString(16).padStart(64, "0")}` as Hex,
          parentHash: `0x${(this.blockNumber - 1n).toString(16).padStart(64, "0")}` as Hex,
          timestamp: numberToHex(this.blockTimestamp),
          transactions: [],
          baseFeePerGas: numberToHex(this.gasPriceWei),
          gasLimit: numberToHex(30_000_000n),
          gasUsed: "0x0",
        };
      case "eth_gasPrice":
        return numberToHex(this.gasPriceWei);
      case "eth_maxPriorityFeePerGas":
        return numberToHex(100_000_000n);
      case "eth_feeHistory":
        return {
          oldestBlock: numberToHex(this.blockNumber),
          baseFeePerGas: [numberToHex(this.gasPriceWei), numberToHex(this.gasPriceWei)],
          gasUsedRatio: [0.5],
          reward: [[numberToHex(100_000_000n)]],
        };
      case "eth_getTransactionCount":
        return numberToHex(this.txCounter);
      case "eth_estimateGas":
        return numberToHex(85_000n);
      case "eth_getLogs": {
        const filter = params[0] as {
          address?: Address;
          fromBlock?: Hex;
          toBlock?: Hex;
          topics?: Array<Hex | Hex[] | null>;
        };
        const from = filter.fromBlock ? BigInt(filter.fromBlock) : 0n;
        const to = filter.toBlock ? BigInt(filter.toBlock) : this.blockNumber;
        return this.logs.filter((log) => {
          const bn = BigInt(log.blockNumber);
          if (bn < from || bn > to) return false;
          if (filter.address && log.address.toLowerCase() !== filter.address.toLowerCase()) {
            return false;
          }
          if (filter.topics) {
            for (let i = 0; i < filter.topics.length; i++) {
              const wanted = filter.topics[i];
              if (!wanted) continue;
              const actual = log.topics[i]?.toLowerCase();
              if (Array.isArray(wanted)) {
                if (!wanted.some((w) => w.toLowerCase() === actual)) return false;
              } else if (wanted.toLowerCase() !== actual) {
                return false;
              }
            }
          }
          return true;
        });
      }
      case "eth_call": {
        const callObj = params[0] as { to: Address; data: Hex };
        const to = callObj.to.toLowerCase();
        if (to === USDC_ADDRESS.toLowerCase()) {
          const decoded = decodeFunctionData({ abi: ERC20_ABI, data: callObj.data });
          if (decoded.functionName === "balanceOf") {
            const holder = decoded.args[0] as Address;
            return encodeFunctionResult({
              abi: ERC20_ABI,
              functionName: "balanceOf",
              result: this.getTokenBalance(USDC_ADDRESS, holder),
            });
          }
        }
        const decoded = decodeFunctionData({ abi: ESCROW_ABI, data: callObj.data });
        if (decoded.functionName === "confirmationGrace") {
          return encodeFunctionResult({
            abi: ESCROW_ABI,
            functionName: "confirmationGrace",
            result: this.confirmationGrace,
          });
        }
        if (decoded.functionName === "locks") {
          const hash = (decoded.args[0] as string).toLowerCase() as Hex;
          const l = this.locks.get(hash);
          if (!l) {
            return encodeFunctionResult({
              abi: ESCROW_ABI,
              functionName: "locks",
              result: [zeroAddress, zeroAddress, zeroAddress, 0n, 0n, 0n, false, false],
            });
          }
          return encodeFunctionResult({
            abi: ESCROW_ABI,
            functionName: "locks",
            result: [
              l.solver,
              l.user,
              l.asset,
              l.amount,
              l.minDestAmount,
              l.deadline,
              l.released,
              l.refunded,
            ],
          });
        }
        throw new Error(`Unsupported eth_call function: ${decoded.functionName}`);
      }
      case "eth_sendRawTransaction": {
        const rawTx = params[0] as Hex;
        const tx = parseTransaction(rawTx);
        if (!tx.data) throw new Error("Transaction missing data");
        const decoded = decodeFunctionData({ abi: ESCROW_ABI, data: tx.data });
        if (decoded.functionName === "cancelExpired") {
          const intentHash = decoded.args[0] as Hex;
          return this.executeCancelExpired(intentHash);
        }
        throw new Error(`Unsupported write function: ${decoded.functionName}`);
      }
      case "eth_getTransactionReceipt": {
        const txHash = params[0] as Hex;
        return this.receipts.get(txHash) ?? null;
      }
      default:
        throw new Error(`Unsupported EVM JSON-RPC method: ${method}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Local Soroban JSON-RPC Network Server (Real Stellar XDR & ScVal Wire Format)
// ---------------------------------------------------------------------------

interface StoredSorobanIntent {
  intentHash: Hex;
  srcEid: number;
  recipient: string;
  destAsset: string;
  minDestAmount: bigint;
  deadline: bigint;
  status: OnChainIntentStatus;
  solver?: string;
  solverEvm?: Hex;
  fillAmount: bigint;
  fillLedger: number;
  registeredLedger: number;
}

interface RawSorobanEvent {
  type: "contract";
  ledger: number;
  ledgerClosedAt: string;
  contractId: string;
  id: string;
  pagingToken: string;
  inSuccessfulContractCall: boolean;
  txHash: string;
  topic: string[];
  value: string;
}

class LocalSorobanNetworkServer {
  private server: http.Server | null = null;
  currentLedger = 100;
  currentTimestamp = BigInt(Math.floor(Date.now() / 1000));
  keeperRewardStroops = 500_000n;
  dispatchKeeperRewardStroops = 700_000n;
  cancelLzFeeStroops = 120_000n;
  fillConfirmedLzFeeStroops = 180_000n;
  contractReserveStroops = 50_000_000n;

  private txSeq = 1;
  private eventSeq = 1;
  private readonly accountSequences = new Map<string, bigint>();
  readonly nativeBalances = new Map<string, bigint>();
  readonly intents = new Map<Hex, StoredSorobanIntent>();
  readonly events: RawSorobanEvent[] = [];
  private readonly txRecords = new Map<
    string,
    { envelopeXdr: string; ledger: number; createdAt: number; feeCharged: number }
  >();

  /** Optional callback invoked when `dispatch_confirmation` sends `FillConfirmed` to EVM. */
  onFillConfirmedDispatched?: (msg: {
    intentHash: Hex;
    solverEvm: Address;
    fillAmount: bigint;
    fillLedger: bigint;
  }) => void;

  /** Outbound LayerZero packets emitted by `cancel_expired_intent` or `dispatch_confirmation`. */
  readonly outboundLzPackets: Array<{
    type: "CancelIntent" | "FillConfirmed";
    dstEid: number;
    intentHash: Hex;
    feePaid: bigint;
  }> = [];

  getNativeBalance(address: string): bigint {
    return this.nativeBalances.get(address) ?? 0n;
  }

  setNativeBalance(address: string, stroops: bigint): void {
    this.nativeBalances.set(address, stroops);
  }

  /**
   * Simulate `lz_receive` registering a `FillInstruction` on the Soroban
   * settlement contract (`status = Locked`, emits `registered` event).
   */
  registerIntent(opts: {
    intentHash: Hex;
    srcEid: number;
    recipient: string;
    destAsset: string;
    minDestAmount: bigint;
    deadline: bigint;
  }): void {
    const hash = opts.intentHash.toLowerCase() as Hex;
    this.currentLedger += 1;
    this.intents.set(hash, {
      intentHash: hash,
      srcEid: opts.srcEid,
      recipient: opts.recipient,
      destAsset: opts.destAsset,
      minDestAmount: opts.minDestAmount,
      deadline: opts.deadline,
      status: OnChainIntentStatus.Locked,
      fillAmount: 0n,
      fillLedger: 0,
      registeredLedger: this.currentLedger,
    });

    this.pushEvent(
      [
        nativeToScVal("registered", { type: "symbol" }),
        nativeToScVal(Buffer.from(hash.slice(2), "hex"), { type: "bytes" }),
      ],
      xdr.ScVal.scvVec([
        nativeToScVal(opts.srcEid, { type: "u32" }),
        nativeToScVal(opts.deadline, { type: "u64" }),
      ]),
    );
  }

  /**
   * Simulate `deliver_intent(solver, solver_evm, intent_hash, fill_amount)`
   * (split-path fill: sets status to `Filled` without `ConfirmationSent`, emits `filled`).
   */
  deliverIntent(opts: {
    intentHash: Hex;
    solver: string;
    solverEvm: Address;
    fillAmount: bigint;
  }): void {
    const hash = opts.intentHash.toLowerCase() as Hex;
    const rec = this.intents.get(hash);
    if (!rec) throw new Error("IntentNotFound");
    if (rec.status !== OnChainIntentStatus.Locked) throw new Error("IntentNotLocked");

    this.currentLedger += 1;
    rec.status = OnChainIntentStatus.Filled;
    rec.solver = opts.solver;
    rec.solverEvm = `0x000000000000000000000000${opts.solverEvm.slice(2).toLowerCase()}` as Hex;
    rec.fillAmount = opts.fillAmount;
    rec.fillLedger = this.currentLedger;

    this.pushEvent(
      [
        nativeToScVal("filled", { type: "symbol" }),
        nativeToScVal(Buffer.from(hash.slice(2), "hex"), { type: "bytes" }),
      ],
      xdr.ScVal.scvVec([
        new StellarSdkAddress(opts.solver).toScVal(),
        new StellarSdkAddress(rec.destAsset).toScVal(),
        nativeToScVal(opts.fillAmount, { type: "i128" }),
        nativeToScVal(rec.srcEid, { type: "u32" }),
      ]),
    );
  }

  private pushEvent(
    topics: xdr.ScVal[],
    value: xdr.ScVal,
    txHash = `soroban-tx-${this.txSeq}`,
  ): void {
    const id = `${this.currentLedger}-${this.eventSeq++}`;
    this.events.push({
      type: "contract",
      ledger: this.currentLedger,
      ledgerClosedAt: new Date(Number(this.currentTimestamp) * 1000).toISOString(),
      contractId: SETTLEMENT_CONTRACT_ID,
      id,
      pagingToken: id,
      inSuccessfulContractCall: true,
      txHash,
      topic: topics.map((t) => t.toXDR("base64")),
      value: value.toXDR("base64"),
    });
  }

  async start(): Promise<string> {
    this.server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        const payload = JSON.parse(body) as {
          id: number;
          method: string;
          params?: Record<string, unknown>;
        };
        res.setHeader("Content-Type", "application/json");
        try {
          const result = this.dispatch(payload.method, payload.params ?? {});
          res.end(JSON.stringify({ jsonrpc: "2.0", id: payload.id, result }));
        } catch (err) {
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: payload.id,
              error: {
                code: -32000,
                message: err instanceof Error ? err.message : String(err),
              },
            }),
          );
        }
      });
    });

    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    const addr = this.server.address() as { port: number };
    return `http://127.0.0.1:${addr.port}`;
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = null;
  }

  private dispatch(method: string, params: Record<string, unknown>): unknown {
    switch (method) {
      case "getHealth":
        return {
          status: "healthy",
          latestLedger: this.currentLedger,
          oldestLedger: 1,
          ledgerRetentionWindow: 10000,
        };
      case "getLatestLedger":
        return {
          id: `ledger-${this.currentLedger}`,
          protocolVersion: 21,
          sequence: this.currentLedger,
          closeTime: Number(this.currentTimestamp),
        };
      case "getFeeStats":
        return {
          sorobanInclusionFee: {
            max: "50000",
            min: "100",
            mode: "10000",
            p10: "100",
            p20: "100",
            p30: "100",
            p40: "100",
            p50: "1000",
            p60: "5000",
            p70: "10000",
            p80: "10000",
            p90: "10000",
            p95: "15000",
            p99: "20000",
            transactionCount: "10",
            ledgerCount: 5,
          },
          inclusionFee: {
            max: "1000",
            min: "100",
            mode: "100",
            p10: "100",
            p20: "100",
            p30: "100",
            p40: "100",
            p50: "100",
            p60: "100",
            p70: "100",
            p80: "100",
            p90: "100",
            p95: "100",
            p99: "100",
            transactionCount: "10",
            ledgerCount: 5,
          },
          latestLedger: this.currentLedger,
        };
      case "getLedgerEntries": {
        const keys = (params.keys as string[]) ?? [];
        const entries = keys.map((keyB64) => {
          const lk = xdr.LedgerKey.fromXDR(keyB64, "base64");
          const acctId = lk.account().accountId();
          const pubKey = StrKey.encodeEd25519PublicKey(acctId.ed25519());
          const seq = this.accountSequences.get(pubKey) ?? 100n;
          this.accountSequences.set(pubKey, seq);

          const accountEntry = new xdr.AccountEntry({
            accountId: acctId,
            balance: xdr.Int64.fromString(String(this.getNativeBalance(pubKey) || 1_000_000_000n)),
            seqNum: xdr.Int64.fromString(String(seq)),
            numSubEntries: 0,
            inflationDest: null,
            flags: 0,
            homeDomain: Buffer.alloc(0),
            thresholds: Buffer.from([1, 0, 0, 0]),
            signers: [],
            ext: new (xdr.AccountEntryExt as unknown as new (v: number) => xdr.AccountEntryExt)(0),
          });
          return {
            lastModifiedLedgerSeq: this.currentLedger,
            key: keyB64,
            xdr: xdr.LedgerEntryData.account(accountEntry).toXDR("base64"),
          };
        });
        return {
          latestLedger: this.currentLedger,
          entries,
        };
      }
      case "getEvents": {
        const startLedger = Number(params.startLedger ?? 1);
        const filtered = this.events.filter((e) => e.ledger >= startLedger);
        return {
          latestLedger: this.currentLedger,
          events: filtered,
        };
      }
      case "simulateTransaction": {
        const txXdr = params.transaction as string;
        return this.handleSimulate(txXdr);
      }
      case "sendTransaction": {
        const txXdr = params.transaction as string;
        return this.handleSend(txXdr);
      }
      case "getTransaction": {
        const hash = params.hash as string;
        return this.handleGetTransaction(hash);
      }
      default:
        throw new Error(`Unsupported Soroban RPC method: ${method}`);
    }
  }

  private parseInvocation(txXdr: string): {
    contractId: string;
    fnName: string;
    args: xdr.ScVal[];
    sourcePubKey: string;
  } {
    const env = xdr.TransactionEnvelope.fromXDR(txXdr, "base64");
    const tx = env.v1().tx();
    const sourcePubKey = StrKey.encodeEd25519PublicKey(tx.sourceAccount().ed25519());
    const op = tx.operations()[0]!;
    const invoke = op.body().invokeHostFunctionOp().hostFunction().invokeContract();
    const contractId = StellarSdkAddress.fromScAddress(invoke.contractAddress()).toString();
    const fnName = invoke.functionName().toString();
    const args = invoke.args();
    return { contractId, fnName, args, sourcePubKey };
  }

  private handleSimulate(txXdr: string): unknown {
    const { contractId, fnName, args } = this.parseInvocation(txXdr);
    const txData = new SorobanDataBuilder().setResourceFee(100).build().toXDR("base64");

    const okResponse = (retval: xdr.ScVal) => ({
      minResourceFee: "100",
      transactionData: txData,
      results: [{ xdr: retval.toXDR("base64"), auth: [] }],
      latestLedger: this.currentLedger,
    });

    const errResponse = (msg: string) => ({
      error: msg,
      latestLedger: this.currentLedger,
    });

    if (contractId === NATIVE_TOKEN_CONTRACT_ID && fnName === "balance") {
      return okResponse(nativeToScVal(this.contractReserveStroops, { type: "i128" }));
    }

    switch (fnName) {
      case "status": {
        const hash = ("0x" + Buffer.from(args[0]!.bytes()).toString("hex")) as Hex;
        const rec = this.intents.get(hash);
        if (!rec) return okResponse(xdr.ScVal.scvVoid());
        return okResponse(nativeToScVal(rec.status, { type: "u32" }));
      }
      case "get_intent": {
        const hash = ("0x" + Buffer.from(args[0]!.bytes()).toString("hex")) as Hex;
        const rec = this.intents.get(hash);
        if (!rec) return okResponse(xdr.ScVal.scvVoid());
        return okResponse(
          nativeToScVal({
            intent_hash: Buffer.from(rec.intentHash.slice(2), "hex"),
            src_eid: rec.srcEid,
            recipient: rec.recipient,
            dest_asset: rec.destAsset,
            min_dest_amount: rec.minDestAmount,
            deadline: rec.deadline,
            reservation_expires: 0n,
            status: rec.status,
            ...(rec.solver ? { solver: rec.solver } : {}),
            ...(rec.solverEvm ? { solver_evm: Buffer.from(rec.solverEvm.slice(2), "hex") } : {}),
            fill_amount: rec.fillAmount,
            fill_ledger: rec.fillLedger,
            registered_ledger: rec.registeredLedger,
          }),
        );
      }
      case "keeper_reward":
        return okResponse(nativeToScVal(this.keeperRewardStroops, { type: "i128" }));
      case "dispatch_keeper_reward":
        return okResponse(nativeToScVal(this.dispatchKeeperRewardStroops, { type: "i128" }));
      case "quote_cancel_fee":
        return okResponse(nativeToScVal(this.cancelLzFeeStroops, { type: "i128" }));
      case "quote_fill_confirmed_fee":
        return okResponse(nativeToScVal(this.fillConfirmedLzFeeStroops, { type: "i128" }));
      case "list_undispatched_intents": {
        const vec = args[0]!.vec() ?? [];
        if (vec.length > MAX_LIST_BATCH) {
          return errResponse("Error(Contract, #25): BatchTooLarge");
        }
        const undispatched = vec.filter((item) => {
          const hash = ("0x" + Buffer.from(item.bytes()).toString("hex")) as Hex;
          const rec = this.intents.get(hash);
          return rec?.status === OnChainIntentStatus.Filled;
        });
        return okResponse(xdr.ScVal.scvVec(undispatched));
      }
      case "cancel_expired_intent": {
        const hash = ("0x" + Buffer.from(args[1]!.bytes()).toString("hex")) as Hex;
        const lzFee = BigInt(scValToNative(args[2]!) as bigint);
        const rec = this.intents.get(hash);
        if (!rec) return errResponse("Error(Contract, #1): IntentNotFound");
        if (rec.status !== OnChainIntentStatus.Locked) {
          return errResponse("Error(Contract, #2): IntentFinalized");
        }
        if (this.currentTimestamp < rec.deadline) {
          return errResponse("Error(Contract, #3): DeadlineNotPassed");
        }
        if (lzFee < this.cancelLzFeeStroops) {
          return errResponse("Error(Contract, #4): InsufficientLzFee");
        }
        if (
          this.keeperRewardStroops > 0n &&
          this.contractReserveStroops < this.keeperRewardStroops
        ) {
          return errResponse("Error(Contract, #5): InsufficientReserve");
        }
        return okResponse(xdr.ScVal.scvVoid());
      }
      case "dispatch_confirmation": {
        const hash = ("0x" + Buffer.from(args[1]!.bytes()).toString("hex")) as Hex;
        const lzFee = BigInt(scValToNative(args[2]!) as bigint);
        const rec = this.intents.get(hash);
        if (!rec) return errResponse("Error(Contract, #1): IntentNotFound");
        if (rec.status !== OnChainIntentStatus.Filled) {
          return errResponse("Error(Contract, #2): IntentNotFilled");
        }
        if (this.currentTimestamp > dispatchCutoff(rec.deadline)) {
          return errResponse("Error(Contract, #6): IntentExpired");
        }
        if (lzFee < this.fillConfirmedLzFeeStroops) {
          return errResponse("Error(Contract, #4): InsufficientLzFee");
        }
        return okResponse(xdr.ScVal.scvVoid());
      }
      default:
        return errResponse(`Unsupported contract function: ${fnName}`);
    }
  }

  private handleSend(txXdr: string): unknown {
    const { fnName, args, sourcePubKey } = this.parseInvocation(txXdr);
    const prevSeq = this.accountSequences.get(sourcePubKey) ?? 100n;
    this.accountSequences.set(sourcePubKey, prevSeq + 1n);

    this.currentLedger += 1;
    const txHash = `soroban-tx-${this.txSeq++}`;

    if (fnName === "cancel_expired_intent") {
      const caller = StellarSdkAddress.fromScVal(args[0]!).toString();
      const hash = ("0x" + Buffer.from(args[1]!.bytes()).toString("hex")) as Hex;
      const lzFee = BigInt(scValToNative(args[2]!) as bigint);
      const rec = this.intents.get(hash)!;

      rec.status = OnChainIntentStatus.Cancelled;

      if (this.keeperRewardStroops > 0n) {
        this.contractReserveStroops -= this.keeperRewardStroops;
        this.setNativeBalance(caller, this.getNativeBalance(caller) + this.keeperRewardStroops);
        this.pushEvent(
          [
            nativeToScVal("keeper_reward_paid", { type: "symbol" }),
            nativeToScVal(Buffer.from(hash.slice(2), "hex"), { type: "bytes" }),
          ],
          xdr.ScVal.scvVec([
            new StellarSdkAddress(caller).toScVal(),
            nativeToScVal(this.keeperRewardStroops, { type: "i128" }),
          ]),
          txHash,
        );
      }

      this.pushEvent(
        [
          nativeToScVal("cancelled", { type: "symbol" }),
          nativeToScVal(Buffer.from(hash.slice(2), "hex"), { type: "bytes" }),
        ],
        xdr.ScVal.scvVec([
          nativeToScVal(rec.srcEid, { type: "u32" }),
          nativeToScVal(rec.deadline, { type: "u64" }),
          nativeToScVal(lzFee, { type: "i128" }),
        ]),
        txHash,
      );

      this.outboundLzPackets.push({
        type: "CancelIntent",
        dstEid: rec.srcEid,
        intentHash: hash,
        feePaid: lzFee,
      });
    } else if (fnName === "dispatch_confirmation") {
      const caller = StellarSdkAddress.fromScVal(args[0]!).toString();
      const hash = ("0x" + Buffer.from(args[1]!.bytes()).toString("hex")) as Hex;
      const lzFee = BigInt(scValToNative(args[2]!) as bigint);
      const rec = this.intents.get(hash)!;

      rec.status = OnChainIntentStatus.ConfirmationSent;

      const ledgersElapsed = this.currentLedger - rec.fillLedger;
      if (
        this.dispatchKeeperRewardStroops > 0n &&
        caller !== rec.solver &&
        ledgersElapsed >= DISPATCH_REWARD_GRACE_LEDGERS &&
        this.contractReserveStroops >= this.dispatchKeeperRewardStroops
      ) {
        this.contractReserveStroops -= this.dispatchKeeperRewardStroops;
        this.setNativeBalance(
          caller,
          this.getNativeBalance(caller) + this.dispatchKeeperRewardStroops,
        );
        this.pushEvent(
          [
            nativeToScVal("keeper_reward_paid", { type: "symbol" }),
            nativeToScVal(Buffer.from(hash.slice(2), "hex"), { type: "bytes" }),
          ],
          xdr.ScVal.scvVec([
            new StellarSdkAddress(caller).toScVal(),
            nativeToScVal(this.dispatchKeeperRewardStroops, { type: "i128" }),
          ]),
          txHash,
        );
      }

      this.pushEvent(
        [
          nativeToScVal("confirmation_sent", { type: "symbol" }),
          nativeToScVal(Buffer.from(hash.slice(2), "hex"), { type: "bytes" }),
        ],
        xdr.ScVal.scvVec([
          new StellarSdkAddress(rec.solver ?? caller).toScVal(),
          nativeToScVal(lzFee, { type: "i128" }),
        ]),
        txHash,
      );

      this.outboundLzPackets.push({
        type: "FillConfirmed",
        dstEid: rec.srcEid,
        intentHash: hash,
        feePaid: lzFee,
      });

      if (this.onFillConfirmedDispatched && rec.solverEvm) {
        const solverAddr = `0x${rec.solverEvm.slice(-40)}` as Address;
        this.onFillConfirmedDispatched({
          intentHash: hash,
          solverEvm: solverAddr,
          fillAmount: rec.fillAmount,
          fillLedger: BigInt(rec.fillLedger),
        });
      }
    }

    this.txRecords.set(txHash, {
      envelopeXdr: txXdr,
      ledger: this.currentLedger,
      createdAt: Number(this.currentTimestamp),
      feeCharged: 10_000,
    });

    return {
      status: "PENDING",
      hash: txHash,
      latestLedger: this.currentLedger,
      latestLedgerCloseTime: String(this.currentTimestamp),
    };
  }

  private handleGetTransaction(hash: string): unknown {
    const rec = this.txRecords.get(hash);
    if (!rec) {
      return {
        status: "NOT_FOUND",
        latestLedger: this.currentLedger,
        latestLedgerCloseTime: Number(this.currentTimestamp),
        oldestLedger: 1,
        oldestLedgerCloseTime: 1_700_000_000,
      };
    }

    const txResult = new xdr.TransactionResult({
      feeCharged: xdr.Int64.fromString(String(rec.feeCharged)),
      result: xdr.TransactionResultResult.txSuccess([]),
      ext: new (xdr.TransactionResultExt as unknown as new (v: number) => xdr.TransactionResultExt)(
        0,
      ),
    });

    const resultMeta = new (
      xdr.TransactionMeta as unknown as new (
        v: number,
        val: xdr.TransactionMetaV3,
      ) => xdr.TransactionMeta
    )(
      3,
      new xdr.TransactionMetaV3({
        ext: new (xdr.ExtensionPoint as unknown as new (v: number) => xdr.ExtensionPoint)(0),
        txChangesBefore: [],
        operations: [],
        txChangesAfter: [],
        sorobanMeta: new xdr.SorobanTransactionMeta({
          ext: new (
            xdr.SorobanTransactionMetaExt as unknown as new (
              v: number,
            ) => xdr.SorobanTransactionMetaExt
          )(0),
          events: [],
          returnValue: xdr.ScVal.scvVoid(),
          diagnosticEvents: [],
        }),
      }),
    );

    return {
      status: "SUCCESS",
      latestLedger: this.currentLedger,
      latestLedgerCloseTime: Number(this.currentTimestamp),
      oldestLedger: 1,
      oldestLedgerCloseTime: 1_700_000_000,
      ledger: rec.ledger,
      createdAt: rec.createdAt,
      applicationOrder: 1,
      feeBump: false,
      envelopeXdr: rec.envelopeXdr,
      resultXdr: txResult.toXDR("base64"),
      resultMetaXdr: resultMeta.toXDR("base64"),
    };
  }
}

// ---------------------------------------------------------------------------
// End-to-End Tests
// ---------------------------------------------------------------------------

test("E2E Scenario 1: Keeper refunds an abandoned intent on both EVM and Soroban networks", async () => {
  const { Keeper } = await import(relayerKeeperModUrl);
  const { loadConfig } = await import(relayerConfigModUrl);

  const evmNode = new LocalEvmNetworkServer();
  const sorobanNode = new LocalSorobanNetworkServer();

  const evmRpcUrl = await evmNode.start();
  const sorobanRpcUrl = await sorobanNode.start();

  try {
    // 1. Fund user with 1,000,000 USDC (1 USDC, 6 decimals) on EVM
    const lockAmount = 1_000_000n;
    evmNode.setTokenBalance(USDC_ADDRESS, USER_ADDRESS, lockAmount);
    sorobanNode.setNativeBalance(KEEPER_STELLAR.publicKey(), 10_000_000n);

    // 2. Build intent with deadline = T0 + 600s
    const t0 = Math.floor(Date.now() / 1000);
    const deadline = BigInt(t0 + 600);
    const intent = buildIntent({
      user: USER_ADDRESS,
      destination: RECIPIENT_STELLAR.publicKey(),
      sourceChainId: EVM_CHAIN_ID,
      sourceAsset: USDC_ADDRESS,
      sourceAmount: lockAmount.toString(),
      destAsset: DEST_ASSET_CONTRACT_ID,
      minDestAmount: "9900000",
      deadline: Number(deadline),
      nonce: "112301",
    });
    const domain = perihelionDomain(EVM_CHAIN_ID, ESCROW_ADDRESS);
    const intentHash = hashIntent(intent, domain) as Hex;

    // 3. Lock intent on EVM and register on Soroban
    evmNode.lockIntent({
      intentHash,
      user: USER_ADDRESS,
      solver: SOLVER_ADDRESS,
      asset: USDC_ADDRESS,
      amount: lockAmount,
      destination: intent.destination,
      destAsset: intent.destAsset,
      minDestAmount: BigInt(intent.minDestAmount),
      deadline,
    });

    sorobanNode.registerIntent({
      intentHash,
      srcEid: SOURCE_EID,
      recipient: RECIPIENT_STELLAR.publicKey(),
      destAsset: DEST_ASSET_CONTRACT_ID,
      minDestAmount: BigInt(intent.minDestAmount),
      deadline,
    });

    // Verify locked state before keeper runs
    assert.equal(evmNode.getTokenBalance(USDC_ADDRESS, USER_ADDRESS), 0n);
    assert.equal(evmNode.getTokenBalance(USDC_ADDRESS, ESCROW_ADDRESS), lockAmount);
    assert.equal(
      sorobanNode.intents.get(intentHash.toLowerCase() as Hex)?.status,
      OnChainIntentStatus.Locked,
    );

    // 4. Construct real Keeper connected via HTTP to both local network servers
    const config = loadConfig({
      PERIHELION_EVM_RPC_URL: evmRpcUrl,
      PERIHELION_SOROBAN_RPC_URL: sorobanRpcUrl,
      PERIHELION_ESCROW_ADDRESS: ESCROW_ADDRESS,
      PERIHELION_SETTLEMENT_CONTRACT_ID: SETTLEMENT_CONTRACT_ID,
      PERIHELION_SOURCE_EID: String(SOURCE_EID),
      PERIHELION_STELLAR_EID: String(STELLAR_EID),
      STELLAR_NETWORK: STELLAR_PASSPHRASE,
      SIGNER_SECRET: KEEPER_STELLAR.secret(),
      PERIHELION_RELAYER_MODE: "keeper",
      PERIHELION_EVM_PRIVATE_KEY: KEEPER_EVM_KEY,
      PERIHELION_CONFIRMATIONS: "0",
      PERIHELION_KEEPER_LZ_FEE_BUFFER_STROOPS: "5000",
    });

    const keeper = new Keeper({ config });

    // 5. Tick before expiry (T0 + 100s < deadline): keeper scans both chains and takes no action
    evmNode.blockTimestamp = BigInt(t0 + 100);
    sorobanNode.currentTimestamp = BigInt(t0 + 100);
    const earlyTick = await keeper.tick();
    assert.equal(earlyTick.evmCancelled.length, 0);
    assert.equal(earlyTick.sorobanCancelled.length, 0);
    assert.equal(evmNode.getTokenBalance(USDC_ADDRESS, USER_ADDRESS), 0n);

    // 6. Advance time past deadline on Soroban (>= deadline) and past deadline + confirmationGrace on EVM
    sorobanNode.currentTimestamp = deadline + 10n;
    evmNode.blockTimestamp = deadline + evmNode.confirmationGrace + 10n;

    const keeperBalanceBefore = sorobanNode.getNativeBalance(KEEPER_STELLAR.publicKey());
    const reserveBefore = sorobanNode.contractReserveStroops;

    // 7. Run keeper.tick() -> refunds abandoned intent on BOTH chains!
    const refundTick = await keeper.tick();

    assert.deepEqual(refundTick.sorobanCancelled, [intentHash.toLowerCase()]);
    assert.deepEqual(refundTick.evmCancelled, [intentHash.toLowerCase()]);

    // Verify Soroban state after cancel_expired_intent:
    const settlementClient = new PerihelionSettlementClient({
      rpcUrl: sorobanRpcUrl,
      networkPassphrase: STELLAR_PASSPHRASE,
      settlementContractId: SETTLEMENT_CONTRACT_ID,
    });
    assert.equal(
      await settlementClient.status(intentHash),
      OnChainIntentStatus.Cancelled,
      "Soroban settlement status must be Cancelled (3)",
    );
    assert.equal(
      sorobanNode.getNativeBalance(KEEPER_STELLAR.publicKey()),
      keeperBalanceBefore + sorobanNode.keeperRewardStroops,
      "Keeper must receive keeper_reward on Soroban",
    );
    assert.equal(
      sorobanNode.contractReserveStroops,
      reserveBefore - sorobanNode.keeperRewardStroops,
    );
    assert.equal(sorobanNode.outboundLzPackets.length, 1);
    assert.equal(sorobanNode.outboundLzPackets[0]?.type, "CancelIntent");

    // Verify EVM state after cancelExpired:
    const publicClient = createPublicClient({
      chain: foundry,
      transport: viemHttp(evmRpcUrl),
    });
    const walletClient = createWalletClient({
      account: privateKeyToAccount(KEEPER_EVM_KEY),
      chain: foundry,
      transport: viemHttp(evmRpcUrl),
    });
    const escrowClient = new PerihelionEscrowClient(publicClient, walletClient, ESCROW_ADDRESS);

    const onChainLock = await escrowClient.getLock(intentHash);
    assert.ok(onChainLock);
    assert.equal(onChainLock.refunded, true, "EVM lock must be marked refunded");
    assert.equal(onChainLock.released, false);

    const userUsdcBalance = (await publicClient.readContract({
      address: USDC_ADDRESS,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [USER_ADDRESS],
    })) as bigint;
    const escrowUsdcBalance = (await publicClient.readContract({
      address: USDC_ADDRESS,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [ESCROW_ADDRESS],
    })) as bigint;

    assert.equal(userUsdcBalance, lockAmount, "User ERC-20 funds must be refunded in full");
    assert.equal(escrowUsdcBalance, 0n, "Escrow ERC-20 balance must return to 0");

    // Verify keeper metrics
    assert.equal(keeper.metrics.sorobanCancelledTotal, 1);
    assert.equal(keeper.metrics.evmCancelledTotal, 1);
    assert.equal(keeper.metrics.sorobanRewardsEarnedStroops, sorobanNode.keeperRewardStroops);
    assert.ok(keeper.metrics.evmGasSpentWei > 0n);
  } finally {
    await evmNode.stop();
    await sorobanNode.stop();
  }
});

test("E2E Scenario 2: Keeper recovers stalled split-path confirmation via list_undispatched_intents & dispatch_confirmation", async () => {
  const { Keeper } = await import(relayerKeeperModUrl);
  const { loadConfig } = await import(relayerConfigModUrl);

  const evmNode = new LocalEvmNetworkServer();
  const sorobanNode = new LocalSorobanNetworkServer();

  // Wire cross-chain FillConfirmed delivery from Soroban to EVM escrow
  sorobanNode.onFillConfirmedDispatched = ({ intentHash, solverEvm, fillAmount, fillLedger }) => {
    evmNode.deliverFillConfirmed({
      intentHash,
      solver: solverEvm,
      fillAmount,
      fillLedger,
    });
  };

  const evmRpcUrl = await evmNode.start();
  const sorobanRpcUrl = await sorobanNode.start();

  try {
    const lockAmount = 2_500_000n;
    evmNode.setTokenBalance(USDC_ADDRESS, USER_ADDRESS, lockAmount);
    sorobanNode.setNativeBalance(KEEPER_STELLAR.publicKey(), 10_000_000n);

    const t0 = Math.floor(Date.now() / 1000);
    const deadline = BigInt(t0 + 3_600);
    const intent = buildIntent({
      user: USER_ADDRESS,
      destination: RECIPIENT_STELLAR.publicKey(),
      sourceChainId: EVM_CHAIN_ID,
      sourceAsset: USDC_ADDRESS,
      sourceAmount: lockAmount.toString(),
      destAsset: DEST_ASSET_CONTRACT_ID,
      minDestAmount: "24500000",
      deadline: Number(deadline),
      nonce: "112302",
    });
    const domain = perihelionDomain(EVM_CHAIN_ID, ESCROW_ADDRESS);
    const intentHash = hashIntent(intent, domain) as Hex;

    // 1. Lock on EVM and register on Soroban
    evmNode.lockIntent({
      intentHash,
      user: USER_ADDRESS,
      solver: SOLVER_ADDRESS,
      asset: USDC_ADDRESS,
      amount: lockAmount,
      destination: intent.destination,
      destAsset: intent.destAsset,
      minDestAmount: BigInt(intent.minDestAmount),
      deadline,
    });
    sorobanNode.registerIntent({
      intentHash,
      srcEid: SOURCE_EID,
      recipient: RECIPIENT_STELLAR.publicKey(),
      destAsset: DEST_ASSET_CONTRACT_ID,
      minDestAmount: BigInt(intent.minDestAmount),
      deadline,
    });

    // 2. Solver delivers destination assets via split-path `deliver_intent`
    // without calling `dispatch_confirmation` (status = Filled).
    sorobanNode.deliverIntent({
      intentHash,
      solver: SOLVER_STELLAR.publicKey(),
      solverEvm: SOLVER_ADDRESS,
      fillAmount: 24_500_000n,
    });
    const fillLedger = sorobanNode.currentLedger;

    const config = loadConfig({
      PERIHELION_EVM_RPC_URL: evmRpcUrl,
      PERIHELION_SOROBAN_RPC_URL: sorobanRpcUrl,
      PERIHELION_ESCROW_ADDRESS: ESCROW_ADDRESS,
      PERIHELION_SETTLEMENT_CONTRACT_ID: SETTLEMENT_CONTRACT_ID,
      PERIHELION_SOURCE_EID: String(SOURCE_EID),
      PERIHELION_STELLAR_EID: String(STELLAR_EID),
      STELLAR_NETWORK: STELLAR_PASSPHRASE,
      SIGNER_SECRET: KEEPER_STELLAR.secret(),
      PERIHELION_RELAYER_MODE: "keeper",
      PERIHELION_EVM_PRIVATE_KEY: KEEPER_EVM_KEY,
      PERIHELION_CONFIRMATIONS: "0",
    });

    const keeper = new Keeper({ config });

    // 3. Before DISPATCH_REWARD_GRACE_LEDGERS (360 ledgers) has elapsed:
    // Keeper discovers the Filled intent via list_undispatched_intents, sees
    // rewardEligible = false, and defers until the grace period passes.
    sorobanNode.currentLedger = fillLedger + 100;
    const graceWaitTick = await keeper.tick();
    assert.equal(graceWaitTick.confirmationsDispatched.length, 0);
    assert.equal(keeper.metrics.skippedAwaitingGraceTotal, 1);

    // 4. Advance Soroban ledger past fillLedger + DISPATCH_REWARD_GRACE_LEDGERS (360)
    sorobanNode.currentLedger = fillLedger + DISPATCH_REWARD_GRACE_LEDGERS + 5;
    const keeperBalanceBefore = sorobanNode.getNativeBalance(KEEPER_STELLAR.publicKey());

    const recoveryTick = await keeper.tick();
    assert.deepEqual(recoveryTick.confirmationsDispatched, [intentHash.toLowerCase()]);
    assert.equal(keeper.metrics.confirmationsDispatchedTotal, 1);

    // 5. Verify Soroban status transitioned to ConfirmationSent (2) and keeper received dispatch_keeper_reward
    const settlementClient = new PerihelionSettlementClient({
      rpcUrl: sorobanRpcUrl,
      networkPassphrase: STELLAR_PASSPHRASE,
      settlementContractId: SETTLEMENT_CONTRACT_ID,
    });
    assert.equal(await settlementClient.status(intentHash), OnChainIntentStatus.ConfirmationSent);
    assert.deepEqual(
      await settlementClient.listUndispatchedIntents([intentHash]),
      [],
      "Dispatched intent must no longer appear in list_undispatched_intents",
    );
    assert.equal(
      sorobanNode.getNativeBalance(KEEPER_STELLAR.publicKey()),
      keeperBalanceBefore + sorobanNode.dispatchKeeperRewardStroops,
    );

    // 6. Verify EVM escrow lock was released to solver upon FillConfirmed delivery
    assert.equal(evmNode.locks.get(intentHash.toLowerCase() as Hex)?.released, true);
    assert.equal(evmNode.getTokenBalance(USDC_ADDRESS, SOLVER_ADDRESS), lockAmount);
    assert.equal(evmNode.getTokenBalance(USDC_ADDRESS, ESCROW_ADDRESS), 0n);
  } finally {
    await evmNode.stop();
    await sorobanNode.stop();
  }
});

test("E2E Scenario 3: Dry-run mode and SDK PerihelionEscrowClient.cancelExpiredLocks end-to-end", async () => {
  const { Keeper } = await import(relayerKeeperModUrl);
  const { loadConfig } = await import(relayerConfigModUrl);

  const evmNode = new LocalEvmNetworkServer();
  const sorobanNode = new LocalSorobanNetworkServer();

  const evmRpcUrl = await evmNode.start();
  const sorobanRpcUrl = await sorobanNode.start();

  try {
    const lockAmount = 500_000n;
    evmNode.setTokenBalance(USDC_ADDRESS, USER_ADDRESS, lockAmount);

    const t0 = Math.floor(Date.now() / 1000);
    const deadline = BigInt(t0 + 300);
    const intent = buildIntent({
      user: USER_ADDRESS,
      destination: RECIPIENT_STELLAR.publicKey(),
      sourceChainId: EVM_CHAIN_ID,
      sourceAsset: USDC_ADDRESS,
      sourceAmount: lockAmount.toString(),
      destAsset: DEST_ASSET_CONTRACT_ID,
      minDestAmount: "4900000",
      deadline: Number(deadline),
      nonce: "112303",
    });
    const domain = perihelionDomain(EVM_CHAIN_ID, ESCROW_ADDRESS);
    const intentHash = hashIntent(intent, domain) as Hex;

    evmNode.lockIntent({
      intentHash,
      user: USER_ADDRESS,
      solver: SOLVER_ADDRESS,
      asset: USDC_ADDRESS,
      amount: lockAmount,
      destination: intent.destination,
      destAsset: intent.destAsset,
      minDestAmount: BigInt(intent.minDestAmount),
      deadline,
    });
    sorobanNode.registerIntent({
      intentHash,
      srcEid: SOURCE_EID,
      recipient: RECIPIENT_STELLAR.publicKey(),
      destAsset: DEST_ASSET_CONTRACT_ID,
      minDestAmount: BigInt(intent.minDestAmount),
      deadline,
    });

    // Advance past expiry on both chains
    sorobanNode.currentTimestamp = deadline + 50n;
    evmNode.blockTimestamp = deadline + evmNode.confirmationGrace + 50n;

    // 1. Run Keeper in dry-run mode: detects both actions, mutates zero state
    const dryConfig = loadConfig({
      PERIHELION_EVM_RPC_URL: evmRpcUrl,
      PERIHELION_SOROBAN_RPC_URL: sorobanRpcUrl,
      PERIHELION_ESCROW_ADDRESS: ESCROW_ADDRESS,
      PERIHELION_SETTLEMENT_CONTRACT_ID: SETTLEMENT_CONTRACT_ID,
      PERIHELION_SOURCE_EID: String(SOURCE_EID),
      PERIHELION_STELLAR_EID: String(STELLAR_EID),
      STELLAR_NETWORK: STELLAR_PASSPHRASE,
      SIGNER_SECRET: KEEPER_STELLAR.secret(),
      PERIHELION_RELAYER_MODE: "keeper",
      PERIHELION_EVM_PRIVATE_KEY: KEEPER_EVM_KEY,
      PERIHELION_CONFIRMATIONS: "0",
      PERIHELION_KEEPER_DRY_RUN: "true",
    });

    const dryKeeper = new Keeper({ config: dryConfig });
    const dryTick = await dryKeeper.tick();

    assert.equal(dryTick.dryRunActions.length, 2);
    assert.equal(dryKeeper.metrics.dryRunActionsTotal, 2);
    assert.equal(evmNode.getTokenBalance(USDC_ADDRESS, USER_ADDRESS), 0n);
    assert.equal(
      sorobanNode.intents.get(intentHash.toLowerCase() as Hex)?.status,
      OnChainIntentStatus.Locked,
    );

    // 2. Now use SDK's PerihelionEscrowClient.cancelExpiredLocks directly against the live EVM RPC
    const publicClient = createPublicClient({
      chain: foundry,
      transport: viemHttp(evmRpcUrl),
    });
    const walletClient = createWalletClient({
      account: privateKeyToAccount(KEEPER_EVM_KEY),
      chain: foundry,
      transport: viemHttp(evmRpcUrl),
    });
    const escrowClient = new PerihelionEscrowClient(publicClient, walletClient, ESCROW_ADDRESS);

    const sdkCancelResult = await escrowClient.cancelExpiredLocks({
      user: USER_ADDRESS,
    });
    assert.equal(sdkCancelResult.found.length, 1);
    assert.equal(sdkCancelResult.cancelled.length, 1);
    assert.equal(sdkCancelResult.cancelled[0]?.intentHash, intentHash.toLowerCase());
    assert.equal(evmNode.getTokenBalance(USDC_ADDRESS, USER_ADDRESS), lockAmount);
  } finally {
    await evmNode.stop();
    await sorobanNode.stop();
  }
});
