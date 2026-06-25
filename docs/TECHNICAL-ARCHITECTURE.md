# Perihelion Protocol — Technical Architecture Specification

**Status:** Draft for contributor & auditor review
**Audience:** Senior protocol engineers evaluating whether to contribute to, audit, or fund Perihelion
**Scope:** Soroban settlement contract, EVM escrow contract, LayerZero V2 integration, solver economics, security model, testing, and phased rollout

> **Relationship to the codebase.** This document is the production specification.
> The current repository (`contracts/`, `sdk/`, `solver/`, `relayer/`) contains a
> working scaffold that implements a *simplified single-message* flow for local
> testing. Where this specification supersedes the scaffold, it is called out
> explicitly. The confirmed design is the union of (a) the repository's
> [`README`](../README.md), [`architecture.md`](./architecture.md), and
> [`intent-spec.md`](./intent-spec.md), and (b) the contract sources. Anything
> not derivable from those is marked **[PROPOSED]** and segregated from the
> confirmed design.

---

## 0. Design Invariants (read first)

Every component below is built to preserve five global invariants. They are
referenced throughout by number.

| # | Invariant | Enforced by |
|---|-----------|-------------|
| **I1** | **No user fund loss.** A user is either settled on Stellar (receives ≥ `minDestAmount`) or refunded in full on the source chain. There is no state in which both legs fail to make the user whole. | EVM `refund`/`cancelExpired` + Soroban deadline checks |
| **I2** | **Single settlement.** An intent is filled on Stellar at most once and the source escrow is released at most once. | `intent_hash` idempotency key on both chains |
| **I3** | **Solver fronts liquidity; solver bears solver risk.** The solver delivers destination assets from its own inventory and is repaid only against a *verified* source lock. A solver that fills an unlocked or invalid intent simply is not paid; the user is never harmed. | Atomic `fill_intent` + source-side verification before `release` |
| **I4** | **Permissionless liveness.** Cancellation and refund paths can be driven by anyone (including the user), so no privileged actor can strand funds. | `cancel_expired_intent` (Soroban) + `cancelExpired` (EVM), both unpermissioned |
| **I5** | **Hash stability.** The EIP-712 `intent_hash` is byte-identical across the SDK, the EVM escrow, and every LayerZero payload, so all components key off one identifier. | Shared EIP-712 domain/type (`sdk/src/intent.ts` ⇔ `PerihelionEscrow.hashIntent`) |

---

## 1. Soroban Contract Architecture

### 1.1 Storage model — tier selection and rationale

Soroban exposes three storage tiers, each with different lifetime and cost
semantics. Choosing the wrong tier is a class of bug that does not surface in
unit tests (which run in a fresh, never-archived ledger) but is catastrophic on
mainnet. The table below fixes the tier for every category of state and states
*why*.

| State category | Tier | Rationale | Failure if mis-tiered |
|----------------|------|-----------|------------------------|
| Admin address, endpoint address, protocol config | **Instance** | Small, read on nearly every call, must share the contract's lifetime. Instance storage is bumped whenever the contract WASM entry is bumped, so config never archives while the contract is live. | If put in Temporary, the contract bricks after the temp TTL elapses. |
| Per-intent records (`Intent(hash)`) | **Persistent** | Must survive indefinitely until the intent reaches a terminal state, and must be *restorable* if archived (a late confirmation can arrive after archival). Persistent entries archive but are recoverable via `RestoreFootprint`. | If Temporary, an archived intent is **deleted**, destroying the replay guard (I2 violation) and the refund record (I1 violation). |
| Replay/idempotency markers (`Settled(hash)`) | **Persistent** | A settled marker must never silently disappear; deletion would re-open a fill. | Temporary deletion ⇒ double-settlement. |
| Nonce high-water marks per source pathway | **Persistent** | Transport-ordering metadata that must not regress. | Reset ⇒ message replay window. |
| Short-lived solver fill *intents/claims* (soft locks) **[PROPOSED]** | **Temporary** | A solver's "I am about to fill this" soft reservation is intentionally ephemeral; if it archives, the worst case is the reservation lapses and another solver may fill. No safety property depends on it. | None — Temporary is correct precisely because losing it is safe. |

**Why not store intent records in Instance storage?** Instance storage is a
single serialized map loaded *in full* on every invocation. Putting unbounded
per-intent data there would make every call's read-bytes grow without bound and
eventually exceed the per-transaction ledger-read limit. Per-intent data must be
individually-addressable Persistent entries so each call touches only the keys
in its footprint.

#### TTL, bump amounts, and the archival contract

Soroban TTL parameters are **network settings** (`StateArchivalSettings`), not
constants the contract should hard-code — they can be changed by validator vote.
The contract reads the current values where possible and the keeper (§1.7) uses
the live network config. Representative values (testnet/mainnet class, ~5 s
ledger close) used for sizing below:

| Parameter | Representative value | Meaning |
|-----------|----------------------|---------|
| `max_entry_ttl` | 3,110,400 ledgers (~180 days) | Hard ceiling on any single `extend_ttl`. |
| `min_persistent_entry_ttl` | 4,096 ledgers (~5.7 h) | Floor a new persistent entry is created with. |
| `min_temp_entry_ttl` | 16 ledgers (~80 s) | Floor for temporary entries. |

> **Do not hard-code these.** The contract's bump targets are expressed relative
> to the intent's own `deadline` (a domain quantity) plus a safety margin, then
> clamped to `max_entry_ttl`. This keeps the contract correct across network
> setting changes.

Bump policy:

- **Instance (config):** extended on every state-mutating call via
  `env.storage().instance().extend_ttl(threshold, extend_to)` with
  `threshold = 17_280` (~1 day) and `extend_to = 1_209_600` (~70 days). A live
  contract is touched far more often than once per 70 days, so config never
  archives.
- **Persistent intent record:** on creation/registration, bumped to cover
  `deadline + GRACE`, where `GRACE = 120_960` ledgers (~7 days) absorbs late
  confirmations and the refund window. Concretely
  `extend_to = min(ledgers_until(deadline) + GRACE, max_entry_ttl)`.
- **Settled markers:** bumped to `max_entry_ttl` on settlement. A settled marker
  is cheap (a single bool) and must outlive any plausible replay attempt; we pay
  for the longest legal life.

### 1.2 The complete `DataKey` enum

The scaffold ships a minimal `DataKey` (`Admin`, `Endpoint`, `Settled`). The
production contract uses the following. Variants are ordered so the most
frequently read keys have the smallest XDR discriminants (a micro-optimization;
discriminant size is constant in current XDR but ordering keeps intent clear).

```rust
use soroban_sdk::{contracttype, Address, BytesN};

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    // --- Instance tier (config) ---
    /// Governance / upgrade authority.
    Admin,
    /// Trusted LayerZero endpoint contract; sole caller of `lz_receive`.
    Endpoint,
    /// Pause switch for emergency halt (see §6 admin-key threat).
    Paused,
    /// Peer OApp address on each remote endpoint id: maps src/dst eid -> peer.
    /// Stored as Instance because the peer set is small and read on every send.
    Peer(u32),

    // --- Persistent tier (per-intent lifecycle) ---
    /// Full lifecycle record for an intent, keyed by its EIP-712 hash (I5).
    Intent(BytesN<32>),
    /// Terminal idempotency marker: present iff the intent was settled (I2).
    Settled(BytesN<32>),
    /// Terminal idempotency marker: present iff the intent was cancelled.
    Cancelled(BytesN<32>),

    // --- Persistent tier (transport bookkeeping) ---
    /// Highest LayerZero inbound nonce processed for a (srcEid, sender) pathway.
    /// Used for the lazy-nonce / replay window (see §3.4).
    InboundNonce(u32),
    /// Outbound nonce counter per (dstEid) pathway for FillConfirmed/Cancel.
    OutboundNonce(u32),

    // --- Temporary tier (soft reservations) [PROPOSED] ---
    /// Ephemeral solver soft-lock; safe to lose (see §1.1).
    Reservation(BytesN<32>),
}
```

The intent record itself:

```rust
#[contracttype]
#[derive(Clone)]
pub struct IntentRecord {
    /// EIP-712 hash; redundant with the key but kept for event emission and
    /// defense-in-depth against key/value desync.
    pub intent_hash: BytesN<32>,
    /// LayerZero endpoint id of the source chain that locked the funds.
    pub src_eid: u32,
    /// Recipient Stellar account/contract (32-byte strkey body).
    pub recipient: Address,
    /// Stellar Asset Contract address of the asset to deliver.
    pub dest_asset: Address,
    /// User's slippage floor, smallest units. Solver must deliver >= this.
    pub min_dest_amount: i128,
    /// Unix seconds after which the intent may be cancelled (I1/I4).
    pub deadline: u64,
    /// Optional exclusive solver; `None` == open competition.
    pub preferred_solver: Option<Address>,
    /// Current lifecycle state (see §2).
    pub status: IntentStatus,
    /// Solver that filled, once filled (their Stellar identity).
    pub solver: Option<Address>,
    /// Solver's EVM payout address, carried into FillConfirmed.
    pub solver_evm: Option<BytesN<32>>, // left-padded 20-byte address
    /// Amount actually delivered on Stellar (audit / dispute).
    pub fill_amount: i128,
    /// Stellar ledger sequence at fill (audit / dispute).
    pub fill_ledger: u32,
}

#[contracttype]
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum IntentStatus {
    /// Registered from a FillInstruction; awaiting a solver.
    Locked,
    /// A solver has filled on Stellar; FillConfirmed not yet dispatched.
    Filled,
    /// FillConfirmed dispatched to source.
    ConfirmationSent,
    /// Deadline passed without fill; CancelIntent dispatched.
    Cancelled,
}
```

### 1.3 The complete error enum

`#[contracterror]` variants are `u32`. We assign codes in HTTP-analogue bands so
operators can triage at a glance: **4xx = caller/precondition error**,
**4xx9x = auth**, **5xx = invariant/internal**. Soroban surfaces these as
`Error(Contract, #code)` in transaction results.

```rust
use soroban_sdk::contracterror;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum PerihelionError {
    // --- Initialization / lifecycle (analogue: 409 Conflict / 412) ---
    /// `initialize` called twice. Triggered when DataKey::Admin already set.
    AlreadyInitialized = 100,
    /// Any entrypoint called before `initialize`. Triggered when Admin unset.
    NotInitialized = 101,
    /// State-mutating call while `Paused == true`.
    ContractPaused = 102,

    // --- Authorization (analogue: 401/403) ---
    /// Caller is not the configured endpoint (lz_receive guard).
    NotEndpoint = 130,
    /// Caller is not admin (config setters).
    NotAdmin = 131,
    /// Intent reserved for a different `preferred_solver`.
    ReservedForSolver = 132,

    // --- Intent preconditions (analogue: 400/404/409/410) ---
    /// No IntentRecord for the given hash (fill before registration).
    IntentNotFound = 140,
    /// Intent already in a terminal state (Settled/Cancelled marker present).
    IntentFinalized = 141,
    /// fill_intent called after `deadline`.
    IntentExpired = 142,
    /// cancel_expired_intent called before `deadline`.
    DeadlineNotPassed = 143,
    /// Delivered amount < min_dest_amount (slippage floor breach).
    InsufficientFillAmount = 144,
    /// Non-positive amount on fill or in a message payload.
    InvalidAmount = 145,
    /// Intent already filled (race lost; see §5 game theory).
    AlreadyFilled = 146,

    // --- Messaging (analogue: 400/422) ---
    /// Payload failed structural decode (bad version/type/length).
    MalformedPayload = 160,
    /// Unknown message type byte.
    UnknownMessageType = 161,
    /// Inbound LZ nonce <= high-water mark (replay) under lazy-nonce policy.
    StaleNonce = 162,
    /// Sender peer not registered for the inbound eid (spoofed source).
    UntrustedPeer = 163,

    // --- Invariant / internal (analogue: 5xx) ---
    /// Arithmetic overflow that should be unreachable given prior checks.
    /// Present so we fail closed rather than wrap (overflow-checks=on anyway).
    ArithmeticError = 500,
}
```

### 1.4 `fill_intent` — fully annotated production function

