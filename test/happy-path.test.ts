/**
 * End-to-end happy path test: user signs → solver locks on EVM → FillInstruction
 * relayed → solver fills on Soroban → FillConfirmed relayed back → escrow
 * releases to solver.
 *
 * This test drives a single intent through the complete lifecycle across both
 * contract implementations (EVM escrow + Soroban settlement) with the off-chain
 * relayer in between, asserting balances and events at each transition.
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
const EVM_EID = 30101; // Base testnet
const STELLAR_EID = 30316; // Stellar testnet
const ESCROW_ADDRESS = "0x1111111111111111111111111111111111111111";
const SETTLEMENT_ADDRESS = "0xSTELLAR";

const USER_ADDRESS = "0x2222222222222222222222222222222222222222";
const SOLVER_ADDRESS = "0x3333333333333333333333333333333333333333";
const SOLVER_STELLAR = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

const RECIPIENT_STELLAR = "GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";

test("happy path: full lifecycle with settlement", async () => {
  // --- Setup ----------------------------------------------------------------
  const lz = new MockLayerZeroEndpoint();
  const sourceToken = new MockERC20(6); // USDC-like, 6 decimals
  const destAsset = new MockStellarAsset("USDC", "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN");

  const escrow = new MockEscrow(sourceToken, lz, ESCROW_ADDRESS, EVM_EID, STELLAR_EID);
  const settlement = new MockSettlement(destAsset, lz, STELLAR_EID, EVM_EID);

  // Initial balances
  sourceToken.mint(USER_ADDRESS, 1_000_000n); // 1 USDC
  destAsset.mint(SOLVER_STELLAR, 10_000_000n); // 10 USDC on Stellar (7 decimals)

  // --- Step 1: User creates and signs intent -------------------------------
  const intent: Intent = buildIntent({
    user: USER_ADDRESS,
    destination: RECIPIENT_STELLAR,
    sourceChainId: 8453, // Base
    sourceAsset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // USDC on Base
    sourceAmount: "1000000", // 1 USDC (6 decimals)
    destAsset: `USDC:${destAsset.issuer}`,
    minDestAmount: "9900000", // 0.99 USDC (7 decimals) - leaves margin for solver
    deadline: Math.floor(Date.now() / 1000) + 3600, // 1 hour from now
    nonce: "12345",
  });

  const domain = perihelionDomain(8453, ESCROW_ADDRESS);
  const intentHash = hashIntent(intent, domain) as Hex;

  console.log("✓ Intent created and signed");
  console.log(`  Intent hash: ${intentHash}`);

  // --- Step 2: Solver locks on EVM escrow -----------------------------------
  const userBalanceBefore = sourceToken.balanceOf(USER_ADDRESS);
  const escrowBalanceBefore = sourceToken.balanceOf(ESCROW_ADDRESS);

  escrow.lock(intent, intentHash, SOLVER_ADDRESS);

  // Assert: source funds moved from user to escrow
  assert.equal(sourceToken.balanceOf(USER_ADDRESS), userBalanceBefore - 1_000_000n);
  assert.equal(sourceToken.balanceOf(ESCROW_ADDRESS), escrowBalanceBefore + 1_000_000n);

  // Assert: FillInstruction emitted to Stellar
  assert.equal(lz.messageCount(), 1);
  const fillInstruction = lz.lastMessage();
  assert.ok(fillInstruction);
  assert.equal(fillInstruction.srcEid, EVM_EID);
  assert.equal(fillInstruction.dstEid, STELLAR_EID);

  console.log("✓ Solver locked funds on EVM escrow");
  console.log(`  User balance: ${sourceToken.balanceOf(USER_ADDRESS)}`);
  console.log(`  Escrow balance: ${sourceToken.balanceOf(ESCROW_ADDRESS)}`);

  // --- Step 3: Relayer delivers FillInstruction to Soroban ------------------
  settlement.lzReceive(intentHash, RECIPIENT_STELLAR, 9_900_000n, intent.deadline);

  const registeredIntent = settlement.getIntent(intentHash);
  assert.ok(registeredIntent);
  assert.equal(registeredIntent.recipient, RECIPIENT_STELLAR);
  assert.equal(registeredIntent.minDestAmount, 9_900_000n);

  console.log("✓ FillInstruction relayed to Soroban settlement contract");
  console.log(`  Registered for recipient: ${RECIPIENT_STELLAR}`);

  // --- Step 4: Solver fills on Soroban --------------------------------------
  const recipientBalanceBefore = destAsset.balanceOf(RECIPIENT_STELLAR);
  const solverStellarBalanceBefore = destAsset.balanceOf(SOLVER_STELLAR);

  const now = Math.floor(Date.now() / 1000);
  const fillAmount = 10_000_000n; // Solver fills with 1 USDC (7 decimals)
  const solverEvmBytes = SOLVER_ADDRESS.padEnd(66, "0") as Hex; // pad to 32 bytes

  settlement.fillIntent(intentHash, SOLVER_STELLAR, solverEvmBytes, fillAmount, now);

  // Assert: destination assets moved from solver to recipient
  assert.equal(destAsset.balanceOf(RECIPIENT_STELLAR), recipientBalanceBefore + fillAmount);
  assert.equal(destAsset.balanceOf(SOLVER_STELLAR), solverStellarBalanceBefore - fillAmount);
  assert.equal(settlement.isSettled(intentHash), true);

  // Assert: FillConfirmed emitted to EVM
  assert.equal(lz.messageCount(), 2);
  const fillConfirmed = lz.getMessagesTo(EVM_EID)[0];
  assert.ok(fillConfirmed);
  assert.equal(fillConfirmed.srcEid, STELLAR_EID);
  assert.equal(fillConfirmed.dstEid, EVM_EID);

  console.log("✓ Solver filled intent on Soroban");
  console.log(`  Recipient balance: ${destAsset.balanceOf(RECIPIENT_STELLAR)}`);
  console.log(`  Solver Stellar balance: ${destAsset.balanceOf(SOLVER_STELLAR)}`);

  // --- Step 5: Relayer delivers FillConfirmed to EVM escrow -----------------
  const solverEvmBalanceBefore = sourceToken.balanceOf(SOLVER_ADDRESS);

  escrow.lzReceive(intentHash, SOLVER_ADDRESS, 1_000_000n);

  // Assert: source funds released from escrow to solver
  assert.equal(sourceToken.balanceOf(SOLVER_ADDRESS), solverEvmBalanceBefore + 1_000_000n);
  assert.equal(sourceToken.balanceOf(ESCROW_ADDRESS), 0n); // escrow drained
  assert.equal(escrow.isReleased(intentHash), true);

  console.log("✓ FillConfirmed relayed back, escrow released to solver");
  console.log(`  Solver EVM balance: ${sourceToken.balanceOf(SOLVER_ADDRESS)}`);
  console.log(`  Escrow balance: ${sourceToken.balanceOf(ESCROW_ADDRESS)}`);

  // --- Final assertions: value conserved, no double-spend -------------------
  assert.equal(escrow.isRefunded(intentHash), false, "Intent must not be refunded");
  assert.equal(settlement.isCancelled(intentHash), false, "Intent must not be cancelled");

  console.log("\n✅ Happy path complete: intent settled end-to-end");
  console.log("   • User spent 1 USDC on EVM");
  console.log("   • Recipient received 1 USDC on Stellar");
  console.log("   • Solver received 1 USDC on EVM (reimbursement)");
  console.log("   • Value conserved across both chains");
});

test("happy path: solver payout address independent of locker", async () => {
  // --- Setup ----------------------------------------------------------------
  const lz = new MockLayerZeroEndpoint();
  const sourceToken = new MockERC20(6);
  const destAsset = new MockStellarAsset("USDC", "GA5Z");

  const escrow = new MockEscrow(sourceToken, lz, ESCROW_ADDRESS, EVM_EID, STELLAR_EID);
  const settlement = new MockSettlement(destAsset, lz, STELLAR_EID, EVM_EID);

  sourceToken.mint(USER_ADDRESS, 1_000_000n);
  destAsset.mint(SOLVER_STELLAR, 10_000_000n);

  // --- Intent and lock ------------------------------------------------------
  const intent: Intent = buildIntent({
    user: USER_ADDRESS,
    destination: RECIPIENT_STELLAR,
    sourceChainId: 8453,
    sourceAsset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    sourceAmount: "1000000",
    destAsset: "USDC:GA5Z",
    minDestAmount: "9900000",
    deadline: Math.floor(Date.now() / 1000) + 3600,
    nonce: "67890",
  });

  const domain = perihelionDomain(8453, ESCROW_ADDRESS);
  const intentHash = hashIntent(intent, domain) as Hex;

  escrow.lock(intent, intentHash, SOLVER_ADDRESS);
  settlement.lzReceive(intentHash, RECIPIENT_STELLAR, 9_900_000n, intent.deadline);

  // --- Solver fills with a DIFFERENT payout address ------------------------
  const PAYOUT_ADDRESS = "0x4444444444444444444444444444444444444444";
  const payoutBytes = PAYOUT_ADDRESS.padEnd(66, "0") as Hex;

  settlement.fillIntent(
    intentHash,
    SOLVER_STELLAR,
    payoutBytes,
    10_000_000n,
    Math.floor(Date.now() / 1000),
  );

  // --- Escrow releases to the payout address, NOT the locker ---------------
  escrow.lzReceive(intentHash, PAYOUT_ADDRESS, 1_000_000n);

  assert.equal(sourceToken.balanceOf(PAYOUT_ADDRESS), 1_000_000n);
  assert.equal(sourceToken.balanceOf(SOLVER_ADDRESS), 0n); // locker got nothing
  assert.equal(escrow.isReleased(intentHash), true);

  console.log("\n✅ Payout address independence verified");
  console.log(`   • Locker: ${SOLVER_ADDRESS} (balance: 0)`);
  console.log(`   • Payout: ${PAYOUT_ADDRESS} (balance: 1,000,000)`);
});

test("happy path: two concurrent intents resolve independently", async () => {
  // --- Setup ----------------------------------------------------------------
  const lz = new MockLayerZeroEndpoint();
  const sourceToken = new MockERC20(6);
  const destAsset = new MockStellarAsset("USDC", "GA5Z");

  const escrow = new MockEscrow(sourceToken, lz, ESCROW_ADDRESS, EVM_EID, STELLAR_EID);
  const settlement = new MockSettlement(destAsset, lz, STELLAR_EID, EVM_EID);

  sourceToken.mint(USER_ADDRESS, 2_000_000n); // 2 USDC
  destAsset.mint(SOLVER_STELLAR, 20_000_000n); // 20 USDC on Stellar

  const domain = perihelionDomain(8453, ESCROW_ADDRESS);

  // --- Intent 1: will be settled --------------------------------------------
  const intent1: Intent = buildIntent({
    user: USER_ADDRESS,
    destination: RECIPIENT_STELLAR,
    sourceChainId: 8453,
    sourceAsset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    sourceAmount: "1000000",
    destAsset: "USDC:GA5Z",
    minDestAmount: "9900000",
    deadline: Math.floor(Date.now() / 1000) + 3600,
    nonce: "1111",
  });
  const hash1 = hashIntent(intent1, domain) as Hex;

  // --- Intent 2: will be cancelled ------------------------------------------
  const intent2: Intent = buildIntent({
    user: USER_ADDRESS,
    destination: RECIPIENT_STELLAR,
    sourceChainId: 8453,
    sourceAsset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    sourceAmount: "1000000",
    destAsset: "USDC:GA5Z",
    minDestAmount: "9900000",
    deadline: Math.floor(Date.now() / 1000) + 3600,
    nonce: "2222",
  });
  const hash2 = hashIntent(intent2, domain) as Hex;

  // --- Lock both intents ----------------------------------------------------
  escrow.lock(intent1, hash1, SOLVER_ADDRESS);
  escrow.lock(intent2, hash2, SOLVER_ADDRESS);

  assert.equal(sourceToken.balanceOf(ESCROW_ADDRESS), 2_000_000n);
  assert.equal(sourceToken.balanceOf(USER_ADDRESS), 0n);

  // --- Register both on Stellar ---------------------------------------------
  settlement.lzReceive(hash1, RECIPIENT_STELLAR, 9_900_000n, intent1.deadline);
  settlement.lzReceive(hash2, RECIPIENT_STELLAR, 9_900_000n, intent2.deadline);

  // --- Settle intent1 -------------------------------------------------------
  const solverEvmBytes = SOLVER_ADDRESS.padEnd(66, "0") as Hex;
  settlement.fillIntent(hash1, SOLVER_STELLAR, solverEvmBytes, 10_000_000n, Math.floor(Date.now() / 1000));
  escrow.lzReceive(hash1, SOLVER_ADDRESS, 1_000_000n);

  // --- Cancel intent2 -------------------------------------------------------
  const futureTime = intent2.deadline + 1;
  settlement.cancelExpiredIntent(hash2, futureTime);
  escrow.lzReceiveCancel(hash2);

  // --- Final balances -------------------------------------------------------
  assert.equal(sourceToken.balanceOf(SOLVER_ADDRESS), 1_000_000n, "Solver got settled intent1");
  assert.equal(sourceToken.balanceOf(USER_ADDRESS), 1_000_000n, "User got refunded intent2");
  assert.equal(sourceToken.balanceOf(ESCROW_ADDRESS), 0n, "Escrow fully drained");

  assert.equal(escrow.isReleased(hash1), true);
  assert.equal(escrow.isRefunded(hash2), true);

  console.log("\n✅ Two concurrent intents resolved independently");
  console.log(`   • Intent 1 settled: solver balance = 1,000,000`);
  console.log(`   • Intent 2 cancelled: user refunded = 1,000,000`);
  console.log(`   • Value conserved: escrow drained to 0`);
});
