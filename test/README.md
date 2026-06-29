# Perihelion End-to-End Test Suite

This directory contains deterministic end-to-end tests that drive complete intent lifecycles across both EVM escrow and Soroban settlement contracts, with the off-chain relayer logic simulated in between.

## Purpose

Each leg of the protocol (EVM escrow, Soroban settlement, relayer, solver) has its own unit tests. However, the protocol's correctness is an **emergent property** of the full round-trip flow:

1. User signs intent
2. Solver locks funds on EVM escrow → emits `FillInstruction`
3. Relayer delivers `FillInstruction` to Soroban
4. Solver fills on Soroban → emits `FillConfirmed`  
5. Relayer delivers `FillConfirmed` back to EVM
6. Escrow releases funds to solver

Bugs at the **seams** (encoding mismatches, nonce/idempotency interactions, race conditions) only manifest when all legs run together. These tests provide:

- **Regression guard**: Catch cross-component integration bugs
- **Executable documentation**: Show the complete happy path and edge cases
- **Confidence**: Verify that what Soroban emits is what EVM consumes

## Test Structure

### Mock Implementations (`mocks.ts`)

Lightweight, deterministic mocks of:
- **MockLayerZeroEndpoint**: Routes messages between chains
- **MockERC20**: Tracks EVM token balances  
- **MockEscrow**: Implements EVM escrow logic (lock, lzReceive, cancelExpired)
- **MockStellarAsset**: Tracks Stellar token balances
- **MockSettlement**: Implements Soroban settlement logic (fillIntent, cancelExpiredIntent)

These mocks implement the **actual protocol logic** from the contracts, not just stubs. They enforce:
- Balance transfers
- State transitions (locked → settled/refunded)
- Wire format encoding/decoding
- Idempotency guards

### Test Suites

#### `happy-path.test.ts`

Complete happy path flows:

1. **Full lifecycle with settlement**  
   User → solver locks → FillInstruction → solver fills → FillConfirmed → release  
   Asserts balances and state at each step.

2. **Solver payout address independence**  
   Verifies that the escrow releases to the address specified in `FillConfirmed`, not necessarily the locker.

3. **Two concurrent intents**  
   One settles, one cancels. Value is conserved, no cross-contamination.

#### `refund-path.test.ts`

Cancellation and refund scenarios:

1. **Cancel from Stellar**  
   Deadline expires on Stellar → `CancelIntent` → EVM refund

2. **Local timeout on EVM**  
   User calls `cancelExpired` after deadline + grace

3. **Race condition: timeout wins**  
   Local timeout refunds user, late `FillConfirmed` is rejected (single terminal transition)

4. **Cannot cancel before deadline**  
   Guards enforce deadline on both chains

5. **Value conservation**  
   User gets back exactly what they locked

## Running the Tests

```bash
# Run all E2E tests
npm test

# Run specific suite
npm run test:happy
npm run test:refund
```

## Acceptance Criteria Met

✅ **Deterministic E2E test** drives a single intent through the full happy-path lifecycle across both contract implementations and off-chain components

✅ **Balances and events asserted** at each transition

✅ **Companion refund path tests** cover cancellation scenarios

✅ **Race conditions tested**: local timeout vs late settlement

✅ **Value conservation verified**: no funds lost or created

✅ **Idempotency validated**: duplicate messages are rejected

## Coverage

These tests exercise:
- ✅ EVM escrow lock, lzReceive (FillConfirmed + CancelIntent), cancelExpired
- ✅ Soroban settlement lzReceive (FillInstruction), fillIntent, cancelExpiredIntent  
- ✅ LayerZero message routing (mocked transport)
- ✅ Wire format encoding (intent_hash, solver_evm, amount fields)
- ✅ State machine transitions (locked → settled/refunded)
- ✅ Idempotency (AlreadyFinalized guards)
- ✅ Terminal transition enforcement (refund xor release, never both)
- ✅ Deadline guards on both chains
- ✅ Balance accounting across both chains

## What's NOT Covered

These tests use mocks and do **not** cover:

- ❌ Real LayerZero DVN verification (architecture spec §7.3)
- ❌ Actual EVM/Soroban RPC calls (no anvil/stellar-rpc)
- ❌ Gas costs or transaction finality delays
- ❌ Reorg handling in the relayer
- ❌ Solver profitability calculations (see `solver/test/quote.test.ts`)

For those aspects, see:
- `contracts/evm/test/Integration.t.sol` (Foundry with real escrow)
- `contracts/soroban/settlement/src/test.rs` (real Soroban contract)
- `relayer/test/relayer.test.ts` (reorg detection)
- `solver/test/quote.test.ts` (pricing logic)

## Extending These Tests

To add a new scenario:

1. **Identify the seam**: What interaction between components needs testing?
2. **Choose the suite**: Happy path or refund path?
3. **Write the test**:
   ```typescript
   test("my new scenario", async () => {
     // Setup mocks
     const lz = new MockLayerZeroEndpoint();
     const token = new MockERC20(6);
     // ... 
     
     // Drive the lifecycle
     escrow.lock(intent, intentHash, solver);
     settlement.lzReceive(...);
     settlement.fillIntent(...);
     escrow.lzReceive(...);
     
     // Assert outcomes
     assert.equal(token.balanceOf(user), expected);
   });
   ```

4. **Run it**: `npm test`

## Integration with CI

Add to `.github/workflows/test.yml`:

```yaml
- name: E2E Tests
  run: |
    cd test
    npm install
    npm test
```

## See Also

- **Architecture**: `docs/TECHNICAL-ARCHITECTURE.md` (§6: Message Flow)
- **Intent Spec**: `docs/intent-spec.md` (amount boundaries, nonce, deadline)
- **Wire Vectors**: `contracts/shared/wire-vectors/` (golden byte sequences)
- **Differential Fuzz**: `docs/differential-fuzzing.md` (encoder conformance)