`fill_intent` is the solver-invoked entrypoint that satisfies invariant **I3**:
the solver moves destination assets from *its own* account to the recipient, the
contract records the fill, and a `FillConfirmed` message is dispatched so the
source escrow repays the solver. It is **not** a LayerZero-delivered call — it is
an ordinary Soroban transaction submitted by the solver.

> **Atomicity is the safety backbone.** Every check below precedes the token
> transfer, and a Soroban transaction is all-or-nothing: if any later step
> reverts, the `token.transfer` is rolled back. This is why a solver that loses a
> fill race (§5) loses only gas, never inventory.

```rust
use soroban_sdk::{token, Address, BytesN, Env, IntoVal, Symbol, Vec};

#[contractimpl]
impl Perihelion {
    /// Solver delivers `dest_asset` to the intent's recipient from its own
    /// inventory and triggers repayment on the source chain.
    ///
    /// `solver`        — the solver's Stellar identity (must authorize).
    /// `solver_evm`    — left-padded 20-byte EVM address to be paid on source.
    /// `intent_hash`   — EIP-712 id of a previously-registered intent (I5).
    /// `fill_amount`   — units of dest_asset to deliver; must be >= floor.
    /// `lz_fee`        — native fee the solver pre-pays for the FillConfirmed send.
    pub fn fill_intent(
        env: Env,
        solver: Address,
        solver_evm: BytesN<32>,
        intent_hash: BytesN<32>,
        fill_amount: i128,
        lz_fee: i128,
    ) -> Result<(), PerihelionError> {
        // (1) Authenticate the solver. require_auth proves the solver signed
        //     THIS invocation with THESE args (Soroban auth is per-invocation,
        //     argument-bound), so a relayer cannot replay it with new args.
        solver.require_auth();

        // (2) Reject all mutation while paused (emergency halt, §6).
        if Self::is_paused(&env) {
            return Err(PerihelionError::ContractPaused);
        }

        // (3) Terminal-state guard BEFORE loading the record: a present
        //     Settled/Cancelled marker means the intent is closed (I2).
        //     We check markers (cheap bool entries) rather than only the record
        //     status so the guard holds even if the record was archived/restored.
        if env.storage().persistent().has(&DataKey::Settled(intent_hash.clone()))
            || env.storage().persistent().has(&DataKey::Cancelled(intent_hash.clone()))
        {
            return Err(PerihelionError::IntentFinalized);
        }

        // (4) Load the registered intent. Absence means the source lock was
        //     never relayed here (FillInstruction missing) — filling it would be
        //     unbacked, so we refuse (I3: solver only fills verified intents).
        let key = DataKey::Intent(intent_hash.clone());
        let mut rec: IntentRecord = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(PerihelionError::IntentNotFound)?;

        // (5) Status must be exactly Locked. Any other status means already
        //     filled/confirmed/cancelled — fail closed and let the solver retry
        //     a different intent (this is the on-chain race resolver, §5).
        if rec.status != IntentStatus::Locked {
            return Err(PerihelionError::AlreadyFilled);
        }

        // (6) Deadline check against LEDGER time, not wall clock. Soroban
        //     timestamps are validator-agreed and monotonic per ledger; using
        //     ledger().timestamp() makes the check deterministic and replay-safe.
        if env.ledger().timestamp() >= rec.deadline {
            return Err(PerihelionError::IntentExpired);
        }

        // (7) Exclusivity: if the intent named a preferred solver, only they may
        //     fill (honors the user's optional private-order preference).
        if let Some(ref pref) = rec.preferred_solver {
            if pref != &solver {
                return Err(PerihelionError::ReservedForSolver);
            }
        }

        // (8) Slippage floor (I1 economic half): delivered amount must meet the
        //     user's signed minimum. fill_amount is solver-chosen and may exceed
        //     the floor (solver competition can over-deliver to win reputation).
        if fill_amount <= 0 {
            return Err(PerihelionError::InvalidAmount);
        }
        if fill_amount < rec.min_dest_amount {
            return Err(PerihelionError::InsufficientFillAmount);
        }

        // (9) EFFECTS BEFORE INTERACTIONS (Soroban analogue of CEI): flip status
        //     and write the record FIRST so that even though Soroban has no
        //     reentrancy via token transfers today, any future cross-contract
        //     token hook cannot observe a Locked record. Also write the Settled
        //     marker now to make double-fill impossible within this tx tree.
        rec.status = IntentStatus::Filled;
        rec.solver = Some(solver.clone());
        rec.solver_evm = Some(solver_evm.clone());
        rec.fill_amount = fill_amount;
        rec.fill_ledger = env.ledger().sequence();
        env.storage().persistent().set(&key, &rec);
        env.storage()
            .persistent()
            .set(&DataKey::Settled(intent_hash.clone()), &true);

        // (10) INTERACTION: move the destination asset from the solver to the
        //      recipient. transfer() invokes the SAC; require_auth in (1) plus
        //      the solver being `from` means only solver-owned funds move.
        let client = token::Client::new(&env, &rec.dest_asset);
        client.transfer(&solver, &rec.recipient, &fill_amount);

        // (11) Refresh TTLs touched by this call so a long-deadline intent's
        //      record/markers do not archive before the source release lands.
        let bump_to = Self::ttl_for_deadline(&env, rec.deadline);
        env.storage().persistent().extend_ttl(&key, bump_to / 2, bump_to);
        env.storage().persistent().extend_ttl(
            &DataKey::Settled(intent_hash.clone()),
            Self::max_ttl(&env) / 2,
            Self::max_ttl(&env),
        );
        env.storage().instance().extend_ttl(17_280, 1_209_600);

        // (12) Dispatch FillConfirmed (Stellar -> source) so the escrow releases
        //      the locked funds to solver_evm. This is a cross-contract call to
        //      the LayerZero endpoint; the solver pre-pays `lz_fee` in native.
        Self::send_fill_confirmed(&env, &solver, &rec, &solver_evm, lz_fee)?;

        // (13) Advance status to ConfirmationSent only after a successful send,
        //      so a failed send leaves the intent re-confirmable (liveness).
        rec.status = IntentStatus::ConfirmationSent;
        env.storage().persistent().set(&key, &rec);

        // (14) Emit a structured event for indexers, the SDK status API, and
        //      solver dashboards. Topic includes the hash for cheap filtering.
        env.events().publish(
            (Symbol::new(&env, "filled"), intent_hash),
            (solver, rec.dest_asset, fill_amount, rec.src_eid),
        );

        Ok(())
    }
}
```

The `send_fill_confirmed` helper builds the binary payload (§3.3) and calls the
endpoint via a generated client:

```rust
fn send_fill_confirmed(
    env: &Env,
    payer: &Address,
    rec: &IntentRecord,
    solver_evm: &BytesN<32>,
    lz_fee: i128,
) -> Result<(), PerihelionError> {
    // Build the FillConfirmed payload (version|type|hash|solver|amount|ledger).
    let message = encode_fill_confirmed(env, &rec.intent_hash, solver_evm,
                                        rec.fill_amount, rec.fill_ledger);
    // Look up the trusted peer (the EVM escrow) for the source eid (I5/§3.2).
    let peer: BytesN<32> = env
        .storage()
        .instance()
        .get(&DataKey::Peer(rec.src_eid))
        .ok_or(PerihelionError::UntrustedPeer)?;

    let endpoint: Address = env
        .storage()
        .instance()
        .get(&DataKey::Endpoint)
        .ok_or(PerihelionError::NotInitialized)?;

    // The solver authorizes the native fee transfer to the endpoint.
    let client = EndpointClient::new(env, &endpoint);
    client.send(
        &MessagingParams {
            dst_eid: rec.src_eid,
            receiver: peer,
            message,
            options: default_options(env), // executor + DVN options (§3.2)
        },
        payer,        // refund address for excess native fee
        &lz_fee,
    );
    Ok(())
}
```

### 1.5 `cancel_expired_intent` — deadline path

When a deadline elapses with no fill, **anyone** (the user, a watcher bot, a
competing solver) can drive cancellation (invariant **I4**). The function marks
the intent cancelled on Stellar and dispatches a `CancelIntent` message so the
source escrow refunds the user (invariant **I1**).

```rust
#[contractimpl]
impl Perihelion {
    /// Cancel an intent whose deadline has passed without a fill, and notify the
    /// source chain to refund the user. Permissionless (I4).
    pub fn cancel_expired_intent(
        env: Env,
        caller: Address,        // pays the LZ fee; gets the refund-address slot
        intent_hash: BytesN<32>,
        lz_fee: i128,
    ) -> Result<(), PerihelionError> {
        // Caller authorizes (they fund the cross-chain message). No privilege
        // check beyond payment — anyone may cancel an expired intent.
        caller.require_auth();

        if Self::is_paused(&env) {
            return Err(PerihelionError::ContractPaused);
        }

        // Idempotency: if already settled or cancelled, stop (I2). A settled
        // intent must NOT be cancellable — that would double-spend the escrow.
        if env.storage().persistent().has(&DataKey::Settled(intent_hash.clone())) {
            return Err(PerihelionError::IntentFinalized);
        }
        if env.storage().persistent().has(&DataKey::Cancelled(intent_hash.clone())) {
            return Err(PerihelionError::IntentFinalized);
        }

        let key = DataKey::Intent(intent_hash.clone());
        let mut rec: IntentRecord = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(PerihelionError::IntentNotFound)?;

        // Only a still-Locked intent can be cancelled. If a fill is mid-flight
        // (Filled/ConfirmationSent) the source release path owns the outcome.
        if rec.status != IntentStatus::Locked {
            return Err(PerihelionError::IntentFinalized);
        }

        // The core deadline guard: refuse to cancel before expiry so a griefer
        // cannot cancel live intents out from under solvers (§6 griefing).
        if env.ledger().timestamp() < rec.deadline {
            return Err(PerihelionError::DeadlineNotPassed);
        }

        // EFFECTS: write the terminal Cancelled marker and status before the
        // cross-contract send, closing the intent against any racing fill.
        rec.status = IntentStatus::Cancelled;
        env.storage().persistent().set(&key, &rec);
        env.storage()
            .persistent()
            .set(&DataKey::Cancelled(intent_hash.clone()), &true);
        env.storage().persistent().extend_ttl(
            &DataKey::Cancelled(intent_hash.clone()),
            Self::max_ttl(&env) / 2,
            Self::max_ttl(&env),
        );

        // INTERACTION: notify the source escrow to refund the user. The escrow
        // MUST itself re-check that no FillConfirmed already released the funds
        // (race between a late fill-confirm and this cancel), see §4.3.
        let peer: BytesN<32> = env
            .storage()
            .instance()
            .get(&DataKey::Peer(rec.src_eid))
            .ok_or(PerihelionError::UntrustedPeer)?;
        let endpoint: Address = env
            .storage()
            .instance()
            .get(&DataKey::Endpoint)
            .ok_or(PerihelionError::NotInitialized)?;
        let message = encode_cancel_intent(&env, &intent_hash, CANCEL_REASON_EXPIRED);

        EndpointClient::new(&env, &endpoint).send(
            &MessagingParams {
                dst_eid: rec.src_eid,
                receiver: peer,
                message,
                options: default_options(&env),
            },
            &caller,
            &lz_fee,
        );

        env.events().publish(
            (Symbol::new(&env, "cancelled"), intent_hash),
            (rec.src_eid, rec.deadline),
        );
        Ok(())
    }
}
```

**Why route the refund through a cross-contract message instead of letting the
EVM side refund unilaterally on its own timer?** Two designs were considered:

- *EVM-local timeout (rejected as the primary path):* the escrow refunds purely
  on its own block timestamp once `deadline` passes. Simple, but it creates a
  **double-pay race** — a `FillConfirmed` that is in flight when the escrow's
  timer fires could pay the solver *after* the user was refunded, draining the
  contract. Guarding that requires the escrow to know whether a fill happened,
  which only the Stellar side knows authoritatively.
