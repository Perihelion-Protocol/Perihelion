/**
 * End-to-end refund path tests: covering cancellation scenarios where the user
 * gets their funds back from the escrow.
 *
 * These tests drive the cancel/refund lifecycle:
 * 1. Cancel from Stellar (deadline expires on dest chain)
 * 2. Local timeout on EVM (user calls cancelExpired)
 * 3. Race condition: local timeout wins, late FillConfirmed rejected
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildIntent, hashIntent, perihelionDomain, type Intent } from "@perihelion/sdk";
import type { Hex } from "viem";
import {
  MockLayerZeroEndpoint,
  MockERC20,
  MockEscrow,
  MockStellarAsset,
  MockSettlement,
} from "./mocks.js";

// Test configuration
const EVM_EID = 30101;
const STELLAR_EID = 30316;
const ESCROW_ADDRESS = "0x1111111111111111111111111111111111111111";

const USER_ADDRESS = "0x2222222222222222222222222222222222222222";
const SOLVER_ADDRESS = "0x3333333333333333333333333333333333333333";
const SOLVER_STELLAR = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const RECIPIENT_STELLAR = "GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";

test("refund path: cancel from Stellar after deadline", async () => {
  // --- Setup ----------------------------------------------------------------
  const lz = new MockLayerZeroEndpoint();
  const sourceToken = new MockERC20(6);
  const destAsset = new MockStellarAsset("USDC", "GA5Z");

  const escrow = new MockEscrow(sourceToken, lz, ESCROW_ADDRESS, EVM_EID, STELLAR_EID);
  const settlement = new MockSettlement(destAsset, lz, STELLAR_EID, EVM_EID);

  sourceToken.mint(USER_ADDRESS, 1_000_000n);
  destAsset.mint(SOLVER_STELLAR, 10_000_000n);

  // --- Intent with near deadline --------------------------------------------
  const now = Math.floor(Date.now() / 1000);
  const intent: Intent = buildIntent({
    user: USER_ADDRESS,
    destination: RECIPIENT_STELLAR,
    sourceChainId: 8453,
    sourceAsset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    sourceAmount: "1000000",
    destAsset: "USDC:GA5Z",
    minDestAmount: "9900000",
    deadline: now + 100, // deadline in 100 seconds
    nonce: "99999",
  });

  const domain = perihelionDomain(8453, ESCROW_ADDRESS);
  const intentHash = hashIntent(intent, domain) as Hex;

  // --- Lock and register ----------------------------------------------------
  escrow.lock(intent, intentHash, SOLVER_ADDRESS);
  settlement.lzReceive(intentHash, RECIPIENT_STELLAR, 9_900_000n, intent.deadline);

  assert.equal(sourceToken.balanceOf(ESCROW_ADDRESS), 1_000_000n);
  assert.equal(sourceToken.balanceOf(USER_ADDRESS), 0n);

  console.log("✓ Intent locked on EVM and registered on Stellar");

  // --- Time passes, deadline expires on Stellar -----------------------------
  const afterDeadline = intent.deadline + 1;

  // Stellar detects expiry and cancels
  settlement.cancelExpiredIntent(intentHash, afterDeadline);
  assert.equal(settlement.isCancelled(intentHash), true);

  // Assert: CancelIntent emitted to EVM
  const cancelMessages = lz.getMessagesTo(EVM_EID);
  assert.equal(cancelMessages.length, 1);
  assert.equal(cancelMessages[0].srcEid, STELLAR_EID);

  console.log("✓ Stellar cancelled expired intent and emitted CancelIntent");

  // --- Relayer delivers CancelIntent to EVM ---------------------------------
  const userBalanceBefore = sourceToken.balanceOf(USER_ADDRESS);
  escrow.lzReceiveCancel(intentHash);

  // Assert: funds refunded to user
  assert.equal(sourceToken.balanceOf(USER_ADDRESS), userBalanceBefore + 1_000_000n);
  assert.equal(sourceToken.balanceOf(ESCROW_ADDRESS), 0n);
  assert.equal(escrow.isRefunded(intentHash), true);
  assert.equal(escrow.isReleased(intentHash), false);

  console.log("✓ CancelIntent relayed, user refunded");
  console.log(`  User balance: ${sourceToken.balanceOf(USER_ADDRESS)}`);

  console.log("\n✅ Refund path complete: cancel from Stellar");
});

test("refund path: local timeout on EVM", async () => {
  // --- Setup ----------------------------------------------------------------
  const lz = new MockLayerZeroEndpoint();
  const sourceToken = new MockERC20(6);
  const destAsset = new MockStellarAsset("USDC", "GA5Z");

  const escrow = new MockEscrow(sourceToken, lz, ESCROW_ADDRESS, EVM_EID, STELLAR_EID);
  const settlement = new MockSettlement(destAsset, lz, STELLAR_EID, EVM_EID);

  sourceToken.mint(USER_ADDRESS, 1_000_000n);

  // --- Intent ---------------------------------------------------------------
  const now = Math.floor(Date.now() / 1000);
  const intent: Intent = buildIntent({
    user: USER_ADDRESS,
    destination: RECIPIENT_STELLAR,
    sourceChainId: 8453,
    sourceAsset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    sourceAmount: "1000000",
    destAsset: "USDC:GA5Z",
    minDestAmount: "9900000",
    deadline: now + 100,
    nonce: "88888",
  });

  const domain = perihelionDomain(8453, ESCROW_ADDRESS);
  const intentHash = hashIntent(intent, domain) as Hex;

  // --- Lock -----------------------------------------------------------------
  escrow.lock(intent, intentHash, SOLVER_ADDRESS);
  assert.equal(sourceToken.balanceOf(ESCROW_ADDRESS), 1_000_000n);

  console.log("✓ Intent locked on EVM escrow");

  // --- Time passes: deadline + grace period (300s) --------------------------
  const afterGrace = intent.deadline + 300 + 1; // past confirmation grace

  // User calls cancelExpired on EVM
  escrow.cancelExpired(intentHash, afterGrace);

  // Assert: funds refunded to user
  assert.equal(sourceToken.balanceOf(USER_ADDRESS), 1_000_000n);
  assert.equal(sourceToken.balanceOf(ESCROW_ADDRESS), 0n);
  assert.equal(escrow.isRefunded(intentHash), true);

  console.log("✓ Local timeout triggered, user refunded");
  console.log(`  User balance: ${sourceToken.balanceOf(USER_ADDRESS)}`);

  console.log("\n✅ Refund path complete: local timeout on EVM");
});

test("refund path: race — local timeout wins, late FillConfirmed rejected", async () => {
  // --- Setup ----------------------------------------------------------------
  const lz = new MockLayerZeroEndpoint();
  const sourceToken = new MockERC20(6);
  const destAsset = new MockStellarAsset("USDC", "GA5Z");

  const escrow = new MockEscrow(sourceToken, lz, ESCROW_ADDRESS, EVM_EID, STELLAR_EID);
  const settlement = new MockSettlement(destAsset, lz, STELLAR_EID, EVM_EID);

  sourceToken.mint(USER_ADDRESS, 1_000_000n);
  destAsset.mint(SOLVER_STELLAR, 10_000_000n);

  // --- Intent ---------------------------------------------------------------
  const now = Math.floor(Date.now() / 1000);
  const intent: Intent = buildIntent({
    user: USER_ADDRESS,
    destination: RECIPIENT_STELLAR,
    sourceChainId: 8453,
    sourceAsset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    sourceAmount: "1000000",
    destAsset: "USDC:GA5Z",
    minDestAmount: "9900000",
    deadline: now + 100,
    nonce: "77777",
  });

  const domain = perihelionDomain(8453, ESCROW_ADDRESS);
  const intentHash = hashIntent(intent, domain) as Hex;

  // --- Lock and register ----------------------------------------------------
  escrow.lock(intent, intentHash, SOLVER_ADDRESS);
  settlement.lzReceive(intentHash, RECIPIENT_STELLAR, 9_900_000n, intent.deadline);

  console.log("✓ Intent locked and registered");

  // --- Solver fills on Stellar (but relay is delayed) ----------------------
  const solverEvmBytes = SOLVER_ADDRESS.padEnd(66, "0") as Hex;
  settlement.fillIntent(
    intentHash,
    SOLVER_STELLAR,
    solverEvmBytes,
    10_000_000n,
    intent.deadline - 10, // filled just before deadline
  );

  assert.equal(settlement.isSettled(intentHash), true);
  assert.equal(destAsset.balanceOf(RECIPIENT_STELLAR), 10_000_000n);

  console.log("✓ Solver filled on Stellar, FillConfirmed emitted");

  // --- But EVM timeout happens first (FillConfirmed relay delayed) ----------
  const afterGrace = intent.deadline + 300 + 1;
  escrow.cancelExpired(intentHash, afterGrace);

  assert.equal(escrow.isRefunded(intentHash), true);
  assert.equal(sourceToken.balanceOf(USER_ADDRESS), 1_000_000n);

  console.log("✓ Local timeout triggered first, user refunded");

  // --- Late FillConfirmed arrives, must be rejected -------------------------
  assert.throws(
    () => {
      escrow.lzReceive(intentHash, SOLVER_ADDRESS, 1_000_000n);
    },
    /AlreadyFinalized/,
    "Late FillConfirmed must be rejected",
  );

  // Assert: state unchanged after rejected FillConfirmed
  assert.equal(escrow.isRefunded(intentHash), true);
  assert.equal(escrow.isReleased(intentHash), false);
  assert.equal(sourceToken.balanceOf(USER_ADDRESS), 1_000_000n); // still refunded
  assert.equal(sourceToken.balanceOf(SOLVER_ADDRESS), 0n); // solver got nothing on EVM

  console.log("✓ Late FillConfirmed rejected (AlreadyFinalized)");

  console.log("\n✅ Race condition handled correctly");
  console.log("   • User got refunded (local timeout)");
  console.log("   • Solver filled on Stellar but got no EVM payout");
  console.log("   • Single terminal transition enforced");
  console.log("\n⚠️  Note: In production, solver should monitor EVM state");
  console.log("   before filling to avoid this loss scenario");
});

test("refund path: cannot cancel before deadline", async () => {
  // --- Setup ----------------------------------------------------------------
  const lz = new MockLayerZeroEndpoint();
  const sourceToken = new MockERC20(6);
  const destAsset = new MockStellarAsset("USDC", "GA5Z");

  const escrow = new MockEscrow(sourceToken, lz, ESCROW_ADDRESS, EVM_EID, STELLAR_EID);
  const settlement = new MockSettlement(destAsset, lz, STELLAR_EID, EVM_EID);

  sourceToken.mint(USER_ADDRESS, 1_000_000n);

  // --- Intent ---------------------------------------------------------------
  const now = Math.floor(Date.now() / 1000);
  const intent: Intent = buildIntent({
    user: USER_ADDRESS,
    destination: RECIPIENT_STELLAR,
    sourceChainId: 8453,
    sourceAsset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    sourceAmount: "1000000",
    destAsset: "USDC:GA5Z",
    minDestAmount: "9900000",
    deadline: now + 3600, // 1 hour from now
    nonce: "66666",
  });

  const domain = perihelionDomain(8453, ESCROW_ADDRESS);
  const intentHash = hashIntent(intent, domain) as Hex;

  // --- Lock -----------------------------------------------------------------
  escrow.lock(intent, intentHash, SOLVER_ADDRESS);
  settlement.lzReceive(intentHash, RECIPIENT_STELLAR, 9_900_000n, intent.deadline);

  // --- Try to cancel before deadline (EVM) ----------------------------------
  assert.throws(
    () => {
      escrow.cancelExpired(intentHash, now + 100); // way before deadline + grace
    },
    /DeadlineNotPassed/,
    "Cannot cancel before deadline + grace on EVM",
  );

  // --- Try to cancel before deadline (Stellar) ------------------------------
  assert.throws(
    () => {
      settlement.cancelExpiredIntent(intentHash, now + 100);
    },
    /DeadlineNotPassed/,
    "Cannot cancel before deadline on Stellar",
  );

  // Assert: intent still locked, not finalized
  assert.equal(escrow.isRefunded(intentHash), false);
  assert.equal(escrow.isReleased(intentHash), false);
  assert.equal(settlement.isCancelled(intentHash), false);
  assert.equal(settlement.isSettled(intentHash), false);

  console.log("\n✅ Cancellation guards enforced");
  console.log("   • Cannot cancel before deadline on either chain");
  console.log("   • Intent remains locked and unfilled");
});

test("refund path: value conserved across refund", async () => {
  // --- Setup ----------------------------------------------------------------
  const lz = new MockLayerZeroEndpoint();
  const sourceToken = new MockERC20(6);
  const destAsset = new MockStellarAsset("USDC", "GA5Z");

  const escrow = new MockEscrow(sourceToken, lz, ESCROW_ADDRESS, EVM_EID, STELLAR_EID);
  const settlement = new MockSettlement(destAsset, lz, STELLAR_EID, EVM_EID);

  const INITIAL_USER_BALANCE = 5_000_000n; // 5 USDC
  sourceToken.mint(USER_ADDRESS, INITIAL_USER_BALANCE);

  // --- Create and lock intent -----------------------------------------------
  const now = Math.floor(Date.now() / 1000);
  const intent: Intent = buildIntent({
    user: USER_ADDRESS,
    destination: RECIPIENT_STELLAR,
    sourceChainId: 8453,
    sourceAsset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    sourceAmount: "1000000",
    destAsset: "USDC:GA5Z",
    minDestAmount: "9900000",
    deadline: now + 100,
    nonce: "55555",
  });

  const domain = perihelionDomain(8453, ESCROW_ADDRESS);
  const intentHash = hashIntent(intent, domain) as Hex;

  escrow.lock(intent, intentHash, SOLVER_ADDRESS);

  // User now has 4 USDC, escrow has 1 USDC
  assert.equal(sourceToken.balanceOf(USER_ADDRESS), 4_000_000n);
  assert.equal(sourceToken.balanceOf(ESCROW_ADDRESS), 1_000_000n);

  // --- Cancel and refund ----------------------------------------------------
  const afterDeadline = intent.deadline + 300 + 1;
  escrow.cancelExpired(intentHash, afterDeadline);

  // User should get back exactly what they locked
  assert.equal(sourceToken.balanceOf(USER_ADDRESS), INITIAL_USER_BALANCE);
  assert.equal(sourceToken.balanceOf(ESCROW_ADDRESS), 0n);

  console.log("\n✅ Value conservation verified");
  console.log(`   • Initial balance: ${INITIAL_USER_BALANCE}`);
  console.log(`   • After lock: ${4_000_000n}`);
  console.log(`   • After refund: ${INITIAL_USER_BALANCE}`);
  console.log("   • No value lost or created");
});
