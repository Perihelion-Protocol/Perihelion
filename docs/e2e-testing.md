# End-to-End Testing Strategy

This document describes Perihelion's approach to full-lifecycle integration testing and how it complements the per-component test suites.

## Motivation

Each component has comprehensive unit tests:
- **EVM escrow** (`contracts/evm/test/*.t.sol`): Foundry tests with mock LayerZero relay
- **Soroban settlement** (`contracts/soroban/settlement/src/test.rs`): Rust tests with mock endpoint
- **Solver** (`solver/test/quote.test.ts`): TypeScript tests for pricing logic
- **Relayer** (`relayer/test/relayer.test.ts`): TypeScript tests for message delivery

However, **correctness is emergent**: the protocol only works if all pieces fit together. Bugs at the seams manifest when:
- EVM encoding doesn't match Soroban decoding
- Nonce sequences get out of sync
- Race conditions (local timeout vs late settlement) create double-spends
- Idempotency keys mismatch across components

A single, deterministic end-to-end test that drives the entire lifecycle is the highest-value regression guard and the clearest executable documentation of the happy path.

## Test Architecture

### Mock-Based Integration Tests (`test/`)

Location: `test/happy-path.test.ts`, `test/refund-path.test.ts`

**Approach**: Use lightweight TypeScript mocks of EVM escrow, Soroban settlement, and LayerZero transport. Drive complete intent lifecycles in a single process.

**Advantages**:
- **Deterministic**: No flaky RPC calls, no chain delays
- **Fast**: Runs in milliseconds, suitable for CI
- **Debuggable**: Full stack trace across all components
- **Version-controlled**: Test inputs and golden outputs checked in

**What's tested**:
- ✅ User signs intent → solver locks → FillInstruction emitted
- ✅ FillInstruction relayed to Soroban → solver fills → FillConfirmed emitted
- ✅ FillConfirmed relayed back → escrow releases to solver
- ✅ Refund paths: cancel from Stellar, local timeout, race conditions
- ✅ Balance accounting at every step
- ✅ Idempotency and terminal state guards
- ✅ Wire format encoding (intent_hash, solver_evm fields)

**What's NOT tested** (covered elsewhere):
- ❌ LayerZero DVN verification → `Integration.t.sol` with real endpoint
- ❌ Actual chain finality → per-component tests with anvil/stellar-rpc
- ❌ Gas costs → Foundry gas snapshots
- ❌ Solver profitability → `solver/test/quote.test.ts`

### Per-Component Integration Tests

#### EVM: `contracts/evm/test/Integration.t.sol`

Foundry test with a `StellarRelay` that stands in for LayerZero + Soroban. The escrow dispatches real wire-format messages to the relay; the relay plays Stellar's side by delivering `FillConfirmed`/`CancelIntent` back through `lzReceive`.