- *Stellar-authoritative cancel (chosen):* the Stellar contract is the single
  source of truth for "filled vs. not", because the fill happens there. Cancel
  is therefore initiated on Stellar and the EVM side acts on an authenticated
  message. The EVM escrow still keeps a **local timeout fallback** (`cancelExpired`,
  §4.3) for liveness if the messaging layer is down, but that fallback contains
  the explicit "confirmation-not-arrived" guard to close the race.

### 1.6 Resource footprint & fee implications

Soroban meters each transaction across several dimensions and prices them via
the network fee config; the total resource fee is the sum of per-dimension costs
plus the inclusion (base) fee of 100 stroops/operation (1 stroop = 10⁻⁷ XLM).
The figures below are **engineering estimates** to be replaced with measured
values from `soroban-cli`'s budget output (`--cost`) and the
`testutils::budget()` API once the production contract compiles; they are sized
from the operation counts in the code above, not yet profiled.

| Function | Est. CPU instr. | Ledger reads | Ledger writes | Read bytes | Write bytes | Notes |
|----------|-----------------|--------------|---------------|------------|-------------|-------|
| `initialize` | ~250 K | 1 | 3 | ~0.1 KB | ~0.3 KB | One-time; writes Admin/Endpoint/Paused (Instance). |
| `lz_receive` (FillInstruction) | ~1.2 M | 3 | 2 | ~0.6 KB | ~0.4 KB | Decode payload, peer/nonce check, write IntentRecord + nonce. |
| `fill_intent` | ~3.5 M | 5 | 4 | ~1.0 KB | ~0.7 KB | Dominated by the SAC `transfer` cross-contract call + LZ `send`. |
| `cancel_expired_intent` | ~2.8 M | 4 | 3 | ~0.8 KB | ~0.5 KB | Similar to fill minus the token transfer. |
| `is_settled` (view) | ~120 K | 1 | 0 | ~0.1 KB | 0 | Read-only; no write fee. |
| `set_endpoint` / `set_peer` (admin) | ~200 K | 1 | 1 | ~0.1 KB | ~0.1 KB | Instance write + auth. |

**How estimated.** CPU is approximated as: base host overhead (~100 K) + payload
decode (~10 K/32 bytes) + per cross-contract invocation (SAC transfer ~1.5–2 M;
endpoint `send` ~1 M) + storage op overhead. Reads/writes are counted directly
from the keys each function touches; bytes from the XDR-serialized size of
`IntentRecord` (~120–160 bytes) plus markers. The 100 M instruction and ~100-entry
read/write per-tx ceilings are far above every function here, so no function is
near a resource limit.

**Fee implication.** At current mainnet pricing a transaction in this
class (single-digit ledger entries, low single-digit million instructions)
settles for well under **0.01 XLM** in resource + inclusion fees; the dominant
real cost to a solver is not Soroban gas but the **LayerZero messaging fee**
(native gas on the destination + DVN/executor fees), which is why solver
economics (§5) model LZ fees as the primary per-fill cost, not Soroban fees.
TTL-extension (rent) is a separate, small recurring cost folded into the keeper
budget (§1.7).

### 1.7 State archival in practice

Soroban does not delete Persistent/Instance state at TTL expiry — it **archives**
it (removes it from the live state but keeps a proof of its prior existence), and
a future transaction can `RestoreFootprint` it by paying rent. Temporary state is
hard-deleted. Perihelion's archival handling:

- **Config (Instance):** auto-bumped on every state-mutating call (§1.1). On a
  live protocol this never archives. If the contract were idle for >70 days, the
  first subsequent call would need to restore the instance entry; the SDK's
  submission path detects the archived-entry error and prepends a restore op.
- **Active intents (Persistent):** bumped to `deadline + 7 days`. An intent that
  resolves before its deadline never archives. An intent abandoned past
  `deadline + grace` may archive; this is **safe** because (a) the `Settled`/
  `Cancelled` markers are bumped to `max_entry_ttl` and outlive the record, so
  replay protection (I2) survives even if the record archives, and (b) a refund/
  cancel that arrives after archival triggers a restore-then-act flow.
- **Restore-then-act:** when `lz_receive` or `cancel_expired_intent` targets an
  archived intent, the transaction's footprint includes a `RestoreFootprint` for
  the entry. The **relayer** (which constructs these transactions) queries entry
  liveness via RPC `getLedgerEntries` and prepends restore ops automatically.
- **Keeper bot (operational, not consensus-critical):** a lightweight keeper
  scans for (a) intents nearing TTL expiry that are still non-terminal and bumps
  them, and (b) expired-deadline intents still `Locked` and calls
  `cancel_expired_intent` to free the user's source funds. The keeper is
  **permissionless and replaceable** — it is a liveness optimization, never a
  safety dependency (anyone, including the user, can perform the same actions).
  This separation (consensus-critical safety in the contract; liveness in an
  off-chain keeper) is deliberate: it keeps the trusted computing base minimal.

---

## 2. Intent Lifecycle — State Machine

### 2.1 States and their location

An intent's state is distributed across three locations. The table fixes where
each state's *authoritative* record lives.

| State | Authoritative location | Representation |
|-------|------------------------|----------------|
| **Created** | Off-chain (mempool) | Signed `Intent` + signature; not yet on any chain |
| **Locked** | Source EVM (escrow) **and** Stellar (after FillInstruction) | `locks[hash]` populated on EVM; `IntentRecord{status:Locked}` on Stellar |
| **SolverAssigned** | Off-chain / Stellar Temporary **[PROPOSED]** | Soft reservation; not safety-critical |
| **FilledOnStellar** | Stellar | `IntentStatus::Filled`, funds delivered to recipient |
| **ConfirmationSent** | Stellar → in-flight LZ | `IntentStatus::ConfirmationSent`; FillConfirmed dispatched |
| **ReleasedOnSource** | Source EVM | `locks[hash].released == true`; solver paid |
| **Expired** | Logical (deadline crossed, no fill) | Derived from `deadline` vs. clock; pre-cancel |
| **Cancelled** | Stellar (authoritative) + EVM (refunded) | `IntentStatus::Cancelled` + `locks[hash].refunded == true` |

### 2.2 Transition table

```
            ┌─────────┐
            │ Created │  (off-chain: user signs intent)
            └────┬────┘
   user/solver   │ EVM escrow.lock(intent, sig)  → escrow _lzSend(FillInstruction)
                 ▼
            ┌─────────┐    LZ delivers FillInstruction → Soroban lz_receive
            │ Locked  │────────────────────────────────────────────────┐
            └────┬────┘                                                 │
   solver        │ fill_intent (deadline not passed, amount >= floor)   │ deadline
   reserves      │                                                      │ passes,
  (optional)     ▼                                                      │ no fill
        ┌────────────────┐                                              ▼
        │ FilledOnStellar│  (recipient has funds; I1 dest half met)  ┌─────────┐
        └───────┬────────┘                                           │ Expired │
                │ send_fill_confirmed (LZ)                           └────┬────┘
                ▼                                                         │ cancel_expired_intent
       ┌──────────────────┐                                              │  → CancelIntent (LZ)
       │ ConfirmationSent │                                              ▼
       └───────┬──────────┘                                       ┌───────────┐
               │ LZ delivers FillConfirmed → escrow._lzReceive    │ Cancelled │
               ▼                                                   └─────┬─────┘
       ┌──────────────────┐                                             │ escrow refunds user
       │ ReleasedOnSource │  (solver paid; terminal success)            ▼  (terminal)
       └──────────────────┘                                      (user made whole)
```

| From | To | Trigger | Guard |
|------|----|---------|-------|
| Created | Locked | `escrow.lock()` pulls user funds; escrow sends FillInstruction | valid sig, `now < deadline`, not already locked |
| Locked | SolverAssigned **[PROPOSED]** | solver writes Temporary reservation | none (soft) |
| Locked / SolverAssigned | FilledOnStellar | `fill_intent` | not finalized, `now < deadline`, `amount ≥ floor`, solver allowed |
| FilledOnStellar | ConfirmationSent | `send_fill_confirmed` succeeds | LZ fee paid, peer registered |
| ConfirmationSent | ReleasedOnSource | escrow `_lzReceive(FillConfirmed)` | message authentic, lock present, not finalized |
| Locked | Expired | wall/ledger clock passes `deadline` | no fill recorded |
| Expired | Cancelled | `cancel_expired_intent` | `now ≥ deadline`, status still Locked |
| Cancelled | (refunded) | escrow `_lzReceive(CancelIntent)` or `cancelExpired` fallback | **confirmation not already arrived** (§4.3) |

### 2.3 Crash / dropped-message recovery per transition

The protocol is designed so every transition is **idempotent and resumable**:
the authoritative on-chain state plus the intent_hash is sufficient to re-derive
what action is still needed, with no off-chain coordination state required.

| Failure point | Symptom | Recovery path |
|---------------|---------|---------------|
| After `lock()`, before FillInstruction delivered | EVM shows Locked; Stellar has no record | LZ guarantees eventual delivery; the relayer retries. If the message is provably lost, the user's funds are protected by the EVM `cancelExpired` fallback after `deadline`. No fill can happen on Stellar without the record, so no unbacked payout (I3). |
| FillInstruction delivered twice | Duplicate `lz_receive` | Lazy-nonce + `Settled`/record-exists check makes the second a no-op (I2). |
| Solver crashes after `fill_intent` token transfer, before `send_fill_confirmed` returns | Recipient has funds; status `Filled`, not `ConfirmationSent` | `fill_intent`'s send is in the same atomic tx as the transfer — if `send` reverts, the transfer reverts too. So this split state cannot occur within one tx. If the **whole tx** failed, nothing moved; solver simply retries. |
| FillConfirmed dropped in transit | Stellar `ConfirmationSent`; EVM still Locked; solver unpaid | Solver (or anyone) re-dispatches FillConfirmed via a `resend` entrypoint keyed by intent_hash; escrow `_lzReceive` is idempotent (release-once guard), so duplicates are safe. The solver is incentivized to retry — it is owed money. |
| FillConfirmed and CancelIntent both reach EVM (late fill vs. cancel race) | Two terminal messages for one lock | EVM escrow processes whichever first sets a terminal flag; the second hits `AlreadyFinalized`. The Stellar side prevents this at the source by never `Cancelled` after `Filled` (status guard in `cancel_expired_intent`). Defense-in-depth on both chains. |
| Keeper offline | Expired intents not auto-cancelled | Liveness-only; user can call `cancel_expired_intent`/`cancelExpired` themselves. No safety impact (I4). |
| Stellar entry archived before confirmation | `lz_receive`/cancel targets archived record | Relayer prepends `RestoreFootprint` (§1.7); markers (max-TTL) preserve replay safety regardless. |

---

## 3. LayerZero V2 Integration — Deep Dive

### 3.1 The OApp standard on Soroban (no interface inheritance)

LayerZero V2's OApp model on EVM relies on Solidity inheritance: an OApp
contract extends `OApp`, overrides `_lzReceive`, and the endpoint calls back into
it. Soroban has **no interface inheritance and no virtual dispatch** — contracts
are flat WASM modules invoked by exported function symbol. Perihelion therefore
implements the OApp contract *by convention*: the Soroban LayerZero endpoint and
the Perihelion contract agree on a **function name and signature** that the
endpoint cross-contract-invokes upon message delivery.

The Perihelion contract exports an `lz_receive` matching the endpoint's expected
ABI:

