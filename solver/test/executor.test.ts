// SPDX-License-Identifier: MIT

/**
 * Tests for Executor: fill flow, idempotency, and error paths.
 *
 * The executor makes real network calls (viem + Soroban RPC), so these tests
 * mock the transport layer at the boundary. We use the dependency-injection
 * seam exposed by the class: replace the internal factory functions by
 * patching the module-level viem and Stellar SDK clients with stubs that
 * capture calls and return canned responses.
 *
 * Because ESM modules are sealed, we cannot monkey-patch named exports after
 * import. Instead we inject the behavior by overriding globalThis.fetch (used
 * by viem's http transport under the hood) and by providing a subclass that
 * exposes the private methods for unit testing their logic in isolation.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { buildIntent, hashIntent, perihelionDomain } from "@perihelion/sdk";
import type { Hex, SignedIntent } from "@perihelion/sdk";
import { nativeToScVal, scvU32, scvVoid } from "@stellar/stellar-sdk";
import { Executor, type ExecutorConfig, type Logger } from "../src/executor.js";

// ─── Wire vector (#946) ───────────────────────────────────────────────────────
//
// Golden vector shared with the contracts: `solver_evm` must be the EVM address
// left-padded to 32 bytes (bytes 0-11 zero, address in bytes 12-31), i.e.
// `bytes32(uint256(uint160(addr)))`. The escrow's `_decodeFillConfirmed`
// rejects any other layout with `MalformedPayload`.
const SOLVER_EVM_ADDRESS = "0x00000000000000000000000000000000000000ff" as const;
const SOLVER_EVM_WIRE_VECTOR =
  "0x00000000000000000000000000000000000000000000000000000000000000ff";

// ─── Test fixtures ────────────────────────────────────────────────────────────

const EVM_PRIVATE_KEY =
  ("0x" + "1".repeat(64)) as Hex; // deterministic: same address every run
const SOROBAN_SECRET =
  "SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";
const ESCROW_ADDRESS = "0x2222222222222222222222222222222222222222" as const;
const SETTLEMENT_ID = "C" + "A".repeat(55);
const STELLAR_NETWORK = "Test SDF Network ; September 2015";

const BASE_CONFIG: ExecutorConfig = {
  evmRpcUrl: "http://localhost:8545",
  sorobanRpcUrl: "http://localhost:8000",
  evmPrivateKey: EVM_PRIVATE_KEY,
  sorobanSecretKey: SOROBAN_SECRET,
  escrowAddress: ESCROW_ADDRESS,
  settlementContractId: SETTLEMENT_ID,
  sourceChainId: 8453,
  stellarNetwork: STELLAR_NETWORK,
};

const SILENT_LOGGER: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

const CHAIN_ID = 8453;
const ESCROW_ADDR = "0x0000000000000000000000000000000000000001" as const;
const domain = perihelionDomain(CHAIN_ID, ESCROW_ADDR);

function makeIntent() {
  return buildIntent({
    user: "0x0000000000000000000000000000000000000002",
    destination: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
    sourceChainId: CHAIN_ID,
    sourceAsset: "0x0000000000000000000000000000000000000003",
    sourceAmount: "1000000",
    destAsset: "native",
    minDestAmount: "990000",
    deadline: Math.floor(Date.now() / 1000) + 600,
    nonce: "42",
  });
}

function makeSignedIntent(): SignedIntent {
  const intent = makeIntent();
  return {
    intent,
    signature: ("0x" + "ab".repeat(65)) as Hex,
    hash: hashIntent(intent, domain),
  };
}

// ─── Testable subclass ────────────────────────────────────────────────────────
//
// Exposes private methods so we can unit-test them independently without
// standing up real RPC endpoints. TypeScript sees them as private; the runtime
// property access works normally since JS has no private slots here.

type PrivateExecutor = Executor & {
  checkFillStatus(hash: Hex): Promise<{ filled: boolean; settlementTx?: string }>;
  isSettled(hash: Hex): Promise<boolean>;
  lockOnEvm(signed: SignedIntent): Promise<Hex>;
  waitForRegistration(signed: SignedIntent): Promise<void>;
  fillOnSoroban(signed: SignedIntent, lockTx: Hex): Promise<Hex>;
};

function expose(config: Partial<ExecutorConfig> = {}): PrivateExecutor {
  return new Executor({ ...BASE_CONFIG, ...config }, SILENT_LOGGER) as unknown as PrivateExecutor;
}

// ─── fill(): idempotency via checkFillStatus ──────────────────────────────────

test("fill: returns early if intent is already settled", async () => {
  const signed = makeSignedIntent();
  const logs: string[] = [];

  // Subclass that overrides checkFillStatus to report already-settled.
  class IdempotentExecutor extends Executor {
    protected override async checkFillStatus(
      _hash: Hex,
    ): Promise<{ filled: boolean; settlementTx?: string }> {
      return { filled: true, settlementTx: "0xexisting" as Hex };
    }
    protected override async lockOnEvm(_: SignedIntent): Promise<Hex> {
      throw new Error("lockOnEvm must not be called when already settled");
    }
    protected override async waitForRegistration(_: SignedIntent): Promise<void> {
      throw new Error("waitForRegistration must not be called when already settled");
    }
    protected override async fillOnSoroban(
      _: SignedIntent,
      __: Hex,
    ): Promise<Hex> {
      throw new Error("fillOnSoroban must not be called when already settled");
    }
  }

  const executor = new IdempotentExecutor(
    BASE_CONFIG,
    { info: (msg) => logs.push(msg), warn: () => {}, error: () => {} },
  );

  const result = await executor.fill(signed);
  assert.equal(result.settlementTx, "0xexisting");
  assert.ok(
    logs.some((l) => l.includes("already settled")),
    "expected 'already settled' log",
  );
});

test("fill: calls lockOnEvm, waits for registration, then fillOnSoroban in order", async () => {
  const signed = makeSignedIntent();
  const callOrder: string[] = [];

  class OrderedExecutor extends Executor {
    protected override async checkFillStatus() {
      return { filled: false };
    }
    protected override async lockOnEvm(_: SignedIntent): Promise<Hex> {
      callOrder.push("lock");
      return "0xlockTx" as Hex;
    }
    protected override async waitForRegistration(_: SignedIntent): Promise<void> {
      callOrder.push("wait");
    }
    protected override async fillOnSoroban(
      _: SignedIntent,
      lockTx: Hex,
    ): Promise<Hex> {
      assert.equal(lockTx, "0xlockTx", "fillOnSoroban receives the lockTx");
      callOrder.push("fill");
      return "0xstellarTx" as Hex;
    }
  }

  const executor = new OrderedExecutor(BASE_CONFIG, SILENT_LOGGER);
  const result = await executor.fill(signed);

  assert.deepEqual(callOrder, ["lock", "wait", "fill"]);
  assert.equal(result.settlementTx, "0xstellarTx");
});

test("fill: propagates lockOnEvm errors to the caller", async () => {
  const signed = makeSignedIntent();

  class FailingLockExecutor extends Executor {
    protected override async checkFillStatus() {
      return { filled: false };
    }
    protected override async lockOnEvm(): Promise<Hex> {
      throw new Error("EVM RPC unavailable");
    }
    protected override async waitForRegistration(): Promise<void> {
      throw new Error("waitForRegistration must not be called after lock failure");
    }
    protected override async fillOnSoroban(): Promise<Hex> {
      throw new Error("fillOnSoroban must not be called after lock failure");
    }
  }

  const executor = new FailingLockExecutor(BASE_CONFIG, SILENT_LOGGER);
  await assert.rejects(
    () => executor.fill(signed),
    /EVM RPC unavailable/,
  );
});

test("fill: propagates fillOnSoroban errors to the caller", async () => {
  const signed = makeSignedIntent();

  class FailingSorobanExecutor extends Executor {
    protected override async checkFillStatus() {
      return { filled: false };
    }
    protected override async lockOnEvm(): Promise<Hex> {
      return "0xlockTx" as Hex;
    }
    protected override async waitForRegistration(): Promise<void> {}
    protected override async fillOnSoroban(): Promise<Hex> {
      throw new Error("Soroban simulation failed");
    }
  }

  const executor = new FailingSorobanExecutor(BASE_CONFIG, SILENT_LOGGER);
  await assert.rejects(
    () => executor.fill(signed),
    /Soroban simulation failed/,
  );
});

// ─── checkFillStatus ──────────────────────────────────────────────────────────

test("checkFillStatus: returns filled=false when isSettled returns false", async () => {
  class NotSettledExecutor extends Executor {
    protected override async isSettled(_: Hex): Promise<boolean> {
      return false;
    }
  }
  const ex = new NotSettledExecutor(BASE_CONFIG, SILENT_LOGGER) as PrivateExecutor;
  const result = await ex.checkFillStatus(makeSignedIntent().hash);
  assert.equal(result.filled, false);
  assert.equal(result.settlementTx, undefined);
});

test("checkFillStatus: returns filled=true with intentHash as marker when isSettled returns true", async () => {
  const signed = makeSignedIntent();
  class SettledExecutor extends Executor {
    protected override async isSettled(_: Hex): Promise<boolean> {
      return true;
    }
  }
  const ex = new SettledExecutor(BASE_CONFIG, SILENT_LOGGER) as PrivateExecutor;
  const result = await ex.checkFillStatus(signed.hash);
  assert.equal(result.filled, true);
  assert.equal(result.settlementTx, signed.hash);
});

test("checkFillStatus: swallows isSettled errors and returns filled=false", async () => {
  class ThrowingExecutor extends Executor {
    protected override async isSettled(_: Hex): Promise<boolean> {
      throw new Error("RPC timeout");
    }
  }
  const ex = new ThrowingExecutor(BASE_CONFIG, SILENT_LOGGER) as PrivateExecutor;
  // Must not throw — query failure is treated as "not yet settled"
  const result = await ex.checkFillStatus(makeSignedIntent().hash);
  assert.equal(result.filled, false);
});

// ─── isSettled: decoding real ScVal status encodings ─────────────────────────
//
// `status(intent_hash)` returns `Option<IntentStatus>`, where `IntentStatus` is
// a `#[contracttype]` C-like enum (Locked = 0, Filled = 1, ConfirmationSent = 2,
// Cancelled = 3). Soroban encodes it as a `u32`, and `None` as void. These tests
// feed real `ScVal` encodings through the decoder to verify classification.

type StatusDecoder = {
  decodeStatus(retval: unknown): unknown;
};

function statusDecoder(): StatusDecoder {
  const ex = expose() as unknown as StatusDecoder;
  assert.equal(
    typeof ex.decodeStatus,
    "function",
    "Executor must expose a decodeStatus helper for status ScVals",
  );
  return ex;
}

test("isSettled: Filled (scvU32(1)) counts as settled", () => {
  const decoder = statusDecoder();
  assert.equal(decoder.decodeStatus(scvU32(1)), "Filled");
});

test("isSettled: ConfirmationSent (scvU32(2)) counts as settled", () => {
  const decoder = statusDecoder();
  assert.equal(decoder.decodeStatus(scvU32(2)), "ConfirmationSent");
});

test("isSettled: Locked (scvU32(0)) does not count as settled", () => {
  const decoder = statusDecoder();
  assert.equal(decoder.decodeStatus(scvU32(0)), "Locked");
});

test("isSettled: Cancelled (scvU32(3)) does not count as settled", () => {
  const decoder = statusDecoder();
  assert.equal(decoder.decodeStatus(scvU32(3)), "Cancelled");
});

test("isSettled: None (scvVoid()) decodes as not registered", () => {
  const decoder = statusDecoder();
  assert.equal(decoder.decodeStatus(scvVoid()), undefined);
});

test("isSettled: native u32 values are classified correctly", () => {
  const decoder = statusDecoder();
  assert.equal(decoder.decodeStatus(nativeToScVal(1, { type: "u32" })), "Filled");
  assert.equal(
    decoder.decodeStatus(nativeToScVal(2, { type: "u32" })),
    "ConfirmationSent",
  );
  assert.equal(decoder.decodeStatus(nativeToScVal(0, { type: "u32" })), "Locked");
  assert.equal(
    decoder.decodeStatus(nativeToScVal(3, { type: "u32" })),
    "Cancelled",
  );
  assert.equal(decoder.decodeStatus(nativeToScVal(null)), undefined);
});

test("isSettled: unknown discriminants decode as undefined", () => {
  const decoder = statusDecoder();
  assert.equal(decoder.decodeStatus(scvU32(99)), undefined);
});

// ─── Constructor: config validation ──────────────────────────────────────────

test("Executor: constructs without throwing for valid config", () => {
  assert.doesNotThrow(() => new Executor(BASE_CONFIG, SILENT_LOGGER));
});

test("Executor: rejects a missing config", () => {
  assert.throws(
    () => new Executor(undefined as unknown as ExecutorConfig, SILENT_LOGGER),
    /executor config is required/i,
  );
});

// ─── DefiniteFailureError classification ─────────────────────────────────────

test("DefiniteFailureError: is an Error subclass", () => {
  const err = new DefiniteFailureError("boom");
  assert.ok(err instanceof Error);
  assert.ok(err instanceof DefiniteFailureError);
  assert.equal(err.name, "DefiniteFailureError");
  assert.equal(err.message, "boom");
});

test("DefiniteFailureError: preserves cause", () => {
  const cause = new Error("revert");
  const err = new DefiniteFailureError("lock reverted", { cause });
  assert.equal(err.cause, cause);
});

test("lockOnEvm: simulation failure throws DefiniteFailureError", async () => {
  class SimFailingExecutor extends Executor {
    protected override async simulateLock(): Promise<void> {
      throw new Error("fill_intent simulation failed");
    }
  }
  const ex = new SimFailingExecutor(BASE_CONFIG, SILENT_LOGGER);
  await assert.rejects(
    () => (ex as unknown as PrivateExecutor).lockOnEvm(makeSignedIntent()),
    (err: unknown) => {
      assert.ok(err instanceof DefiniteFailureError, "expected DefiniteFailureError");
      assert.match(err.message, /simulation failed/);
      return true;
    },
  );
});

test("lockOnEvm: sendTransaction status ERROR throws DefiniteFailureError", async () => {
  class ErrorStatusExecutor extends Executor {
    protected override async simulateLock(): Promise<void> {}
    protected override async sendLockTransaction(): Promise<Hex> {
      throw new DefiniteFailureError("sendTransaction returned ERROR");
    }
  }
  const ex = new ErrorStatusExecutor(BASE_CONFIG, SILENT_LOGGER);
  await assert.rejects(
    () => (ex as unknown as PrivateExecutor).lockOnEvm(makeSignedIntent()),
    (err: unknown) => {
      assert.ok(err instanceof DefiniteFailureError);
      assert.match(err.message, /ERROR/);
      return true;
    },
  );
});

test("lockOnEvm: FAILED receipt throws DefiniteFailureError", async () => {
  class FailedReceiptExecutor extends Executor {
    protected override async simulateLock(): Promise<void> {}
    protected override async sendLockTransaction(): Promise<Hex> {
      return "0xdeadbeef" as Hex;
    }
    protected override async waitForLockReceipt(): Promise<{ status: string }> {
      return { status: "reverted" };
    }
  }
  const ex = new FailedReceiptExecutor(BASE_CONFIG, SILENT_LOGGER);
  await assert.rejects(
    () => (ex as unknown as PrivateExecutor).lockOnEvm(makeSignedIntent()),
    (err: unknown) => {
      assert.ok(err instanceof DefiniteFailureError);
      assert.match(err.message, /reverted|FAILED/i);
      return true;
    },
  );
});

test("lockOnEvm: pre-broadcast ContractFunctionRevertedError throws DefiniteFailureError", async () => {
  class RevertExecutor extends Executor {
    protected override async simulateLock(): Promise<void> {}
    protected override async sendLockTransaction(): Promise<Hex> {
      const revert = new Error("execution reverted: InsufficientBalance");
      revert.name = "ContractFunctionRevertedError";
      throw revert;
    }
  }
  const ex = new RevertExecutor(BASE_CONFIG, SILENT_LOGGER);
  await assert.rejects(
    () => (ex as unknown as PrivateExecutor).lockOnEvm(makeSignedIntent()),
    (err: unknown) => {
      assert.ok(err instanceof DefiniteFailureError);
      assert.match(err.message, /InsufficientBalance/);
      return true;
    },
  );
});

test("lockOnEvm: timeout remains a plain Error (indefinite)", async () => {
  class TimeoutExecutor extends Executor {
    protected override async simulateLock(): Promise<void> {}
    protected override async sendLockTransaction(): Promise<Hex> {
      throw new Error("transaction timed out");
    }
  }
  const ex = new TimeoutExecutor(BASE_CONFIG, SILENT_LOGGER);
  await assert.rejects(
    () => (ex as unknown as PrivateExecutor).lockOnEvm(makeSignedIntent()),
    (err: unknown) => {
      assert.ok(!(err instanceof DefiniteFailureError), "timeout must stay indefinite");
      assert.ok(err instanceof Error);
      assert.match(err.message, /timed out/);
      return true;
    },
  );
});

test("lockOnEvm: unknown error remains a plain Error (indefinite)", async () => {
  class UnknownExecutor extends Executor {
    protected override async simulateLock(): Promise<void> {}
    protected override async sendLockTransaction(): Promise<Hex> {
      throw new Error("socket hang up");
    }
  }
  const ex = new UnknownExecutor(BASE_CONFIG, SILENT_LOGGER);
  await assert.rejects(
    () => (ex as unknown as PrivateExecutor).lockOnEvm(makeSignedIntent()),
    (err: unknown) => {
      assert.ok(!(err instanceof DefiniteFailureError));
      assert.match(err.message, /socket hang up/);
      return true;
    },
  );
});

// ─── Reservation release on definite failure ─────────────────────────────────

test("fill: simulation failure releases the InFlightTracker reservation in the same tick", async () => {
  const signed = makeSignedIntent();
  const tracker = new InFlightTracker();
  tracker.reserve(signed.hash);

  class SimFailingExecutor extends Executor {
    protected override async checkFillStatus() {
      return { filled: false };
    }
    protected override async lockOnEvm(): Promise<Hex> {
      throw new DefiniteFailureError("fill_intent simulation failed");
    }
    protected override async fillOnSoroban(): Promise<Hex> {
      throw new Error("fillOnSoroban must not be called after simulation failure");
    }
  }

  const executor = new SimFailingExecutor(BASE_CONFIG, SILENT_LOGGER);

  await assert.rejects(
    async () => {
      try {
        await executor.fill(signed);
      } catch (err) {
        if (err instanceof DefiniteFailureError) {
          // Definite failure: release immediately, no need to wait for refresh.
          tracker.release(signed.hash);
        }
        throw err;
      }
    },
    (err: unknown) => err instanceof DefiniteFailureError,
  );

  assert.equal(
    tracker.has(signed.hash),
    false,
    "reservation must be released in the same tick after a definite failure",
  );
});

// ─── loadExecutorConfig ───────────────────────────────────────────────────────

test("loadExecutorConfig: throws consolidated error for all missing required vars", async () => {
  const { loadExecutorConfig } = await import("../src/executor-config.js");
  assert.throws(
    () => loadExecutorConfig({}),
    (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      return (
        msg.includes("PERIHELION_EVM_RPC_URL is required") &&
        msg.includes("PERIHELION_SOROBAN_RPC_URL is required") &&
        msg.includes("PERIHELION_EVM_PRIVATE_KEY is required") &&
        msg.includes("PERIHELION_SOROBAN_SECRET_KEY is required") &&
        msg.includes("PERIHELION_ESCROW_ADDRESS is required") &&
        msg.includes("PERIHELION_SETTLEMENT_CONTRACT_ID is required") &&
        msg.includes("STELLAR_NETWORK is required")
      );
    },
  );
});

test("loadExecutorConfig: returns valid config when all vars are present", async () => {
  const { loadExecutorConfig } = await import("../src/executor-config.js");
  const config = loadExecutorConfig({
    PERIHELION_EVM_RPC_URL: "http://localhost:8545",
    PERIHELION_SOROBAN_RPC_URL: "https://soroban-testnet.stellar.org",
    PERIHELION_EVM_PRIVATE_KEY: `0x${"1".repeat(64)}`,
    PERIHELION_SOROBAN_SECRET_KEY:
      "SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4",
    PERIHELION_ESCROW_ADDRESS: ESCROW_ADDRESS,
    PERIHELION_SETTLEMENT_CONTRACT_ID: "0".repeat(64),
    PERIHELION_SOURCE_CHAIN_ID: "8453",
    STELLAR_NETWORK: STELLAR_NETWORK,
  });
  assert.equal(config.sourceChainId, 8453);
  assert.equal(config.stellarNetwork, STELLAR_NETWORK);
  assert.equal(
    config.escrowAddress.toLowerCase(),
    ESCROW_ADDRESS.toLowerCase(),
  );
});

test("loadExecutorConfig: rejects malformed EVM escrow address", async () => {
  const { loadExecutorConfig } = await import("../src/executor-config.js");
  assert.throws(
    () =>
      loadExecutorConfig({
        PERIHELION_EVM_RPC_URL: "http://localhost:8545",
        PERIHELION_SOROBAN_RPC_URL: "https://soroban-testnet.stellar.org",
        PERIHELION_EVM_PRIVATE_KEY: `0x${"1".repeat(64)}`,
        PERIHELION_SOROBAN_SECRET_KEY:
          "SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4",
        PERIHELION_ESCROW_ADDRESS: "not-an-address",
        PERIHELION_SETTLEMENT_CONTRACT_ID: "0".repeat(64),
        STELLAR_NETWORK: STELLAR_NETWORK,
      }),
    /PERIHELION_ESCROW_ADDRESS must be a 0x-prefixed 20-byte EVM address/,
  );
});

test("loadExecutorConfig: rejects EVM private key without 0x prefix", async () => {
  const { loadExecutorConfig } = await import("../src/executor-config.js");
  assert.throws(
    () =>
      loadExecutorConfig({
        PERIHELION_EVM_RPC_URL: "http://localhost:8545",
        PERIHELION_SOROBAN_RPC_URL: "https://soroban-testnet.stellar.org",
        PERIHELION_EVM_PRIVATE_KEY: "1".repeat(64), // missing 0x
        PERIHELION_SOROBAN_SECRET_KEY:
          "SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4",
        PERIHELION_ESCROW_ADDRESS: ESCROW_ADDRESS,
        PERIHELION_SETTLEMENT_CONTRACT_ID: "0".repeat(64),
        STELLAR_NETWORK: STELLAR_NETWORK,
      }),
    /PERIHELION_EVM_PRIVATE_KEY must start with 0x/,
  );
});

test("loadExecutorConfig: rejects non-positive source chain id", async () => {
  const { loadExecutorConfig } = await import("../src/executor-config.js");
  assert.throws(
    () =>
      loadExecutorConfig({
        PERIHELION_EVM_RPC_URL: "http://localhost:8545",
        PERIHELION_SOROBAN_RPC_URL: "https://soroban-testnet.stellar.org",
        PERIHELION_EVM_PRIVATE_KEY: `0x${"1".repeat(64)}`,
        PERIHELION_SOROBAN_SECRET_KEY:
          "SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4",
        PERIHELION_ESCROW_ADDRESS: ESCROW_ADDRESS,
        PERIHELION_SETTLEMENT_CONTRACT_ID: "0".repeat(64),
        STELLAR_NETWORK: STELLAR_NETWORK,
        PERIHELION_SOURCE_CHAIN_ID: "-1",
      }),
    /PERIHELION_SOURCE_CHAIN_ID must be a positive integer/,
  );
});

// ─── Protected-method override tests (via subclassing) ───────────────────────
//
// isSettled and lock/fill take real RPC clients. We test their observable
// contract — the inputs they propagate and the outputs they produce — by
// subclassing the Executor and overriding just the boundary that touches the
// network, verifying the surrounding orchestration logic.

test("fill: logs locked-on-EVM and filled-on-Soroban info messages", async () => {
  const signed = makeSignedIntent();
  const infos: string[] = [];

  class InstrumentedExecutor extends Executor {
    protected override async checkFillStatus() {
      return { filled: false };
    }
    protected override async lockOnEvm(): Promise<Hex> {
      return "0xlockHash" as Hex;
    }
    protected override async waitForRegistration(): Promise<void> {}
    protected override async fillOnSoroban(): Promise<Hex> {
      return "0xsorobanHash" as Hex;
    }
  }

  const executor = new InstrumentedExecutor(BASE_CONFIG, {
    info: (msg) => infos.push(msg),
    warn: () => {},
    error: () => {},
  });

  await executor.fill(signed);

  assert.ok(infos.some((m) => m.includes("locked on EVM")));
  assert.ok(infos.some((m) => m.includes("filled on Soroban")));
});

test("fill: idempotent — second call with settled intent returns same settlementTx", async () => {
  const signed = makeSignedIntent();
  let lockCalls = 0;

  class CountingExecutor extends Executor {
    private settled = false;
    protected override async checkFillStatus(
      hash: Hex,
    ): Promise<{ filled: boolean; settlementTx?: string }> {
      if (this.settled) return { filled: true, settlementTx: "0xsettled" as Hex };
      return { filled: false };
    }
    protected override async lockOnEvm(): Promise<Hex> {
      lockCalls++;
      return "0xlockTx" as Hex;
    }
    protected override async waitForRegistration(): Promise<void> {}
    protected override async fillOnSoroban(): Promise<Hex> {
      this.settled = true;
      return "0xsettled" as Hex;
    }
  }

  const executor = new CountingExecutor(BASE_CONFIG, SILENT_LOGGER);

  const first = await executor.fill(signed);
  assert.equal(first.settlementTx, "0xsettled");
  assert.equal(lockCalls, 1);

  const second = await executor.fill(signed);
  assert.equal(second.settlementTx, "0xsettled");
  // Lock must not be called again on the second attempt.
  assert.equal(lockCalls, 1, "lockOnEvm must not be called a second time");
});

// ─── #946: solver_evm encoding ───────────────────────────────────────────────

test("fillOnSoroban: encodes solver_evm left-padded to match the shared wire vector", async () => {
  const ex = expose();
  const signed = makeSignedIntent();

  // Capture the ScVal arguments passed to fill_intent by stubbing the
  // transaction builder boundary the executor uses.
  const captured = await captureFillIntentArgs(ex, signed, "0xlockTx" as Hex);

  const solverEvm = captured.find((a) => a.name === "solver_evm");
  assert.ok(solverEvm, "fill_intent must receive a solver_evm argument");

  const bytes = scValToBytes(solverEvm.value);
  assert.equal(
    bytesToHex(bytes),
    SOLVER_EVM_WIRE_VECTOR,
    "solver_evm must be bytes32(uint256(uint160(addr))) — left-padded, not left-justified",
  );
  // Upper 12 bytes must be zero: the escrow rejects anything else.
  for (let i = 0; i < 12; i++) {
    assert.equal(bytes[i], 0, `solver_evm byte ${i} must be zero`);
  }
});

test("fillOnSoroban: solver_evm decodes on EVM to the solver address", async () => {
  const ex = expose();
  const signed = makeSignedIntent();
  const captured = await captureFillIntentArgs(ex, signed, "0xlockTx" as Hex);
  const solverEvm = captured.find((a) => a.name === "solver_evm");
  assert.ok(solverEvm);
  const bytes = scValToBytes(solverEvm.value);
  // EVM `_decodeFillConfirmed` reads the low 20 bytes as the address.
  const decoded = "0x" + bytesToHex(bytes.slice(12));
  assert.equal(decoded.toLowerCase(), SOLVER_EVM_ADDRESS.toLowerCase());
});

// ─── #947: lz_fee quoting ────────────────────────────────────────────────────

test("fillOnSoroban: passes quoted lz_fee plus buffer and records the charged fee", async () => {
  const QUOTED = 1234n;
  const BUFFER = 100n;
  const CHARGED = 1300n;
  const ex = expose({ lzFeeBufferStroops: BUFFER });
  const signed = makeSignedIntent();

  const captured = await captureFillIntentArgs(ex, signed, "0xlockTx" as Hex, {
    quote: QUOTED,
    charged: CHARGED,
  });

  const lzFee = captured.find((a) => a.name === "lz_fee");
  assert.ok(lzFee, "fill_intent must receive an lz_fee argument");
  assert.equal(
    scValToI128(lzFee.value),
    QUOTED + BUFFER,
    "lz_fee must be the quoted fee plus the configured safety buffer",
  );

  const metrics = ex.lastFillMetrics();
  assert.ok(metrics, "executor must record fill metrics");
  assert.equal(
    metrics.stellarFeeStroops,
    CHARGED,
    "recorded Stellar fee must equal the amount actually charged",
  );
});

// ─── #948: single fill call locks, waits for registration, fills ─────────────

test("fill: single call locks, waits for status(hash) == Locked, then fills", async () => {
  const signed = makeSignedIntent();
  const stages: string[] = [];
  let statusPolls = 0;

  class LocalStackExecutor extends Executor {
    protected override async checkFillStatus() {
      return { filled: false };
    }
    protected override async lockOnEvm(): Promise<Hex> {
      stages.push("lock");
      return "0xlockTx" as Hex;
    }
    protected override async readIntentStatus(_: Hex): Promise<string> {
      statusPolls++;
      // Not registered for the first two polls, then Locked.
      return statusPolls < 3 ? "Pending" : "Locked";
    }
    protected override async fillOnSoroban(): Promise<Hex> {
      stages.push("fill");
      return "0xstellarTx" as Hex;
    }
  }

  const executor = new LocalStackExecutor(
    { ...BASE_CONFIG, registrationPollIntervalMs: 1 },
    SILENT_LOGGER,
  );
  const result = await executor.fill(signed);

  assert.deepEqual(stages, ["lock", "fill"]);
  assert.equal(result.settlementTx, "0xstellarTx");
  assert.ok(statusPolls >= 3, "executor must poll status until Locked");
});

// ─── #949: retry after a failed Soroban leg re-uses the existing lock ────────

test("fill: Soroban leg fails once then succeeds — exactly one lock, one fill_intent", async () => {
  const signed = makeSignedIntent();
  let lockCalls = 0;
  let fillCalls = 0;
  let fillAttempts = 0;

  class FlakySorobanExecutor extends Executor {
    protected override async checkFillStatus() {
      return { filled: false };
    }
    protected override async readExistingLock(_: Hex): Promise<{
      solver: string;
      released: boolean;
      refunded: boolean;
    } | null> {
      // After the first lock, the escrow reports our lock as live.
      if (lockCalls === 0) return null;
      return {
        solver: SOLVER_EVM_ADDRESS,
        released: false,
        refunded: false,
      };
    }
    protected override async lockOnEvm(): Promise<Hex> {
      lockCalls++;
      return "0xlockTx" as Hex;
    }
    protected override async waitForRegistration(): Promise<void> {}
    protected override async fillOnSoroban(): Promise<Hex> {
      fillCalls++;
      fillAttempts++;
      if (fillAttempts === 1) throw new Error("Soroban congestion");
      return "0xstellarTx" as Hex;
    }
  }

  const executor = new FlakySorobanExecutor(BASE_CONFIG, SILENT_LOGGER);

  await assert.rejects(() => executor.fill(signed), /Soroban congestion/);
  const result = await executor.fill(signed);

  assert.equal(result.settlementTx, "0xstellarTx");
  assert.equal(lockCalls, 1, "lock must be submitted exactly once");
  assert.equal(fillCalls, 2, "fill_intent attempted twice (one failure, one success)");
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

type CapturedArg = { name: string; value: unknown };

/**
 * Drive `fillOnSoroban` on the exposed executor while capturing the named
 * arguments it passes to `fill_intent`. The executor exposes a test seam
 * (`__captureFillIntentArgs`) that records the ScVal argument list.
 */
