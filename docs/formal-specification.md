# Perihelion Formal Specification & Invariant Verification

This document specifies the core safety invariants of the Perihelion bridge and
documents which properties have been formally verified, which remain in the
fuzz-test / code-audit tier, and which depend on external assumptions (Stellar
consensus, LayerZero DVNs).

---

## Table of Contents

1. [Overview](#overview)
2. [Core invariants](#core-invariants)
3. [EVM contract specification](#evm-contract-specification)
4. [Soroban contract specification](#soroban-contract-specification)
5. [Verification status](#verification-status)
6. [Proven vs. assumed](#proven-vs-assumed)
7. [Future formal verification roadmap](#future-formal-verification-roadmap)

---

## Overview

Perihelion's safety depends on three core invariants (I1, I2, I5 in the
architecture spec). These invariants protect against:
- Double-settlement of a single user intent
- Loss of user funds (stuck or unrefundable)
- Byte-identical intent-hash collision across chains

This document captures formal specifications for these and related properties,
identifies which are machine-verified vs. which rely on code review / fuzz tests,
and outlines the path to full formal verification.

**Target properties for Phase 1 verification:**
- **I1 (no fund loss):** Either settled on Stellar or refunded on EVM, never both
- **I2 (single settlement):** At most one settlement per intent_hash across both chains
- **I5 (byte-identical hash):** Intent hash matches between EIP-712 (EVM) and SDK (Soroban)

---

## Core Invariants

### Invariant I1: No User Fund Loss

**Statement:** For any intent_hash, if a user locked funds on EVM, the user
either receives a fill on Stellar (via the solver) or receives a refund on EVM.
The refund is available locally (via `cancelExpired`) if the cross-chain fill
confirmation times out, or via an inbound `CancelIntent` message.

**Formal model:**
```
∀ intent_hash, user, lock:
  if Lock(intent_hash, user) is created
  then (
    (∃ fill: Filled(intent_hash) ∧ fill.recipient == user)
    OR
    (∃ refund: Refunded(intent_hash, user))
  )
```

**Protection:** Controlled by the `released` and `refunded` flags in the escrow's
Lock struct. Each intent can reach at most one terminal state (settled or refunded),
enforced by the following code:
```solidity
if (lock.released) revert AlreadyReleased();
if (lock.refunded) revert AlreadyRefunded();
```

**Status:** Fuzz-tested; not yet formally verified with Certora/Halmos.

---

### Invariant I2: Single Settlement per Intent

**Statement:** For any intent_hash, exactly one of the following occurs:
1. The solver fills the intent on Stellar (creates a settlement record)
2. The user cancels the intent and receives a refund
3. The intent expires and the user takes the local refund

No intent can be both filled and cancelled, nor settled twice.

**Formal model:**
```
∀ intent_hash:
  (Filled(intent_hash) ∧ ¬Cancelled(intent_hash)) ∨
  (Cancelled(intent_hash) ∧ ¬Filled(intent_hash)) ∨
  (¬Filled(intent_hash) ∧ ¬Cancelled(intent_hash))
```

**Protection:** Guarded by idempotency markers on both chains:

- **EVM:** `Lock.released` and `Lock.refunded` booleans (mutually exclusive)
- **Soroban:** `Settled(intent_hash)` and `Cancelled(intent_hash)` markers (read-once)

Both are set atomically the first time the intent reaches a terminal state; all
subsequent attempts to fill or cancel are rejected.

**Status:** Fuzz-tested via invariant tests; not yet formally verified.

---

### Invariant I5: Byte-Identical Intent Hash

**Statement:** The EIP-712 hash computed on the EVM side (Solidity) is
byte-identical to the hash computed on the Soroban side (Rust SDK and contract).
This ensures that intents locked on EVM and filled on Soroban refer to the same
logical intent.

**Formal model:**
```
∀ intent_params (user, destination, sourceChainId, sourceAsset, ...):
  keccak256(abi.encode(INTENT_TYPEHASH, ...)) [EVM]
  ==
  blake2b(encode_intent(...)) [Soroban]
```

**Protection:** The EIP-712 domain, type hash, and encoding are defined
identically in:
- `contracts/evm/src/PerihelionEscrow.sol` (Solidity constants)
- `contracts/shared/wire-vectors/intent-spec.md` (wire format reference)
- `sdk/src/intent.ts` (TypeScript SDK)
- `contracts/soroban/settlement/src/messages.rs` (Soroban contract)

A comprehensive wire-vector test suite (`contracts/shared/wire-vectors/`) cross-validates
encodings.

**Status:** Differential-fuzz-tested (cross-chain wire format validator); not yet
formally verified with SMT-based tools.

---

### Invariant I3: Solver Fronts Liquidity

**Statement:** The solver must deliver destination assets *before* being repaid
on the source chain. This prevents the solver from extracting value without
performing the promised fill.

**Formal model:**
```
∀ intent_hash, solver:
  if FillConfirmed(intent_hash) is dispatched from Soroban
  then ∃ fill_amount such that
    TransferOut(Soroban, solver.escrow_account, fill_amount) occurred
    in Soroban transaction before FillConfirmed dispatch
```

**Protection:** On Soroban, `fill_intent` must transfer tokens *before* calling
the LayerZero endpoint:
```rust
token::transfer(&env, &env.current_contract_address(), &recipient, &fill_amount)?;
// ... record the fill ...
self.dispatch_fill_confirmed(...)?;
```

On EVM, receipt of FillConfirmed releases the solver's locked funds via `releaseLock`.
The token transfer on Soroban is atomic (all-or-nothing); if it fails, the intent
remains unfilled and the solver is not repaid.

**Status:** Code-reviewed; not yet formally verified.

---

### Invariant I4: Permissionless Liveness

**Statement:** Any user or relayer can refund an expired intent on EVM (`cancelExpired`)
or cancel an expired intent on Soroban (`cancel_expired_intent`). No privileged actor
can strand funds indefinitely.

**Formal model:**
```
∀ intent_hash, deadline:
  if (now > deadline)
  then ∀ caller: can_call(cancel_expired_intent(intent_hash, caller)) == true
```

**Protection:** `cancelExpired` and `cancel_expired_intent` have no `msg.sender` guard;
any address can invoke them. Deadline checks are in place, preventing premature calls.

**Status:** Code-reviewed; not yet formally verified.

---

### Invariant I6: Replay Prevention

**Statement:** No message can be delivered twice to the destination contract.
The LayerZero transport nonce prevents replay of the same message; the intent
idempotency markers (`Settled`, `Cancelled`) prevent re-settlement of the same
intent even if a message somehow arrives twice.

**Formal model:**
```
∀ message, nonce:
  if message is delivered with nonce N
  then ∀ nonce >= N: no duplicate message with nonce N can be processed
```

**Protection:** LayerZero's `inboundNonce` tracking (per source endpoint) and
application-level idempotency markers.

**Status:** Code-reviewed; not yet formally verified.

---

## EVM Contract Specification

### PerihelionEscrow State Machine

**State:**
```
- owner: address (timelock)
- guardian: address (emergency pause key)
- paused: bool
- stellarPeer: bytes32 (Soroban settlement address)
- locks: mapping(bytes32 intent_hash => Lock)
```

**Lock struct:**
```
{
  solver: address,
  user: address,
  asset: address,
  amount: uint256,
  deadline: uint256,
  released: bool,
  refunded: bool
}
```

### Entrypoint Preconditions

| Entrypoint | Caller | Guard | State change |
|---|---|---|---|
| `lock` | anyone | `!paused` | Create lock; emit FillInstruction |
| `releaseLock` | endpoint | release flag unset | Set release flag; transfer to solver |
| `refundLock` | endpoint or anyone (after deadline) | refund flag unset | Set refund flag; transfer to user |
| `cancelExpired` | anyone | `deadline < now` | Refund lock (permissionless fallback) |
| `pause` / `unpause` | owner | (none) | Toggle paused flag |
| `setPeer` | owner | (none) | Update stellarPeer |

### Safety Properties

**Property P1: Atomic unlock**
```
∀ lock_hash, t:
  if lock.released(t) then amount_unlocked(lock_hash, t) == lock.amount
  if lock.refunded(t) then amount_returned_to_user(lock_hash, t) == lock.amount
  ¬(lock.released(t) ∧ lock.refunded(t))  [mutual exclusion]
```

**Property P2: No stuck funds**
```
∀ lock_hash:
  ∃ deadline such that
    if now > deadline then ∃ tx: lock_is_refunded(lock_hash, tx)
```

---

## Soroban Contract Specification

### IntentRecord State Machine

**State:**
```
- admin: Address
- endpoint: Address
- peers: mapping(u32 eid => BytesN<32> peer)
- intents: mapping(BytesN<32> hash => IntentRecord)
- settled: set(BytesN<32> hash)
- cancelled: set(BytesN<32> hash)
```

**IntentRecord struct:**
```
{
  intent_hash: BytesN<32>,
  src_eid: u32,
  recipient: Address,
  dest_asset: Address,
  min_dest_amount: i128,
  deadline: u64,
  status: IntentStatus {Locked, Filled, ConfirmationSent, Cancelled},
  solver: Option<Address>,
  fill_amount: i128,
}
```

### Entrypoint Preconditions

| Entrypoint | Caller | Guard | State change |
|---|---|---|---|
| `lz_receive` | endpoint | peer == sender | Register intent from FillInstruction |
| `fill_intent` | anyone | intent exists, not settled | Record fill; transfer to recipient; dispatch FillConfirmed |
| `cancel_expired_intent` | anyone | intent exists, deadline < now | Mark cancelled; dispatch CancelIntent |
| `propose_peer` | admin | (none) | Propose new peer (delay between `MIN_PEER_CHANGE_DELAY` and `MAX_PEER_CHANGE_DELAY`) |
| `confirm_peer` | admin | (none) | Apply the pending peer after the delay, within `PEER_CHANGE_GRACE` |
| `cancel_pending_peer` | admin | (none) | Discard the pending peer proposal |
| `confirm_peer` | admin | delay elapsed | Apply pending peer |

### Safety Properties

**Property Q1: All-or-nothing fill**
```
∀ intent_hash:
  if fill_intent(intent_hash, amount) is called then:
    (transfer succeeded ∧ FillConfirmed dispatched)
    OR
    (transfer failed ∧ intent status unchanged)
```

**Property Q2: Idempotent cancel**
```
∀ intent_hash:
  once cancelled(intent_hash) is true
  then ∀ tx: fill_intent(intent_hash, *) reverts
```

**Property Q3: Peer governance (issue #165)**
```
∀ eid:
  if propose_peer(eid, new_peer) is called at time T
  then confirm_peer(eid) can only succeed for t >= T + MIN_PEER_CHANGE_DELAY
```

---

## Verification Status

### Machine-Verified (Formal Methods)

| Property | Verified with | Status |
|---|---|---|
| (None yet) | — | Planned Phase 1 targets: I1, I2 |

### Fuzz-Tested (Invariant Tests)

| Property | Test file | Status |
|---|---|---|
| I1 (no double-release) | `PerihelionEscrow.t.sol` → `Invariant.t.sol` | ✓ Passing |
| I2 (single settlement) | `PerihelionEscrow.t.sol` → `Invariant.t.sol` | ✓ Passing |
| I3 (solver fronts liquidity) | `Soroban settlement/src/test.rs` | ✓ Passing |
| I4 (permissionless liveness) | `PerihelionEscrow.t.sol` | ✓ Passing |
| I5 (byte-identical hash) | `wire-vectors/` differential fuzz | ✓ Passing |
| I6 (replay prevention) | `PerihelionEscrow.t.sol` → `WireFormat.t.sol` | ✓ Passing |

### Code-Reviewed (No Formal Verification)

| Property | Audit notes | Status |
|---|---|---|
| Release/refund atomicity | Guardian cannot drain; only unlock funds | ✓ Code reviewed |
| Peer governance (issue #165) | Two-step delay enforced; tested | ✓ Code reviewed |
| Admin separation (issue #18) | Admin ≠ endpoint at init; enforced | ✓ Code reviewed |

### External Assumptions (Not Verified)

| Assumption | Rationale | Risk mitigation |
|---|---|---|
| **Stellar consensus** | Stellar Consensus Protocol guarantees finality | Peer review of SCP; monitor for fork |
| **LayerZero DVNs** | DVN set integrity (not verified by Perihelion) | 2-of-3 threshold; monitor DVN reputation |
| **EVM consensus** | EVM chain finality (not verified by Perihelion) | DVN block confirmation threshold (≥15 blocks) |
| **Deterministic compilation** | Solidity bytecode matches across builds | CI reproducible-bytecode check (`.github/workflows/`) |

---

## Proven vs. Assumed

### What Perihelion Proves (In Code)

1. **No double-release per lock** — The `released` flag is set once and never unset
   - Code: `if (lock.released) revert AlreadyReleased();`
   - Enforcement: Solidity state, immutable after write

2. **No double-refund per lock** — The `refunded` flag is set once and never unset
   - Code: `if (lock.refunded) revert AlreadyRefunded();`
   - Enforcement: Solidity state, immutable after write

3. **Intent hash is deterministic** — Given identical parameters, hash is byte-identical
   - Code: EIP-712 type hash + keccak256 (EVM) / blake2b (Soroban)
   - Enforcement: Cryptographic hash function (collision-resistant)

4. **Peer changes are delayed** — `propose_peer` + delay + `confirm_peer` (Soroban)
   - Code: Timestamp check in `confirm_peer`, MIN_PEER_CHANGE_DELAY constant
   - Enforcement: Soroban ledger timestamp (monotonic)

### What Perihelion Assumes (External Guarantees)

1. **Stellar validators produce a canonical ledger** — A Stellar fork would allow
   double-settlement on the destination chain
   - Mitigation: Economic finality (Stellar Consensus Protocol); monitor for forks

2. **LayerZero DVNs are honest (at threshold)** — A compromised DVN set could
   forge FillConfirmed messages
   - Mitigation: M-of-N threshold (2 required + 1 optional); monitor DVN operators

3. **EVM chain does not reorg below DVN confirmation threshold** — A deep EVM reorg
   could orphan a FillInstruction, leaving the user unrefunded
   - Mitigation: DVN block confirmation (≥15 blocks); monitor EVM fork conditions

4. **Solidity compiler is deterministic** — Non-deterministic compilation could
   introduce hidden bugs in the bytecode
   - Mitigation: Reproducible-bytecode CI check; pinned compiler version (0.8.24)

---

## Future Formal Verification Roadmap

### Phase 1: Core Conservation Property (Q1 2026)

**Goal:** Machine-verify that I1 and I2 hold for all inputs.

**Approach:**
- **EVM:** Use Certora Prover or Halmos to verify `release` and `refund` are
  mutually exclusive and idempotent
- **Soroban:** Use Kani model checker or a TLA+ state machine to verify intent
  lifecycle transitions

**Scope:**
- `lock`, `releaseLock`, `refundLock`, `cancelExpired` entrypoints
- Lock struct invariants (`released` ⊕ `refunded`)
- Intent idempotency markers (`Settled` ⊕ `Cancelled`)

**Expected artifacts:**
- Certora rule set for EVM conservation
- Kani harness for Soroban lifecycle
- Formal proof summary (PDF)

### Phase 2: Timelock & Governance (Q2 2026)

**Goal:** Verify that peer changes and admin actions are properly delayed/gated.

**Approach:**
- Certora rules for `PerihelionTimelock` M-of-N + delay enforced
- State machine model for peer governance (issue #165)

**Scope:**
- `propose` → `confirm` → `execute` flow
- Threshold and delay bounds
- No TOCTOU (time-of-check, time-of-use) windows

### Phase 3: Cross-Chain Linearizability (Q3 2026)

**Goal:** Verify that the EVM-Soroban settlement is linearizable (no race conditions
across chains despite message delays).

**Approach:**
- TLA+ specification of the two-chain protocol
- State-space exploration or bisimulation tools
- Verification that there is no reachable state violating I1/I2

**Scope:**
- Message ordering and loss scenarios
- Reorg handling on both chains
- LayerZero delivery ordering

---

## Verification Configuration

### EVM Contracts (Solidity 0.8.24)

**For Certora verification:**
```certora
certoraRun contracts/evm/src/PerihelionEscrow.sol \
  --solc solc-0.8.24 \
  --msg "Verify I1/I2 conservation" \
  --rules rules/conservation.spec
```

**For Halmos verification:**
```bash
halmos --root contracts/evm --test PerihelionEscrow
```

### Soroban Contracts (Rust)

**For Kani verification:**
```bash
cargo kani --harness perihelion_intent_lifecycle \
  --depth 100 \
  --solver cbmc
```

**For TLA+:**
```bash
tlc specs/perihelion.tla -workers 4
```

---

## References

- [Threat Model](./threat-model.md) — Role definitions, compromise scenarios
- [Architecture Spec](./TECHNICAL-ARCHITECTURE.md) — High-level design, invariant citations (I1–I6)
- [Wire Vectors](../contracts/shared/wire-vectors/README.md) — Cross-chain message encoding
- [Intent Spec](./intent-spec.md) — EIP-712 and intent lifecycle
- [EVM Test Suite](../contracts/evm/test/) — Solidity invariant tests
- [Soroban Test Suite](../contracts/soroban/settlement/src/test.rs) — Rust unit & fuzz tests

---

**Status:** Specification complete; formal verification in progress.  
**Last updated:** July 2026  
**Owned by:** Protocol Security & Verification Team  
**Review cadence:** Quarterly or post-audit