```rust
#[contractimpl]
impl Perihelion {
    /// LayerZero V2 receive hook. The endpoint cross-contract-invokes this after
    /// the message has been verified by the configured DVN set and committed.
    /// There is no inheritance: the binding is by (a) exported symbol name and
    /// (b) the endpoint-only auth guard below.
    pub fn lz_receive(
        env: Env,
        origin: Origin,        // { src_eid: u32, sender: BytesN<32>, nonce: u64 }
        guid: BytesN<32>,      // globally-unique message id from LZ
        message: Bytes,        // opaque OApp payload (our binary spec, §3.3)
        _executor: Address,    // who executed delivery (unused for auth)
        _extra_data: Bytes,    // executor-supplied extra data (unused)
    ) -> Result<(), PerihelionError> {
        // (A) ONLY the endpoint may call. This replaces EVM's `onlyEndpoint`
        //     modifier. Soroban auth: the endpoint must authorize this exact
        //     invocation, so no other contract can spoof a delivery.
        let endpoint: Address = env
            .storage().instance().get(&DataKey::Endpoint)
            .ok_or(PerihelionError::NotInitialized)?;
        endpoint.require_auth();

        // (B) Peer check: the sender on src_eid must be our registered peer
        //     (the EVM escrow). Rejects messages from an unrecognized OApp even
        //     if they were validly transported.
        let expected: BytesN<32> = env
            .storage().instance().get(&DataKey::Peer(origin.src_eid))
            .ok_or(PerihelionError::UntrustedPeer)?;
        if expected != origin.sender {
            return Err(PerihelionError::UntrustedPeer);
        }

        // (C) Lazy-nonce replay guard (§3.4): accept any nonce strictly greater
        //     than the high-water mark; record the new max. Unordered delivery.
        Self::accept_nonce(&env, origin.src_eid, origin.nonce)?;

        // (D) Dispatch on the first payload byte after the version byte.
        match peek_msg_type(&env, &message)? {
            MSG_FILL_INSTRUCTION => Self::on_fill_instruction(&env, &message),
            MSG_CANCEL_INTENT    => Self::on_cancel_intent(&env, &message),
            _ => Err(PerihelionError::UnknownMessageType),
        }
    }
}
```

**Why convention-based binding is acceptable.** The security of the hook does not
come from the type system; it comes from the **`endpoint.require_auth()` guard**
(C-style capability check) plus the **peer check**. An attacker who deploys a
contract exporting `lz_receive` gains nothing: only the real endpoint can satisfy
the auth, and only the registered peer passes (B). This is exactly the trust
basis EVM OApps rely on (`msg.sender == endpoint` + `_getPeerOrRevert`), expressed
without inheritance.

### 3.2 DVN configuration and on-chain enforcement

LayerZero V2 separates **verification** (DVNs attest a message) from **execution**
(an executor delivers it). Security is governed by the OApp's **ULN (Ultra Light
Node) config**, set per pathway (remote eid).

Perihelion's confirmed DVN policy:

| Parameter | Value | Rationale |
|-----------|-------|-----------|
| Required DVNs | **2** — LayerZero Labs DVN + an independent DVN (e.g. a Stellar-ecosystem validator-run DVN) | Two independent attestations remove single-DVN trust; one being honest is insufficient, *both* required attestations must agree. |
| Optional DVNs | 1 (third-party, e.g. Google Cloud / Polyhedra) | Adds a tie-breaker / availability buffer. |
| Optional threshold | **1-of-1** | At least one optional must also attest, raising the bar to 3 distinct verifiers for the common path while not blocking on a single optional outage. |
| Block confirmations | 15 (Ethereum), provider-tuned for Base/Arbitrum | Source-finality safety vs. latency trade-off; reorg deeper than this would be required to forge. |

**On-chain enforcement mechanism.** The config is stored in the endpoint's
MessageLib, set by the OApp admin via `setConfig` (EVM) / the Soroban endpoint's
config setter. At delivery, the flow is:

1. Each configured DVN independently observes the source `PacketSent` and writes
   an attestation (the message hash + confirmations) to the destination
   MessageLib via `verify`.
2. `commitVerification` checks that **all required DVNs** and **≥ threshold
   optional DVNs** have attested the *same* payload hash at *≥* the required
   confirmations. Only then is the message marked verifiable.
3. `lz_receive` can be executed only for a committed message. The Perihelion
   contract does **not** re-implement DVN logic — it relies on the endpoint
   having enforced the ULN config, and adds the peer + nonce checks (§3.1).

The DVN addresses are **registered on-chain** in the MessageLib config; changing
them is an admin action gated by the same governance + timelock as other
privileged operations (§6 admin-key, §8 trust assumptions per phase).

### 3.3 Binary message payload specification

All payloads are the OApp `message` bytes that ride inside the LayerZero V2
packet envelope (the envelope itself carries `nonce`, `srcEid`, `sender`,
`dstEid`, `receiver`, `guid` and is not duplicated here). All integers are
**big-endian**. Addresses are 32 bytes: EVM addresses are left-padded to 32;
Stellar account/contract identifiers are the 32-byte strkey body. Amounts are
unsigned 128-bit in the asset's smallest unit.

**Common header (2 bytes):**

| Offset | Size | Field | Notes |
|--------|------|-------|-------|
| 0 | 1 | `version` | `0x01`. Bump on any breaking layout change; receivers reject unknown versions (`MalformedPayload`). |
| 1 | 1 | `msg_type` | `0x01` FillInstruction, `0x02` FillConfirmed, `0x03` CancelIntent. |

**`FillInstruction` (source → Stellar)** — registers a locked intent on Stellar.

| Offset | Size | Field | Description |
|--------|------|-------|-------------|
| 2 | 32 | `intent_hash` | EIP-712 id (I5). |
| 34 | 4 | `src_eid` | LayerZero eid of the locking chain (redundant with envelope; included for self-containment of the record). |
| 38 | 32 | `recipient` | Stellar recipient (strkey body). |
| 70 | 32 | `dest_asset` | Stellar Asset Contract address of the asset to deliver. |
| 102 | 16 | `min_dest_amount` | u128 slippage floor. |
| 118 | 8 | `deadline` | u64 unix seconds. |
| 126 | 32 | `preferred_solver` | Stellar address, or 32 zero bytes for open. |
| **158** | | **total** | |

**`FillConfirmed` (Stellar → source)** — authorizes solver payout on source.

| Offset | Size | Field | Description |
|--------|------|-------|-------------|
| 2 | 32 | `intent_hash` | Must match a live lock on the escrow. |
| 34 | 32 | `solver_evm` | Left-padded EVM payout address. |
| 66 | 16 | `fill_amount` | u128 delivered on Stellar (audit). |
| 82 | 8 | `fill_ledger` | u64 Stellar ledger seq (audit / dispute). |
| **90** | | **total** | |

**`CancelIntent` (either direction)** — instructs the receiver to unwind.

| Offset | Size | Field | Description |
|--------|------|-------|-------------|
| 2 | 32 | `intent_hash` | Intent to cancel. |
| 34 | 1 | `reason` | `0x00` deadline-expired, `0x01` admin, `0x02` invalid. |
| **35** | | **total** | |

> **Why a hand-rolled binary format instead of ABI/XDR encoding?** Cross-chain
> payloads must decode identically in Solidity and Rust with no shared codec.
> A fixed-offset binary layout is trivially and identically parseable on both
> sides (`abi.decode` of a packed struct on EVM; byte-slice reads on Soroban),
> has the smallest wire size (LZ fees scale with payload bytes), and removes any
> ABI/XDR version-skew risk. The cost is manual offset discipline, mitigated by
> exhaustive round-trip encode/decode tests on both chains (§7).

### 3.4 Nonce management — LayerZero vs. Perihelion

There are **two distinct nonce systems**, intentionally separate:

| Nonce | Layer | Purpose | Where stored |
|-------|-------|---------|--------------|
| **LayerZero pathway nonce** | Transport | Orders/deduplicates messages on a `(srcEid, sender, dstEid, receiver)` channel; assigned by the endpoint. | LZ endpoint + Perihelion `InboundNonce(eid)` high-water mark |
| **Perihelion intent nonce** | Application | Makes each user intent unique so two economically-identical intents have distinct hashes; part of the EIP-712 struct. | Embedded in `intent_hash`; never transmitted separately |

They are not unified because they answer different questions. The LZ nonce
answers "have I already processed this transport packet?"; the Perihelion intent
nonce answers "is this a distinct user order?". Conflating them would force one
LZ channel per intent (absurd) or make replay protection depend on transport
ordering (fragile). The **`intent_hash` is the application-level idempotency
key** (it commits the intent nonce), and the LZ nonce governs only transport.

### 3.5 Ordered vs. unordered delivery

LayerZero V2 supports **strict ordered** delivery (nonce *N* cannot execute until
*N−1* has) and **unordered** delivery (lazy nonce: any not-yet-seen nonce may
execute, with the endpoint tracking a max). **Perihelion uses unordered (lazy
nonce) delivery.**

**Rationale.** Intents are mutually independent — there is no causal ordering
between distinct users' fills. Strict ordering introduces **head-of-line
blocking**: a single stuck or slow message would halt settlement for *all*
subsequent intents on that pathway, directly harming liveness and solver
economics. Unordered delivery isolates failures to individual intents. Replay
safety does not depend on ordering — it is provided by the `intent_hash`
idempotency markers (I2) and the `accept_nonce` high-water check, which rejects
any nonce ≤ the recorded maximum:

```rust
fn accept_nonce(env: &Env, eid: u32, nonce: u64) -> Result<(), PerihelionError> {
    let key = DataKey::InboundNonce(eid);
    let hi: u64 = env.storage().persistent().get(&key).unwrap_or(0);
    // Lazy nonce: accept anything strictly greater than the high-water mark.
    // Equality/less means replay or out-of-window -> reject.
    if nonce <= hi {
        return Err(PerihelionError::StaleNonce);
    }
    env.storage().persistent().set(&key, &nonce);
    Ok(())
}
```

> The one place ordering *would* matter — cancel arriving before a late fill —
> is handled by terminal-state guards on both chains (§2.3, §4.3), not by
> transport ordering. This keeps the cheaper, more live unordered mode safe.

---

## 4. EVM Escrow Contract — Full Specification

The EVM escrow is the source-chain leg and a **LayerZero V2 OApp**. It (a) locks
the user's signed funds against `intent_hash`, (b) emits/sends `FillInstruction`
to Stellar, (c) on authenticated `FillConfirmed` releases the locked funds to the
solver, and (d) on `CancelIntent` (or local-timeout fallback) refunds the user.

### 4.1 Interface with NatSpec

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IPerihelionEscrow
/// @notice Source-chain escrow + LayerZero OApp for the Perihelion bridge.
/// @dev The EIP-712 domain/type MUST stay byte-identical to `@perihelion/sdk`
///      and `PerihelionEscrow.hashIntent` (Invariant I5).
interface IPerihelionEscrow {
    /// @notice User's signed cross-chain intent (matches the SDK's Intent type).
    struct Intent {
        address user;            // EIP-712 signer, funds source
        string  destination;     // Stellar recipient (strkey)
        uint256 sourceChainId;   // chain id user spends from
        address sourceAsset;     // ERC-20 spent
        uint256 sourceAmount;    // amount locked, smallest units
        string  destAsset;       // Stellar asset id ("native" | "CODE:ISSUER")
        uint256 minDestAmount;   // slippage floor on Stellar
        uint256 deadline;        // unix seconds; refundable after
        uint256 nonce;           // intent uniqueness (commits into hash)
        address preferredSolver; // exclusive solver, or address(0)
    }

    /// @notice Emitted when a solver locks a user's funds against an intent.
    /// @param intentHash EIP-712 id (I5).
    /// @param solver     Address that will be repaid on confirmed fill.
    /// @param user       Funds owner.
    /// @param asset      ERC-20 locked.
    /// @param amount     Amount actually received by escrow (post-transfer delta).
    event Locked(
        bytes32 indexed intentHash,
        address indexed solver,
        address indexed user,
        address asset,
        uint256 amount
    );

    /// @notice Emitted when locked funds are released to the solver.
    event Released(bytes32 indexed intentHash, address indexed solver, uint256 amount);

    /// @notice Emitted when locked funds are refunded to the user.
    event Refunded(bytes32 indexed intentHash, address indexed user, uint256 amount);

    /// @notice Solver claims an intent: verifies the user's signature, pulls
    ///         `sourceAmount`, and dispatches FillInstruction to Stellar.
    /// @dev User must have approved this contract. Reverts unless
    ///      `block.timestamp < deadline`, signature is valid, and the intent is
    ///      unlocked. Caller (msg.sender) becomes the solver-of-record.
    /// @param intent      The signed intent.
    /// @param signature   EIP-712 signature by `intent.user`.
    /// @param lzFee       Native fee forwarded to the endpoint for the send.
    function lock(Intent calldata intent, bytes calldata signature)
        external
        payable;