**Key coverage**:
- Round-trip message dispatch and receive
- Peer/nonce authentication
- Terminal-state guards (can't settle+refund same intent)
- Payout address independence
- Two concurrent intents resolving independently

#### Soroban: `contracts/soroban/settlement/src/test.rs`

Rust tests with a `MockEndpoint`. Includes lifecycle tests that assert the bytes a real fill/cancel dispatches are exactly what the EVM escrow's decoders expect.

**Key coverage**:
- FillInstruction registration
- fill_intent with balance transfers
- cancel_expired_intent with CancelIntent emission
- Wire format golden vectors (cross-validated with EVM)

#### Relayer: `relayer/test/relayer.test.ts`

TypeScript tests for message watching, confirmation waiting, reorg detection, and delivery idempotency.

**Key coverage**:
- Cursor advancement and checkpoint persistence
- Reorg rollback within confirmation window
- Retry + dead-letter queue behavior
- Composite dedup key (srcEid, dstEid, intentHash, messageType, nonce)

#### Solver: `solver/test/quote.test.ts`

TypeScript tests for profitability evaluation, slippage checks, and pricing error handling.

**Key coverage**:
- Decimal corridor conversions (6dp → 7dp, 18dp → 7dp, etc.)
- Min margin enforcement
- Terminal vs transient skip decisions
- Fee-inclusive profit calculation

## Environment Versions

The `docker-compose.yml` pins specific versions for reproducibility:

- **Foundry/Anvil**: `ghcr.io/foundry-rs/foundry:nightly-f625e95`
- **Stellar Quickstart**: `stellar/quickstart:21.2.0`

When reproducing a test failure or setting up a new environment, these versions ensure consistent behavior across machines and time.

## Test Execution

### Local Development

```bash
# Run all tests (unit + integration + E2E)
npm test

# E2E only
cd test && npm test

# Specific suite
npm run test:happy
npm run test:refund

# EVM contracts
cd contracts/evm && forge test

# Soroban contracts  
cd contracts/soroban && cargo test

# Off-chain components
npm test --workspace=solver
npm test --workspace=relayer
```

### Continuous Integration

`.github/workflows/test.yml` runs:
1. Foundry tests (EVM contracts)
2. Cargo tests (Soroban contracts)
3. TypeScript tests (solver, relayer, SDK)
4. **E2E tests** (test/)

All must pass before merge.

## Coverage Gaps and Future Work

### Current Limitations

1. **No real chain tests**: E2E tests use mocks, not anvil + stellar-rpc
2. **No DVN verification**: LayerZero message auth is mocked out
3. **No gas accounting**: Balance checks are token-level only
4. **No mempool integration**: Solver polls a mock, not a real mempool API

### Planned Additions

#### Local Devnet E2E (`test/devnet/`)

**Goal**: Run the full stack against local chains (anvil + stellar-core testnet) with real contracts deployed.

**Approach**:
- Deploy escrow to anvil with a local LayerZero endpoint
- Deploy settlement to stellar-core testnet
- Run relayer and solver as background processes
- Submit a real intent, assert on-chain state

**Benefits**: Catches integration bugs that mocks miss (gas limits, chain-specific behavior, DVN verification).

**Challenges**: Flaky (network delays, reorg timing), slow (~10s per test), requires Docker.

**Status**: Deferred until after audit (complexity > value at current stage).

#### Property-Based E2E Fuzzing (`test/fuzz/`)

**Goal**: Generate random intents with varied amounts, deadlines, and nonces. Drive each through the E2E flow, asserting invariants (value conserved, no double-release, etc.).

**Approach**: Use `fast-check` to generate intent parameters, feed to mock-based E2E harness.

**Benefits**: Discover edge cases (amount boundaries, nonce collisions, deadline corner cases).

**Status**: Planned post-launch.

## When to Add E2E Tests

Add a new E2E test when:

1. **Cross-component bug found**: If a bug only manifests when two or more components interact, add an E2E regression test.

2. **New message type**: If the protocol adds a new wire message (e.g., `PartialFill`), add E2E coverage for the full round-trip.

3. **New state transition**: If a new terminal state is introduced (e.g., `Disputed`), add E2E tests for all paths leading to it.

4. **Race condition**: If a new race condition is identified (e.g., competing solvers), add E2E tests for all orderings.

## Debugging E2E Test Failures

### Symptom: Balance mismatch

**Check**:
1. Did the lock transfer the right amount?
2. Did the fill transfer the right amount?
3. Did the release transfer to the right address?

**Tools**: Add `console.log` for balances at each step.

### Symptom: State transition failure

**Check**:
1. Is the intent finalized already (double-release guard)?
2. Has the deadline passed (expired guard)?
3. Is the nonce out of order (replay guard)?

**Tools**: Assert intermediate states (`isSettled`, `isRefunded`, etc.).

### Symptom: Message not delivered

**Check**:
1. Was the message emitted (`lz.messageCount()`)?
2. Was it routed to the right destination (`lz.getMessagesTo(dstEid)`)?
3. Was the payload well-formed (`payload[0]` = VERSION, `payload[1]` = TYPE)?

**Tools**: Inspect `lz.lastMessage()` and hexdump the payload.

## References

- **Test code**: `test/happy-path.test.ts`, `test/refund-path.test.ts`
- **Mock implementations**: `test/mocks.ts`
- **Per-component tests**: See respective README files in `contracts/`, `solver/`, `relayer/`
- **Wire format**: `contracts/shared/wire-vectors/README.md`
- **Architecture**: `docs/TECHNICAL-ARCHITECTURE.md` §6 (Message Flow)