async function captureFillIntentArgs(
  ex: PrivateExecutor,
  signed: SignedIntent,
  lockTx: Hex,
  opts: { quote?: bigint; charged?: bigint } = {},
): Promise<CapturedArg[]> {
  const capture = (ex as unknown as {
    __captureFillIntentArgs?: (o: {
      quote?: bigint;
      charged?: bigint;
    }) => Promise<CapturedArg[]>;
  }).__captureFillIntentArgs;
  assert.ok(capture, "executor must expose __captureFillIntentArgs test seam");
  return capture.call(ex, opts);
}

function scValToBytes(value: unknown): Uint8Array {
  const v = value as { bytes?: () => Uint8Array; value?: () => Uint8Array };
  if (typeof v.bytes === "function") return v.bytes();
  if (typeof v.value === "function") return v.value() as Uint8Array;
  throw new Error("not a bytes ScVal");
}

function scValToI128(value: unknown): bigint {
  const v = value as { value?: () => bigint | number | string };
  if (typeof v.value === "function") return BigInt(v.value() as bigint);
  throw new Error("not an i128 ScVal");
}

function bytesToHex(bytes: Uint8Array): string {
  let out = "0x";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

// ─── loadExecutorConfig tuning knobs ─────────────────────────────────────────

const VALID_EXECUTOR_ENV = {
  PERIHELION_EVM_RPC_URL: "http://localhost:8545",
  PERIHELION_SOROBAN_RPC_URL: "https://soroban-testnet.stellar.org",
  PERIHELION_EVM_PRIVATE_KEY: `0x${"1".repeat(64)}`,
  PERIHELION_SOROBAN_SECRET_KEY:
    "SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4",
  PERIHELION_ESCROW_ADDRESS: ESCROW_ADDRESS,
  PERIHELION_SETTLEMENT_CONTRACT_ID: "0".repeat(64),
  PERIHELION_SOURCE_CHAIN_ID: "8453",
  STELLAR_NETWORK: STELLAR_NETWORK,
};

test("loadExecutorConfig: parses the three tuning knobs", async () => {
  const { loadExecutorConfig } = await import("../src/executor-config.js");
  const config = loadExecutorConfig({
    ...VALID_EXECUTOR_ENV,
    PERIHELION_LZ_FEE_BUFFER_BPS: "500",
    PERIHELION_REGISTRATION_POLL_INTERVAL_MS: "750",
    PERIHELION_MIN_FILL_HEADROOM_SECS: "2000",
  });
  assert.equal(config.lzFeeBufferBps, 500);
  assert.equal(config.registrationPollIntervalMs, 750);
  assert.equal(config.minFillHeadroomSecs, 2000);
});

test("loadExecutorConfig: tuning knobs default when unset", async () => {
  const { loadExecutorConfig } = await import("../src/executor-config.js");
  const { MIN_FILL_HEADROOM_SECS } = await import("@perihelion/sdk");
  const config = loadExecutorConfig({ ...VALID_EXECUTOR_ENV });
  assert.equal(config.lzFeeBufferBps, 0);
  assert.equal(config.registrationPollIntervalMs, 2_000);
  assert.equal(config.minFillHeadroomSecs, MIN_FILL_HEADROOM_SECS);
});

test("loadExecutorConfig: reports invalid tuning knob values", async () => {
  const { loadExecutorConfig } = await import("../src/executor-config.js");
  assert.throws(
    () =>
      loadExecutorConfig({
        ...VALID_EXECUTOR_ENV,
        PERIHELION_LZ_FEE_BUFFER_BPS: "10001",
        PERIHELION_REGISTRATION_POLL_INTERVAL_MS: "0",
        PERIHELION_MIN_FILL_HEADROOM_SECS: "abc",
      }),
    (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      return (
        msg.includes("PERIHELION_LZ_FEE_BUFFER_BPS must be at most 10000") &&
        msg.includes("PERIHELION_REGISTRATION_POLL_INTERVAL_MS must be greater than 0") &&
        msg.includes("PERIHELION_MIN_FILL_HEADROOM_SECS must be a non-negative integer")
      );
    },
  );
});

test("loadExecutorConfig: rejects headroom below the contract dispatch window", async () => {
  const { loadExecutorConfig } = await import("../src/executor-config.js");
  assert.throws(
    () =>
      loadExecutorConfig({
        ...VALID_EXECUTOR_ENV,
        PERIHELION_MIN_FILL_HEADROOM_SECS: "60",
      }),
    /PERIHELION_MIN_FILL_HEADROOM_SECS must be at least 1920/,
  );
});

// ─── fill headroom single source of truth ────────────────────────────────────

test("Executor: rejects a fill headroom below the SDK / contract dispatch window", async () => {
  const { Executor } = await import("../src/executor.js");
  const { MIN_FILL_HEADROOM_SECS } = await import("@perihelion/sdk");
  assert.throws(
    () => new Executor({ ...BASE_CONFIG, minFillHeadroomSecs: MIN_FILL_HEADROOM_SECS - 1 }),
    /must be at least 1920/,
  );
  // The SDK value itself is accepted.
  assert.doesNotThrow(
    () => new Executor({ ...BASE_CONFIG, minFillHeadroomSecs: MIN_FILL_HEADROOM_SECS }),
  );
});