    /// @notice Compute the canonical intent hash (I5).
    function hashIntent(Intent calldata intent) external view returns (bytes32);

    /// @notice Permissionless local-timeout refund fallback (I4) used only if
    ///         the messaging layer fails to deliver a CancelIntent. Reverts if a
    ///         FillConfirmed already released the funds (§4.3 race guard).
    function cancelExpired(bytes32 intentHash) external;

    /// @notice View of a lock's status for the SDK/relayer.
    function lockOf(bytes32 intentHash)
        external
        view
        returns (
            address solver,
            address user,
            address asset,
            uint256 amount,
            uint256 deadline,
            bool released,
            bool refunded
        );
}
```

`_lzReceive` (the OApp override) is internal and dispatches inbound messages:

```solidity
/// @inheritdoc OAppReceiver
/// @dev Handles FillConfirmed (release to solver) and CancelIntent (refund).
function _lzReceive(
    Origin calldata _origin,
    bytes32 /*_guid*/,
    bytes calldata _message,
    address /*_executor*/,
    bytes calldata /*_extraData*/
) internal override {
    // OApp base already enforced msg.sender == endpoint and peer == _origin.sender.
    uint8 msgType = uint8(_message[1]);            // header: [version, type, ...]
    if (uint8(_message[0]) != PROTOCOL_VERSION) revert MalformedPayload();
    if (msgType == MSG_FILL_CONFIRMED) {
        _onFillConfirmed(_message);
    } else if (msgType == MSG_CANCEL_INTENT) {
        _onCancelIntent(_message);
    } else {
        revert UnknownMessageType();
    }
}
```

### 4.2 Locking mechanism, double-spend prevention, and the mapping choice

Locks are held in a single contract-level mapping:

```solidity
struct Lock {
    address solver;
    address user;
    address asset;
    uint256 amount;     // post-transfer measured amount (see §4.4)
    uint256 deadline;
    bool    released;
    bool    refunded;
}
mapping(bytes32 => Lock) public locks; // intentHash => Lock
```

**Double-spend / replay prevention.** `lock()` reverts if `locks[hash].user != 0`
(already locked), and the terminal booleans `released`/`refunded` are checked-then-set
under the checks-effects-interactions pattern so each lock can transition to a
terminal state exactly once (I2). The `intent_hash` includes the user's `nonce`,
so re-signing the "same" economic order produces a different hash and cannot
collide with a still-open lock.

**Why one mapping instead of a vault contract per intent?** Three designs were
weighed:

- *Per-intent vault clone (rejected):* deploying a minimal-proxy escrow per
  intent gives perfect isolation but costs ~40–55k gas per `CREATE2` deploy on
  top of the transfer, dominates the lock cost, and complicates indexing. The
  isolation benefit is illusory here because funds are fungible ERC-20 held by
  the protocol regardless.
- *Single pooled balance, no per-intent accounting (rejected):* cheapest, but
  loses the per-intent `amount`/`deadline`/`solver` needed for correct release
  and refund, and makes fee-on-transfer accounting impossible.
- *Single contract, `mapping(bytes32 => Lock)` (chosen):* O(1) storage per intent
  (~3 SSTORE for a fresh lock), trivial idempotency via the struct's terminal
  flags, and natural keying by the protocol-wide `intent_hash`. Isolation is
  enforced logically (each release/refund touches exactly one key) rather than
  by deployment.

### 4.3 `cancelExpired` with the late-confirmation race guard

`cancelExpired` is the **liveness fallback** (I4) for when the messaging layer
fails to deliver a `CancelIntent`. Its critical correctness condition: it must
**not** refund the user if the funds were (or are about to be) released to a
solver. Because `_lzReceive(FillConfirmed)` and `cancelExpired` can be mined in
either order, the guard is a strict check on the same terminal flags both paths
mutate, under checks-effects-interactions.

```solidity
error NotLocked();
error AlreadyFinalized();
error DeadlineNotPassed();

/// @notice Refund the user after the deadline IF no release has occurred.
/// @dev Permissionless. The `released` check is the race guard: a FillConfirmed
///      that lands first sets `released=true` and makes this revert; a refund
///      that lands first sets `refunded=true` and makes a later FillConfirmed
///      hit AlreadyFinalized in `_onFillConfirmed`. Exactly one terminal path
///      wins (I1 + I2).
function cancelExpired(bytes32 intentHash) external {
    Lock storage l = locks[intentHash];
    if (l.user == address(0)) revert NotLocked();
    if (l.released || l.refunded) revert AlreadyFinalized(); // race guard
    if (block.timestamp < l.deadline) revert DeadlineNotPassed();

    // EFFECTS before INTERACTION (CEI): set terminal flag, then transfer.
    l.refunded = true;
    address user = l.user;
    address asset = l.asset;
    uint256 amount = l.amount;

    // INTERACTION
    _safeTransfer(asset, user, amount);
    emit Refunded(intentHash, user, amount);
}

/// @dev Symmetric guard on the message path.
function _onFillConfirmed(bytes calldata message) internal {
    (bytes32 intentHash, address solverEvm /*, ...*/) = _decodeFillConfirmed(message);
    Lock storage l = locks[intentHash];
    if (l.user == address(0)) revert NotLocked();
    if (l.released || l.refunded) revert AlreadyFinalized(); // mirror race guard

    l.released = true;
    uint256 amount = l.amount;
    address asset = l.asset;
    _safeTransfer(asset, solverEvm, amount);
    emit Released(intentHash, solverEvm, amount);
}
```

**Why keep both the message-driven cancel *and* the local-timeout fallback?**
The message-driven cancel (from Stellar) is authoritative and correct in the
common case. The local fallback exists solely for **censorship/outage
resistance**: if DVNs or the relayer are down indefinitely, the user must still
recover funds. The fallback is safe because it shares the exact terminal-flag
guard with the release path; the only requirement is that `deadline` on the EVM
side is set to the *same* value committed in the intent, with enough margin that
a legitimately in-flight fill confirmation is not racing a premature refund. We
add a protocol-level `CONFIRMATION_GRACE` so `cancelExpired` is only callable at
`deadline + CONFIRMATION_GRACE`, giving an honest FillConfirmed time to land
first. **[PROPOSED]** value: `CONFIRMATION_GRACE = 2 hours`, tunable by governance.

### 4.4 Non-standard ERC-20 handling

The escrow makes **no assumption** about token conformance. Three classes are
handled explicitly:

- **Fee-on-transfer / rebasing:** the locked `amount` is the **measured balance
  delta**, not the requested amount. `lock()` records
  `received = balanceAfter - balanceBefore` and stores `received` in the Lock, so
  release/refund move exactly what the escrow holds — never more.
  ```solidity
  uint256 balBefore = IERC20(intent.sourceAsset).balanceOf(address(this));
  _safeTransferFrom(intent.sourceAsset, intent.user, address(this), intent.sourceAmount);
  uint256 received = IERC20(intent.sourceAsset).balanceOf(address(this)) - balBefore;
  // `received` (not sourceAmount) is the authoritative locked amount.
  ```
  The solver prices off `received` (surfaced in the `Locked` event), so a
  fee-on-transfer token simply yields a smaller effective lock; the solver
  decides whether the spread still clears.
- **Non-18 decimals:** the contract stores raw smallest-unit integers and never
  scales by `1e18`. Decimal reconciliation between the source asset and the
  Stellar asset (typically 7 dp) is an **off-chain solver/pricing concern**
  carried in `minDestAmount`; the contract is decimal-agnostic.
- **Booleans-vs-revert (USDT-style):** all token calls go through a SafeERC20
  wrapper that treats a missing return value as success and a `false` return as
  failure, reverting with a typed error:
  ```solidity
  error TransferFailed();
  function _safeTransfer(address t, address to, uint256 v) private {
      (bool ok, bytes memory data) = t.call(abi.encodeWithSelector(IERC20.transfer.selector, to, v));
      if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
  }
  ```

**Reentrancy.** All external token interactions follow checks-effects-interactions
(terminal flags set before transfers) and the state-mutating externals
(`lock`, `cancelExpired`, `_lzReceive`) carry a `nonReentrant` guard.
Combined with measured-delta accounting, a malicious token's reentrant callback
finds the lock already in its terminal state and cannot double-release.

---

## 5. Solver Economics — Formal Model

### 5.1 Profitability and the minimum viable spread

Let a single intent have source notional `V` (in a common numéraire, e.g. USD).
Define per-fill costs:

| Symbol | Meaning |
|--------|---------|
| `G_fill` | Soroban cost of `fill_intent` (gas + token transfer), ≈ negligible (§1.6) |
| `F_lz` | LayerZero fee for the FillConfirmed message (native gas at destination + DVN + executor) — **dominant cost** |
| `G_src` | EVM gas for the eventual `_lzReceive`/release (often executor-paid, but reserve for) |
| `c` | solver's cost of capital, annualized (e.g. 0.10 = 10 %/yr) |
| `T` | settlement latency (lock → release), in years |
| `R` | risk premium per fill (reorg, price drift, failed-message tail risk) |

A fill is profitable iff the captured spread `s·V` (where `s` is the fractional
spread between what the user offered on the source and what the solver delivers
on Stellar) exceeds total cost:

```
s · V  ≥  G_fill + F_lz + G_src + c · V · T + R
```

Solving for the **minimum viable spread**:

```
            G_fill + F_lz + G_src + R        c · V · T
  s_min  =  ────────────────────────────  +  ─────────
                        V                         V

         =  (fixed costs) / V   +   c · T
```

Two regimes follow directly:

- **Fixed-cost-dominated (small V):** `s_min ≈ (F_lz + R)/V`. Because `F_lz` is
  roughly constant per message, `s_min` falls hyperbolically with size — there is
  a **minimum economical intent size** `V_min` below which no honest spread
  clears. The SDK should warn users when `V < V_min(F_lz)`.
- **Capital-cost-dominated (large V, slow settlement):** `s_min ≈ c·T`. With
  sub-minute LayerZero settlement, `T` is tiny, so even at `c = 15 %/yr` the
  capital term is on the order of 10⁻⁵ — negligible. This is the structural
  advantage of fast finality: Perihelion's spreads are dominated by fixed
  messaging cost, not inventory cost.

### 5.2 Capital efficiency, turnover, risk-adjusted return

- **Capital efficiency ratio** `CE = annualized_filled_volume / deployed_inventory`.
  Higher is better; bounded above by how fast the solver can recycle inventory,
  i.e. by settlement latency `T`: `CE_max ≈ 1 / T` per unit of inventory. Fast
  finality (small `T`) is what makes a small inventory service large volume.
- **Inventory turnover** `τ = volume_over_period / average_inventory`. With
  settlement `T` and full utilization, `τ ≈ period / T`. A 30 s round-trip
  implies a theoretical `τ ≈ 86,400` per month per asset before rebalancing
  friction; realistic `τ` is bounded by rebalancing latency, not settlement.
- **Risk-adjusted return** (mean-variance form):
  `RAR = E[profit] − λ · σ(profit)`, where `λ` is the solver's risk aversion and
  `σ(profit)` captures spread variance from price drift during `T`, failed-message
  tail events, and reorg exposure. Solvers set `minMarginBps` (the
  `quote.ts` threshold in the reference node) so that expected margin exceeds
  `λ·σ`; the reference default (15 bps) is a conservative starting point pending
  live variance data.

### 5.3 Game theory of simultaneous fills

Two solvers may attempt to fill the same `Locked` intent. The race is resolved
**on Stellar, atomically**, with no loss to the loser beyond gas:

1. Both submit `fill_intent(intent_hash)`. Soroban serializes them across
   ledgers; one is applied first.
2. The **winner**'s call passes the `status == Locked` check (step 5 of §1.4),
   flips status to `Filled`, writes the `Settled` marker, and *then* transfers
   its inventory and dispatches FillConfirmed.
3. The **loser**'s call now sees `status != Locked` (or the `Settled` marker) and
   reverts with `AlreadyFilled` **before** its `token.transfer` executes. Because
   the transfer is downstream of the guard and Soroban transactions are atomic,
   the loser's inventory **never moves**. The loser pays only Soroban gas
   (fractions of a cent) — no inventory, no LZ fee (the send is also downstream
   of the guard).

This is the key economic safety property (I3): **fill races are gas-races, not
inventory-races.** It is safe to let solvers compete openly without locking,
because the on-chain guard makes losing cheap and bounded. Compare alternatives:

- *On-chain auction / explicit claim-then-fill (rejected for v1):* a solver first
  claims (reserves) then fills. Removes the wasted-gas race but adds a round-trip
  of latency and a griefing surface (claim-and-don't-fill). The **[PROPOSED]**
  Temporary-storage soft reservation (§1.1) is an *optional* optimization solvers
  may use to avoid colliding, but it is advisory — the atomic guard remains the
  authority.
- *First-seen-in-mempool priority (rejected):* unenforceable and MEV-prone.

`preferredSolver` exists for users who want a private quote: it disables the race
entirely for that intent by restricting `fill_intent` to one address (step 7,
§1.4).

### 5.4 Capital requirements to participate

| Requirement | Driver | Indicative figure |
|-------------|--------|-------------------|
| **Minimum inventory per supported Stellar asset** | Must cover the largest fill the solver wants to serve, times concurrent-in-flight count. | e.g. to serve up to \$50k fills with 4 in flight: ~\$200k per asset. |
| **Source-chain gas reserve** | Native token on each source chain for any solver-paid release ops. | small; mostly executor-paid. |
| **Native fee balance for LZ sends** | Each fill dispatches a FillConfirmed paid in destination native. | a rolling buffer sized to fills/hour × `F_lz`. |
| **Rebalancing** | Inventory drains toward the destination; must be cycled back across chains. | frequency set by `τ` and inventory size; CEX or canonical-bridge rails. |
| **RPC / infra** | Mempool polling, Stellar RPC, EVM RPC, LZ scan. | commodity; \$100s/mo. |

Operating cost per fill is dominated by `F_lz`; the reference solver's
`evaluate()` already encodes the `minMarginBps` gate that must exceed
`(F_lz + R)/V` for the served size band.

### 5.5 Solver reputation **[PROPOSED — Phase 3]**

> This subsection is a proposed Phase-3 addition; it is **not** part of the
> confirmed v1/v2 design.

A reputation system would prioritize reliable solvers for `preferredSolver`
routing and (optionally) reduced bonding:

- **Tracked metrics:** fill success rate, median fill latency, over-delivery
  ratio (delivered/`minDestAmount`), and confirmed-without-dispute rate.
- **On-chain storage:** an aggregate per-solver record (counts + EWMA latency) in
  Persistent storage keyed by solver address, updated in `fill_intent` and on
  confirmed release. Only monotone counters and bounded EWMAs are stored on-chain;
  raw history stays off-chain/indexed.
- **Effect on priority:** the off-chain mempool surfaces a reputation-weighted
  ordering to users; on-chain, high-reputation solvers could be granted a short
  exclusive-fill window via the existing `preferredSolver` mechanism (a
  reputation-gated soft reservation), preserving permissionlessness for everyone
  else after the window.

---

## 6. Security Model — Threat Matrix

Impact/likelihood are pre-mitigation. **Residual risk** is post-mitigation.

| # | Attack | Vector | Impact | Likelihood | Mitigation | Residual |
|---|--------|--------|--------|------------|------------|----------|
| T1 | **Intent replay** | Re-submit a signed intent or re-deliver a LZ message to double-settle | High | Med | `intent_hash` idempotency markers on both chains (I2); lazy-nonce high-water (§3.4); EVM terminal flags | Low |
| T2 | **Solver front-running** | Observe a pending fill and race it | Low | High | Fill races are atomic gas-races, not inventory-races (§5.3); loser loses only gas | Low |
| T3 | **LayerZero DVN compromise** | Malicious/colluding DVNs forge a FillConfirmed to release escrow with no real Stellar fill | High | Low | 2 required + 1 optional independent DVNs (§3.2); peer check; **[PROPOSED]** Phase-3 ZK state proof removes DVN trust for the release path (§8.3) | Med→Low |
| T4 | **Griefing via expired intents** | Spam intents that never fill, bloating state / locking user funds | Med | Med | Permissionless `cancel_expired_intent`/`cancelExpired` (I4) frees funds; Temporary tier for soft reservations; deadline-gated cancel prevents cancelling live intents | Low |
| T5 | **EVM escrow reentrancy** | Malicious token reenters during transfer to double-release | High | Low | CEI (terminal flag before transfer) + `nonReentrant` + measured-delta accounting (§4.4) | Low |
| T6 | **Soroban archival of critical state** | Let a `Settled`/`Cancelled` marker archive to re-open a fill | High | Low | Markers bumped to `max_entry_ttl`; markers outlive records; restore-then-act in relayer (§1.7) | Low |
| T7 | **Malicious solver fills with wrong asset** | Deliver a worthless token instead of `dest_asset` | High | Med | `fill_intent` reads `dest_asset` from the *registered* IntentRecord and transfers exactly that SAC; solver cannot substitute (§1.4 step 10) | Low |
| T8 | **Oracle manipulation** (if price feeds used) | Skew SEP-40 oracle to mis-settle | Med | Low | Settlement floor is the user-signed `min_dest_amount`, not an oracle; oracle only sanity-checks. Use median-of-feeds + staleness bound | Low |
| T9 | **Dust attack on solver inventory** | Flood tiny intents to exhaust solver native-fee balance | Low | Med | `V_min` economical-size gate (§5.1); solver `minMarginBps` rejects sub-economical fills | Low |
| T10 | **Admin key compromise** | Steal admin to rotate endpoint/peer or unpause maliciously | High | Low | Multisig + timelock on admin; pause is fail-safe (halts, cannot move funds); endpoint/peer changes time-locked; Phase-based decentralization (§8) | Med→Low |

### 6.1 Detailed mitigations for High-impact attacks

**T1 — Intent replay.** Three independent layers: (i) on Stellar, the
`Settled(hash)`/`Cancelled(hash)` Persistent markers make any second `fill`/`cancel`
revert with `IntentFinalized`, and these markers are bumped to `max_entry_ttl` so
they cannot be archived away (T6 linkage); (ii) the lazy-nonce high-water mark
rejects any LZ packet with `nonce ≤ max_seen`; (iii) on EVM, `locks[hash]` plus
the `released`/`refunded` terminal booleans permit exactly one terminal
transition. An attacker must defeat all three on two chains.

**T3 — DVN compromise.** The release of escrowed funds is authorized only by a
`FillConfirmed` that the destination MessageLib accepts, which requires **both**
required DVNs plus **≥1 optional** DVN to attest the identical payload hash at
≥15 confirmations (§3.2). Forgery requires colluding across organizationally
independent DVN operators *and* deep source reorg. The peer check ensures even a
forged-transport message from a non-escrow sender is rejected. **[PROPOSED]**
Phase 3 replaces DVN trust on the most sensitive path (escrow release) with an
on-chain ZK proof of the Stellar fill / EVM lock (§8.3), reducing T3 to the
soundness of the proof system.

**T5 — Escrow reentrancy.** `_onFillConfirmed`, `cancelExpired`, and `lock` set
the terminal flag (`released`/`refunded`) *before* any `_safeTransfer`, so a
reentrant callback from a malicious token observes the already-finalized state
and reverts with `AlreadyFinalized`. `nonReentrant` is belt-and-suspenders.
Measured-delta accounting (§4.4) additionally bounds any token-side trickery to
the actual balance held.

**T6 — Archival of critical state.** The danger is *deletion* of a replay guard.
We never store guards in Temporary; `Settled`/`Cancelled` markers are Persistent
and bumped to `max_entry_ttl`, and they are *separate* from the (shorter-lived)
`IntentRecord` precisely so that even if the verbose record archives, the boolean
guard survives. Restoration of an archived record is a liveness action handled by
the relayer/keeper; it never resurrects a spent intent because the guard blocks
it.

**T7 — Wrong-asset fill.** `fill_intent` does not accept an asset argument from
the solver. It reads `dest_asset` from the IntentRecord that was registered by
the authenticated `FillInstruction`, and transfers exactly that SAC. The solver
chooses only `fill_amount` (bounded below by `min_dest_amount`). Substituting a
different or worthless token is impossible without forging the FillInstruction,
which is gated by the DVN set (T3) and peer check.

**T10 — Admin key compromise.** Admin powers are deliberately minimal and
non-custodial: admin can pause (fail-safe; pausing cannot move funds), rotate the
endpoint/peer, and (Phase-gated) upgrade. All privileged mutations are behind a
multisig + timelock so a single compromised key cannot act instantly, giving the
community a window to respond. The contract holds no admin-withdrawable balance
path — there is no `sweep`/`drain` function — so even a fully compromised admin
cannot directly steal locked user funds; the worst case is a denial-of-service
(pause) bounded by the decentralization roadmap (§8).

---

## 7. Testing Strategy

### 7.1 The testing pyramid

```
                  ┌─────────────────────────────┐
                  │  E2E cross-chain (public     │   few, slow, expensive
                  │  testnet: Sepolia/Base-      │   — full LZ path, real DVNs
                  │  Sepolia ↔ Stellar testnet)  │
                  ├─────────────────────────────┤
                  │  Integration (local)         │   moderate
                  │  Anvil + Soroban local +     │   — mocked LZ endpoint,
                  │  mock LZ endpoint + relayer   │     real contracts & node
                  ├─────────────────────────────┤
                  │  Unit                        │   many, fast, deterministic
                  │  Soroban testutils (Rust),   │   — pure contract logic,
                  │  Foundry (Solidity), node:test│     no network
                  └─────────────────────────────┘
```

- **Unit (Rust / Soroban `testutils`):** every contract function, every error
  branch, every state transition, run in-process with `Env::default()` and
  `mock_all_auths()`. This is where invariant coverage lives. Already seeded in
  `contracts/soroban/settlement/src/test.rs`.
- **Unit (Solidity / Foundry):** escrow logic, signature recovery, non-standard
  token classes (mock fee-on-transfer, false-returning, non-18-decimals),
  reentrancy attempts via a malicious-token harness, fuzz tests on amounts and
  deadlines. Seeded in `contracts/evm/test/PerihelionEscrow.t.sol`.
- **Unit (TypeScript / `node:test`):** SDK hashing/signing parity, solver
  `evaluate()` decision table, relayer confirmation-depth + replay logic. Seeded
  in the workspace test suites.
- **Integration (local):** Anvil for EVM, a local Soroban instance, the **mock LZ
  endpoint** (§7.3) bridging them, and the real relayer + solver nodes. Asserts
  the full happy path and each failure-recovery path (§2.3) end to end without
  public-testnet flakiness.
- **E2E (public testnet):** the real LayerZero stack with real DVNs across
  Sepolia/Base-Sepolia and Stellar testnet. Few, scripted, run in CI nightly and
  before each release tag. Validates DVN config, executor behavior, and real fee
  estimation.

### 7.2 Critical-invariant test specifications

The five most safety-critical invariants in the settlement contract, as concrete
test cases (specifications, not code):

1. **No double-settlement (I2).**
   *Setup:* register an intent (FillInstruction), fill it once successfully.
   *Action:* call `fill_intent` again with the same hash from a different solver.
   *Expect:* revert `AlreadyFilled`; recipient balance unchanged from the first
   fill; `Settled` marker present; second solver's inventory untouched.
   *Variant:* archive the `IntentRecord` (advance ledgers past its TTL) but keep
   the `Settled` marker; re-attempt fill ⇒ still `IntentFinalized`.

2. **Fill race loses only gas, never inventory (I3, §5.3).**
   *Setup:* one registered intent; two solvers with known inventories.
   *Action:* simulate solver A's fill applied, then solver B's fill in the next
   ledger.
   *Expect:* A's inventory decreased by `fill_amount`; **B's inventory exactly
   unchanged**; B's call reverted before its `token.transfer`.

3. **Slippage floor is enforced (I1 dest half).**
   *Setup:* intent with `min_dest_amount = X`.
   *Action:* `fill_intent` with `fill_amount = X − 1`.
   *Expect:* revert `InsufficientFillAmount`; no transfer; status still `Locked`.
   *Boundary:* `fill_amount = X` succeeds; `fill_amount = 0` ⇒ `InvalidAmount`.

4. **Deadline boundary governs fill vs. cancel.**
   *Setup:* intent with `deadline = D`.
   *Action A:* set ledger timestamp `= D − 1`, `fill_intent` ⇒ succeeds.
   *Action B:* set ledger timestamp `= D`, `fill_intent` ⇒ revert `IntentExpired`;
   `cancel_expired_intent` ⇒ succeeds, dispatches CancelIntent, sets `Cancelled`.
   *Cross-check:* a `Filled` intent can never be cancelled (call cancel after a
   successful fill ⇒ `IntentFinalized`).

5. **Only the endpoint + registered peer can drive `lz_receive`.**
   *Setup:* configure endpoint E and peer P for eid N.
   *Action A:* call `lz_receive` authorized by an address ≠ E ⇒ auth failure.
   *Action B:* call authorized by E but with `origin.sender ≠ P` ⇒ `UntrustedPeer`.
   *Action C:* valid E + P but `origin.nonce ≤ high-water` ⇒ `StaleNonce`.

Each case is mirrored where applicable on the EVM side (Foundry): release-once,
refund-once, the late-confirmation race guard (`cancelExpired` after a
`FillConfirmed` reverts `AlreadyFinalized` and vice-versa), and signature
tampering.

### 7.3 Mocking LayerZero in the Soroban test environment

Unit and local-integration tests cannot use real DVNs. We provide a **mock
endpoint contract** that implements the minimal surface the Perihelion OApp
depends on, and *simulates* DVN verification deterministically:

The mock endpoint must implement:

- **`send(params, refund_address, fee)`** — record the outbound `MessagingParams`
  (dst_eid, receiver, message, options) into Temporary/Instance storage and emit
  an event, so tests can assert "a FillConfirmed/CancelIntent with payload X was
  dispatched to peer Y". It returns a synthetic `MessagingReceipt { guid, nonce, fee }`.
- **`deliver(target, origin, guid, message)`** (test-only) — directly
  cross-contract-invokes the target OApp's `lz_receive`, **authorizing as the
  endpoint** (`env.mock_all_auths()` or scoped auth), thereby simulating the
  point where a message has *already* passed DVN verification. This is the seam
  that replaces the real DVN/commit step.
- **`set_verifiable(guid, bool)`** (test-only) — to simulate DVN **failure**: a
  test can mark a message non-verifiable and assert that `deliver` refuses,
  exercising the dropped-message recovery paths (§2.3).

What the mock deliberately does **not** do: real signature/attestation crypto.
DVN quorum correctness is the endpoint's responsibility and is validated at the
E2E tier against the real stack; the mock asserts only that *Perihelion behaves
correctly given* a verified-or-not verdict. This keeps unit tests fast and
focused on Perihelion's own invariants.

A symmetric mock OApp/endpoint exists on the Foundry side (a `MockLZEndpoint`
that lets tests call `_lzReceive` with arbitrary `Origin`/payload after enforcing
the peer/sender checks), so the EVM escrow's message handlers are unit-testable
without LayerZero deployed.

### 7.4 Chaos testing the solver node

The solver is a long-running off-chain process; correctness under partial failure
matters as much as the happy path. Injected scenarios and expected behavior:

| Injected failure | Expectation |
|------------------|-------------|
| Mempool/RPC returns 5xx or times out | Node logs, backs off, retries; does **not** crash or skip the next poll permanently. |
| Stellar RPC drops mid-`fill_intent` submission | Node treats outcome as unknown; on recovery it **re-queries** the intent status (idempotent) before any retry — never blindly re-fills (would just revert `AlreadyFilled`, but wastes gas). |
| LZ fee spikes above the configured ceiling | Node declines the fill (margin gate, §5.1), logs the skip; no partial action. |
| Two solver instances of the same operator race themselves | At most one fills; the other reverts `AlreadyFilled` losing only gas; node deduplicates via the soft-reservation **[PROPOSED]** or local in-flight set. |
| Clock skew between node and ledger | Deadlines evaluated against `ledger().timestamp()` on-chain, so a skewed node may *attempt* a late fill but the contract rejects it safely. |
| Process kill between fill and confirm-resend | On restart, node scans `Filled`-but-not-`ConfirmationSent`/unpaid intents and re-dispatches FillConfirmed (idempotent release guard). |

**Monitoring required:** per-fill latency histogram, fill-success vs. revert
counts by error code, native-fee balance gauges per chain (page before depletion),
inventory gauges per asset (page before a fill would underflow), LZ message
delivery lag, and a reconciliation job that flags any `Filled` intent unpaid
beyond an SLA (indicates a stuck FillConfirmed needing resend).

---

## 8. Phased Rollout

Each phase fixes *what is deployed*, *what is centralized vs. decentralized*, the
*trust assumptions*, and the *audit gate* that must pass before advancing.

### 8.1 Phase 1 — Guarded mainnet-beta (single-route, trusted operators)

**Deployed:** Soroban settlement contract (Stellar mainnet), EVM escrow on **one**
source chain (Base), SDK, reference solver, reference relayer. One asset corridor
(USDC EVM → USDC Stellar).

**Centralized vs. decentralized:**

- *Centralized in Phase 1:* the solver set is an **allowlist** (operators known
  to the team); the relayer/keeper is run by the team; admin is a team multisig
  with timelock; the protocol can be paused.
- *Decentralized already:* users self-custody until lock; intents are openly
  signed; the cancel/refund paths are permissionless (I4) even in Phase 1, so the
  team cannot strand user funds.

**Trust assumptions:** users trust (a) the DVN set (§3.2), (b) the allowlisted
solvers to be live (not for safety — a dead solver just means no fill and an
eventual refund), and (c) the admin multisig not to grief via pause. No trust in
any single relayer (permissionless fallback).

**Milestones / acceptance criteria (measurable):**

- M1.1 100 % of §7.2 invariant tests green in CI; ≥90 % line / ≥80 % branch
  coverage on both contracts.
- M1.2 ≥1,000 successful E2E fills on public testnet with zero invariant
  violations and zero stuck-unpaid intents beyond SLA.
- M1.3 Mean settlement latency < 60 s; p99 < 5 min on testnet.
- M1.4 Mainnet caps enforced in-contract: per-intent and aggregate **value caps**
  (a circuit breaker limiting blast radius during beta).

**Audit gate to exit Phase 1:** one full external audit of both contracts +
the LZ message handling, all High/Critical findings resolved and re-reviewed;
public report; a bug-bounty live for ≥30 days before raising value caps.

### 8.2 Phase 2 — Multi-route, permissionless solvers

**Deployed:** EVM escrow on Ethereum + Arbitrum (added to Base); additional asset
corridors (EURC, and RWA stablecoins as issuers opt in); permissionless solver
registration; raised/removed value caps.

**Centralized vs. decentralized:**

- *Decentralized now:* **anyone** can run a solver (allowlist removed);
  **anyone** can run a relayer/keeper (the reference impls become one of many);
  DVN set may expand.
- *Still centralized:* admin multisig retains pause + config + (time-locked)
  upgrade authority; this is the last major centralization to be addressed in
  Phase 3 governance.

**Trust assumptions:** reduced — no trust in any specific solver or relayer.
Remaining trust: DVN set and the admin multisig (now behind a longer timelock and
published governance process).

**Milestones / acceptance criteria:**

- M2.1 ≥3 independent solver operators filling on mainnet; no single solver
  > 50 % of volume over a rolling 30-day window (decentralization metric).
- M2.2 ≥2 independent relayer/keeper operators; demonstrated recovery from a
  primary-relayer outage with no user-fund impact.
- M2.3 Cross-chain reconciliation dashboard public; zero unresolved
  fund-discrepancy incidents.
- M2.4 Per-corridor value caps removed after corridor-specific bounty period.

**Audit gate to exit Phase 2:** a second audit focused on the multi-route /
permissionless-solver surface and any new asset adapters; formal-methods or
spec-level review of the state machine (§2); governance/timelock review.

### 8.3 Phase 3 — Trust-minimized verification (ZK) **[PROPOSED]**

> Phase 3 is roadmap. The ZK path below is **[PROPOSED]** and contingent on the
> exact host functions Stellar Protocol 24 exposes.

**Goal:** remove DVN trust from the most sensitive path — the **escrow release** —
by having the destination verify a succinct proof of source/destination state
rather than trusting attestations (mitigating T3 to proof-system soundness).

**What is proven.** For the EVM→Stellar release direction, the claim to verify on
Soroban is: *"At a finalized EVM block with state root `S`, the escrow contract
`E` has `locks[intent_hash]` populated with `(asset, amount, deadline)`."* This is
a **Merkle-Patricia storage-inclusion** statement:

1. Prove an account-trie inclusion of `E`'s account (yielding `E`'s storageRoot)
   under state root `S`.
2. Prove a storage-trie inclusion of the slot(s) for `locks[intent_hash]` under
   that storageRoot, yielding the locked tuple.
3. Bind `S` to a finalized block — either via a header accumulator the contract
   tracks, or (stronger) a proof that `S` is in a block with sufficient
   finality, anchored by a light-client commitment.

**How it is verified on Soroban.** Steps 1–2 (MPT/keccak inclusion) are expressed
as an arithmetic circuit and proven with a pairing-based SNARK (e.g. Groth16 or
PLONK over **BN254**). The Soroban contract runs the **verifier**: using Protocol
24's BN254 host functions (curve arithmetic + pairing), it checks the proof
against on-chain **public inputs** `{ intent_hash, src_eid, E, S, asset, amount, deadline }`.
Only on a valid proof does it treat the lock as established. The header→`S` binding
(step 3) is the residual trust to minimize; options under evaluation: a
permissionless header relay with fraud proofs, or a succinct consensus proof.

**Why BN254 specifically.** Per the project's Protocol-24 target. If Protocol 24
ships BLS12-381 host functions instead/also (as earlier CAPs suggested), the
verifier would target BLS12-381 with no change to the architecture — only the
curve and proving key differ. The choice is an implementation detail gated on the
final host-function set; the document fixes the *structure*, not the curve.

**Acceptance criteria (proposed):** verifier gas within Soroban's per-tx
instruction budget for a single proof; proof generation < settlement SLA;
end-to-end demonstration of a release authorized solely by a ZK proof with the
DVN path disabled on a testnet corridor.

**Governance at Phase 3:** admin powers migrate to on-chain governance (or are
renounced for the core settlement logic, retaining only an emergency pause behind
a broad multisig with a short, public timelock).

---

## 9. Contribution Guide for Drips Wave

Perihelion is structured so each Drips Wave sprint cycle has a prioritized,
clearly-scoped issue set across all four skill tracks. This section defines how
contributions are categorized, reviewed, merged, and how contributors graduate.

### 9.1 Issue taxonomy

Every issue is labeled on three axes:

- **Skill:** `rust/soroban`, `solidity`, `typescript`, `docs`.
- **Complexity:** `S` (a few hours, well-bounded), `M` (1–3 days, some design),
  `L` (multi-day, design + review-heavy).
- **Wave:** `wave-1`, `wave-2`, `wave-3` (targeted cycle).

### 9.2 Planned issues by track, complexity, and Wave

> Indicative backlog; the live source of truth is the GitHub issue tracker. Items
> touching **[PROPOSED]** features are marked.

**Wave 1 — harden the confirmed core**

| Skill | Complexity | Issue |
|-------|-----------|-------|
| rust/soroban | M | Implement `IntentRecord` + `DataKey` per §1.2; migrate scaffold's minimal storage |
| rust/soroban | L | Implement `fill_intent` per §1.4 with full invariant tests (§7.2 #1–#4) |
| rust/soroban | M | Implement `cancel_expired_intent` per §1.5 + deadline-boundary tests |
| rust/soroban | S | Add the complete `PerihelionError` enum (§1.3) and map all reverts to it |
| solidity | M | Add measured-delta accounting + SafeERC20 wrapper (§4.4) with mock-token tests |
| solidity | M | Implement `cancelExpired` race guard (§4.3) + Foundry race tests |
| typescript | S | SDK: surface `V_min` economical-size warning (§5.1) |
| typescript | M | Mock LZ endpoint for local integration (§7.3) |
| docs | S | Keep `intent-spec.md` ⇔ EVM/SDK EIP-712 in lockstep (I5 checklist) |

**Wave 2 — messaging + multi-route**

| Skill | Complexity | Issue |
|-------|-----------|-------|
| rust/soroban | L | OApp `lz_receive` + peer/nonce checks (§3.1, §3.4) against the mock endpoint |
| rust/soroban | M | Binary payload encode/decode for all three message types (§3.3) + round-trip tests |
| solidity | L | Wire escrow as a real LZ OApp (`_lzSend`/`_lzReceive`) + DVN config scripts (§3.2) |
| typescript | M | Relayer: restore-then-act flow for archived entries (§1.7) |
| typescript | M | Solver chaos-test harness (§7.4) + monitoring metrics |
| typescript | M | SDK: `waitForSettlement` across the real two-message flow |
| docs | S | Operator runbook: running a relayer/keeper, fee-balance alerting |

**Wave 3 — decentralization + [PROPOSED] research**

| Skill | Complexity | Issue |
|-------|-----------|-------|
| rust/soroban | L | **[PROPOSED]** solver reputation storage + EWMA (§5.5) |
| rust/soroban | L | **[PROPOSED]** BN254 Groth16 verifier skeleton + MPT-inclusion circuit interface (§8.3) |
| solidity | M | Permissionless solver registration + value-cap removal gating (§8.2) |
| typescript | M | Multi-relayer coordination / leader-election-free dedup |
| docs | M | ZK verification design note + threat re-analysis of T3 under §8.3 |

### 9.3 PR review process & merge criteria

1. **Claim an issue** by commenting; a maintainer assigns it (avoids duplicate
   work within a Wave).
2. **Branch + PR** referencing the issue. PRs must:
   - include tests for any behavior change (contracts: Foundry/`testutils`;
     TS: `node:test`), and keep the relevant §7.2 invariants green;
   - pass CI: `npm test`, `cargo test`, `forge test`, lints, and the EIP-712
     parity check (I5) for any change touching intent encoding;
   - update docs in the same PR when behavior or interfaces change (the spec and
     code move together).
3. **Review** by ≥1 maintainer for `S`, ≥2 for `M`/`L`. Contract-logic PRs
   require a maintainer from the relevant chain track. Reviewers check against the
   **design invariants (§0)** explicitly — a PR that could violate I1–I5 is
   blocked regardless of test status.
4. **Merge criteria:** all CI green, required approvals, no unresolved review
   threads, and — for anything in `contracts/` — a note on resource/fee impact
   (§1.6) and on whether the change needs an audit-gate (§8) before mainnet.

### 9.4 Graduating from contributor to core contributor

A tiered path with explicit, observable criteria:

| Tier | Criteria | Rights |
|------|----------|--------|
| **Contributor** | ≥1 merged PR | Listed in contributors; can claim issues |
| **Trusted contributor** | ≥5 merged PRs across ≥2 Waves, including ≥1 `M`; demonstrated review participation | Triage labels; co-review `S` PRs |
| **Core contributor** | Sustained quality contributions across ≥2 tracks or deep ownership of one; ≥1 `L` landed; consistently reviews against §0 invariants | Merge rights on their track; participates in Wave planning; co-signs release notes |
| **Maintainer** | Core + ownership of a component's roadmap and audit-gate sign-off | Multisig participation (governance-gated), release authority |

Graduation is proposed by an existing maintainer and ratified by the maintainer
set; the criteria are necessary but not automatic — judgment about review quality
and adherence to the invariants is part of the bar.

---

## Appendix A — Confirmed vs. Proposed

| Item | Status |
|------|--------|
| Intent + solver architecture, EIP-712 intent, escrow lock/release/refund | **Confirmed** |
| Soroban settlement contract, `lz_receive`, idempotency markers | **Confirmed** |
| Three-message LZ protocol (FillInstruction/FillConfirmed/CancelIntent) | **Confirmed (this spec)** |
| `fill_intent`, `cancel_expired_intent`, full `DataKey`/`PerihelionError` | **Confirmed (this spec)** |
| Unordered (lazy-nonce) LZ delivery; 2+1 DVN policy | **Confirmed (this spec)** |
| Temporary-tier soft reservations | **[PROPOSED]** |
| Solver reputation system | **[PROPOSED — Phase 3]** |
| ZK (BN254) state-proof verification path | **[PROPOSED — Phase 3]** |
| `CONFIRMATION_GRACE` exact value (2 h) | **[PROPOSED]** default, governance-tunable |

## Appendix B — Open questions for reviewers

1. Should `FillInstruction` be eagerly sent on every `lock` (current design,
   authoritative Stellar registration) or **lazily** (a [PROPOSED] gas
   optimization where solvers fill against off-chain-observed locks and the
   source verifies at release)? Trade-off: per-intent LZ cost vs. weaker Stellar-
   side knowledge. See §1.4 step 4 and §3.
2. Exact `CONFIRMATION_GRACE` and per-corridor `deadline` minimums (§4.3).
3. DVN set membership and whether a Stellar-ecosystem-operated DVN is available
   at Phase 1 (§3.2).
4. Whether Protocol 24 exposes BN254 or BLS12-381 host functions for the Phase-3
   verifier (§8.3).



---

## 9. Security Model — Admin Key Management and Initialization

### 9.1 `initialize` role separation (closes #18)

`initialize(admin, endpoint)` is called exactly once (re-init is rejected with
`AlreadyInitialized`). It accepts two addresses that serve distinct, non-overlapping
roles:

| Parameter | Expected kind | Role |
|-----------|---------------|------|
| `admin` | Account (keypair) or multisig/timelock contract | Governance authority: rotates config, pauses/unpauses, nominates a new admin. |
| `endpoint` | Contract | Trusted LayerZero endpoint: sole permitted caller of `lz_receive`. |

**Collision guard.** `initialize` rejects `admin == endpoint`
(`AdminEndpointCollision`, error 134). Conflating the two collapses the
authorization model: the endpoint would then be able to rotate its own address
and unpause the contract, while the admin could inject arbitrary LayerZero
messages. The EVM escrow rejects a zero endpoint; the Soroban side extends
this principle to also reject role collision.

**Initialization event.** `initialize` emits an `initialized(admin, endpoint)`
event so deployment tooling and off-chain monitors can confirm the configured
roles without polling storage. Because misconfiguration at init is unrecoverable,
the event is the primary on-chain audit record.

### 9.2 Two-step admin handover (closes #17)

Admin transfer uses a two-step handshake that mirrors the EVM
`transferOwnership` / `acceptOwnership` pattern:

1. **`set_admin(new_admin)`** — callable only by the current admin. Stores
   `new_admin` as `PendingAdmin` and emits `admin_transfer_started(old, new)`.
   The current admin remains in control until step 2 completes.
2. **`accept_admin()`** — callable only by the `PendingAdmin` address.
   Promotes the nominee to `Admin`, clears `PendingAdmin`, and emits
   `admin_transfer_completed(old, new)`.

**Why two-step?** A single-step overwrite means one fat-fingered `set_admin`
permanently bricks governance (the old admin is atomically replaced; if the new
address is unspendable, all admin operations are locked forever). The two-step
pattern ensures the nominee proves control before the old admin loses access.

**Cancellation.** The current admin can cancel a pending handover at any time by
calling `set_admin` again (e.g. with their own address or any other nominee).
This overwrites `PendingAdmin` without completing the handover.

**EVM parity.** The EVM escrow (`PerihelionEscrow.sol`) uses the identical
`transferOwnership` / `acceptOwnership` pattern. The Soroban side now matches.

### 9.3 Off-chain config indexing — event model (closes #16)

Every admin/config setter emits a structured event. The table below documents
each event alongside its EVM analogue so a unified off-chain consumer can
normalize events from both chains:

| Soroban event | EVM analogue | Payload |
|---------------|--------------|---------|
| `initialized(admin, endpoint)` | *(constructor — no explicit event)* | `(admin: Address, endpoint: Address)` |
| `endpoint_set(old, new)` | *(no EVM equivalent — endpoint is immutable)* | `(old: Option<Address>, new: Address)` |
| `peer_set(eid, old, new)` | `PeerSet(peer: bytes32)` | `(eid: u32, old: Option<BytesN<32>>, new: BytesN<32>)` |
| `admin_transfer_started(old, new)` | `OwnershipTransferStarted(previousOwner, newOwner)` | `(old: Address, new: Address)` |
| `admin_transfer_completed(old, new)` | `OwnershipTransferred(previousOwner, newOwner)` | `(old: Address, new: Address)` |
| `paused_set(value)` | `PausedSet(paused: bool)` | `(paused: bool)` |

**Why events matter for bridge security.** Peer and endpoint rotations are the
highest-sensitivity config changes: a malicious peer rotation redirects trust
for an entire endpoint id, allowing spoofed fills and cancellations. Without
events, an off-chain monitor must poll instance storage and diff it — this
cannot reconstruct history once an entry is overwritten. Events make these
changes observable in real time by any indexer, security watcher, or monitoring
dashboard.

---

## 10. Peer Symmetry and `src_eid` Disambiguation (closes #15)

### 10.1 The peer symmetry assumption

`DataKey::Peer(eid)` is used for **both** inbound validation and outbound dispatch:

- **Inbound (`lz_receive`):** `origin.sender` is checked against
  `Peer(origin.src_eid)` to authenticate the message source.
- **Outbound (`dispatch` / `send_fill_confirmed` / `send_cancel`):**
  `Peer(rec.src_eid)` is looked up to find the EVM escrow address to send
  `FillConfirmed` / `CancelIntent` to.

This is intentional and correct: the trusted counterparty for a given endpoint
id is **symmetric** — the same EVM escrow we receive from is the one we repay.
On LayerZero V2, a "peer" is the remote OApp address. For the Perihelion
single-counterparty design (one Soroban settlement contract ↔ one EVM escrow
per source chain), the send and receive peer are always identical.

**Invariant.** `set_peer(eid, addr)` must always be called with the *deployed*
EVM escrow's 32-byte address for that `eid`. An operator who sets a peer for
an eid they only receive from (or only send to) will get an asymmetric
configuration that is logically incorrect, even though the two maps are one
and the same data structure.

### 10.2 Two distinct meanings of `src_eid`

There are two values in the system that are both called "src_eid" but refer to
different things:

| Name | Where it appears | Meaning |
|------|-----------------|---------|
| `origin.src_eid` | `lz_receive` parameter | LayerZero transport source — the endpoint id of the chain that **sent this LayerZero message**. Authenticated by the endpoint before delivery. |
| `fi.src_eid` | Inside `FillInstruction` payload | Intent source eid — the chain that holds the **locked funds** and to which `FillConfirmed`/`CancelIntent` must be sent. |

For well-formed messages from a compliant EVM escrow these two values are always
equal: the escrow sends `FillInstruction` from its own chain and embeds its own
`src_eid` in the payload. In all known deployments they are the same. However,
`dispatch` uses `fi.src_eid` (from the record), not `origin.src_eid` (from
delivery), so it is `fi.src_eid` that matters for settlement routing.

### 10.3 Registration-time peer guard (anti-stranding)

Prior to this fix, an intent could be registered with a `src_eid` that had no
configured peer. The intent would fill successfully on Stellar, but
`dispatch_confirmation` (or `fill_intent`) would then fail with `UntrustedPeer`
when trying to look up `Peer(rec.src_eid)` for the outbound send — permanently
stranding the filled intent with no way to repay the solver.

**The fix.** `on_fill_instruction` now checks `Peer(fi.src_eid)` exists before
writing the `IntentRecord`. If no peer is configured for the intent's source
eid, registration fails with `UntrustedPeer` (error 163). The LayerZero message
is rejected and can be replayed after the operator calls `set_peer` for the
missing eid.

**Chosen behavior (not silently accepted).** The intent is rejected at
registration, not silently accepted with a deferred failure at fill time. This
surfaces operator misconfiguration as early as possible and prevents solvers
from filling intents that can never be confirmed.
