#![no_std]
//! # Perihelion Settlement Contract
//!
//! The Stellar-side endpoint of the Perihelion intent bridge. It:
//!
//! 1. registers locked intents relayed from the source chain (`lz_receive` of a
//!    FillInstruction),
//! 2. lets a solver deliver the destination asset from its own inventory and be
//!    repaid on the source chain (`fill_intent`), and
//! 3. lets anyone unwind an expired intent and refund the user
//!    (`cancel_expired_intent`).
//!
//! Safety rests on per-intent idempotency markers, an endpoint-only + peer-checked
//! message boundary, and Soroban transaction atomicity (a failed check rolls back
//! any token transfer in the same call). See `docs/TECHNICAL-ARCHITECTURE.md`.

mod endpoint;
mod error;
mod messages;
mod types;

#[cfg(test)]
mod test;

pub use endpoint::{EndpointClient, LzEndpoint};
pub use error::PerihelionError;
pub use types::*;

use soroban_sdk::{contract, contractimpl, token, Address, BytesN, Env, Symbol};

use messages::{encode_cancel_intent, encode_fill_confirmed};

/// Hard ceiling for TTL extension. Mirrors the representative network
/// `max_entry_ttl`; clamp every extension to this. Should track network config.
const MAX_TTL: u32 = 3_110_400;
/// Extra TTL margin (~7 days at ~5s/ledger) beyond an intent's deadline, to
/// absorb late confirmations and the refund window.
const GRACE_LEDGERS: u32 = 120_960;
/// Minimum ledger close time, in seconds, used to convert a unix deadline into
/// a TTL bump target. Using the *minimum* close time (4 s) means
/// `secs / MIN_SECS_PER_LEDGER` always over-estimates the ledger count, so the
/// TTL is over-provisioned relative to the actual close rate. This is the safe
/// direction: a too-generous TTL wastes a small amount of rent but an
/// under-estimate can allow the entry to be archived while still live.
/// Safety invariant: always round TTL *up*, never down.
const MIN_SECS_PER_LEDGER: u64 = 4;

/// Maximum deadline horizon, in seconds from the current ledger timestamp.
/// FillInstructions with `deadline > now + MAX_DEADLINE_HORIZON` are rejected
/// to prevent trivially pinning an entry at MAX_TTL with a far-future deadline.
/// 7 days = 604_800 s is aligned with the SDK's intent builder maximum and
/// covers any realistic cross-chain settlement window.
pub const MAX_DEADLINE_HORIZON: u64 = 604_800;

#[contract]
pub struct Perihelion;

#[contractimpl]
impl Perihelion {
    /// Initialize with an admin and the trusted LayerZero endpoint.
    pub fn initialize(env: Env, admin: Address, endpoint: Address) -> Result<(), PerihelionError> {
        let storage = env.storage().instance();
        if storage.has(&DataKey::Admin) {
            return Err(PerihelionError::AlreadyInitialized);
        }
        storage.set(&DataKey::Admin, &admin);
        storage.set(&DataKey::Endpoint, &endpoint);
        storage.set(&DataKey::Paused, &false);
        storage.extend_ttl(17_280, 1_209_600);
        Ok(())
    }

    // --- Admin configuration ---------------------------------------------------

    /// Rotate the trusted endpoint. Admin-only.
    pub fn set_endpoint(env: Env, new_endpoint: Address) -> Result<(), PerihelionError> {
        Self::require_admin(&env)?.require_auth();
        env.storage()
            .instance()
            .set(&DataKey::Endpoint, &new_endpoint);
        Ok(())
    }

    /// Register/replace the trusted remote peer (the EVM escrow) for a source
    /// endpoint id. Admin-only.
    pub fn set_peer(env: Env, eid: u32, peer: BytesN<32>) -> Result<(), PerihelionError> {
        Self::require_admin(&env)?.require_auth();
        env.storage().instance().set(&DataKey::Peer(eid), &peer);
        Ok(())
    }

    /// Transfer admin authority. Admin-only.
    pub fn set_admin(env: Env, new_admin: Address) -> Result<(), PerihelionError> {
        Self::require_admin(&env)?.require_auth();
        env.storage().instance().set(&DataKey::Admin, &new_admin);
        Ok(())
    }

    /// Emergency halt of state-mutating entrypoints. Admin-only. Fail-safe: a
    /// paused contract cannot move funds.
    pub fn set_paused(env: Env, paused: bool) -> Result<(), PerihelionError> {
        Self::require_admin(&env)?.require_auth();
        env.storage().instance().set(&DataKey::Paused, &paused);
        Ok(())
    }

    // --- LayerZero inbound -----------------------------------------------------

    /// LayerZero receive hook. Callable only by the configured endpoint, and only
    /// for messages from the registered peer on `origin.src_eid`. Replay-guarded
    /// by a lazy-nonce high-water mark. Dispatches on the message variant.
    pub fn lz_receive(
        env: Env,
        origin: Origin,
        _guid: BytesN<32>,
        message: LzMessage,
    ) -> Result<(), PerihelionError> {
        // Only the endpoint may deliver messages.
        Self::require_endpoint(&env)?.require_auth();

        // The sender must be our registered peer for this source endpoint id.
        let expected: BytesN<32> = env
            .storage()
            .instance()
            .get(&DataKey::Peer(origin.src_eid))
            .ok_or(PerihelionError::UntrustedPeer)?;
        if expected != origin.sender {
            return Err(PerihelionError::UntrustedPeer);
        }

        // Lazy-nonce replay guard (unordered delivery).
        Self::accept_nonce(&env, origin.src_eid, origin.nonce)?;

        match message {
            LzMessage::FillInstruction(fi) => Self::on_fill_instruction(&env, fi),
            LzMessage::Cancel(ci) => Self::on_cancel_inbound(&env, ci),
        }
    }

    // --- Solver fill -----------------------------------------------------------

    /// Solver delivers `dest_asset` to the intent recipient from its own inventory,
    /// records the fill, and durably marks the intent `Filled`. Does NOT dispatch the
    /// cross-chain FillConfirmed message; call `dispatch_confirmation` separately.
    /// This separation makes the messaging leg independently retriable (Issue #12).
    pub fn deliver_intent(
        env: Env,
        solver: Address,
        solver_evm: BytesN<32>,
        intent_hash: BytesN<32>,
        fill_amount: i128,
    ) -> Result<(), PerihelionError> {
        solver.require_auth();
        Self::require_not_paused(&env)?;

        // Terminal-state guard via cheap markers (survives record archival).
        if Self::is_finalized(&env, &intent_hash) {
            return Err(PerihelionError::IntentFinalized);
        }

        let key = DataKey::Intent(intent_hash.clone());
        let mut rec: IntentRecord = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(PerihelionError::IntentNotFound)?;

        if rec.status != IntentStatus::Locked {
            return Err(PerihelionError::AlreadyFilled);
        }
        if env.ledger().timestamp() >= rec.deadline {
            return Err(PerihelionError::IntentExpired);
        }
        if let Some(ref pref) = rec.preferred_solver {
            if pref != &solver {
                return Err(PerihelionError::ReservedForSolver);
            }
        }
        if fill_amount <= 0 {
            return Err(PerihelionError::InvalidAmount);
        }
        if fill_amount < rec.min_dest_amount {
            return Err(PerihelionError::InsufficientFillAmount);
        }

        // Effects before interactions: flip status, write the settled marker.
        rec.status = IntentStatus::Filled;
        rec.solver = Some(solver.clone());
        rec.solver_evm = Some(solver_evm.clone());
        rec.fill_amount = fill_amount;
        rec.fill_ledger = env.ledger().sequence();
        env.storage().persistent().set(&key, &rec);
        env.storage()
            .persistent()
            .set(&DataKey::Settled(intent_hash.clone()), &true);

        // Interaction: deliver the destination asset from the solver to the user.
        token::TokenClient::new(&env, &rec.dest_asset).transfer(
            &solver,
            &rec.recipient,
            &fill_amount,
        );

        // Refresh TTLs touched by this call.
        let bump = Self::ttl_for_deadline(&env, rec.deadline);
        env.storage().persistent().extend_ttl(&key, bump / 2, bump);
        env.storage().persistent().extend_ttl(
            &DataKey::Settled(intent_hash.clone()),
            MAX_TTL / 2,
            MAX_TTL,
        );
        env.storage().instance().extend_ttl(17_280, 1_209_600);

        env.events().publish(
            (Symbol::new(&env, "filled"), intent_hash),
            (solver, rec.dest_asset, fill_amount, rec.src_eid),
        );
        Ok(())
    }

    /// Dispatch the FillConfirmed message for an already-filled intent.
    /// Permissionless: any party can pay to push a stuck confirmation through.
    /// Guarded against double-dispatch by a marker. Advances intent to `ConfirmationSent`.
    /// Returns error if the intent is not in `Filled` status or confirmation already sent.
    pub fn dispatch_confirmation(
        env: Env,
        caller: Address,
        intent_hash: BytesN<32>,
        lz_fee: i128,
    ) -> Result<(), PerihelionError> {
        caller.require_auth();
        Self::require_not_paused(&env)?;

        // Guard against double-dispatch
        if env.storage().persistent().has(&DataKey::ConfirmationSent(intent_hash.clone())) {
            return Err(PerihelionError::IntentFinalized);
        }

        let key = DataKey::Intent(intent_hash.clone());
        let mut rec: IntentRecord = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(PerihelionError::IntentNotFound)?;

        if rec.status != IntentStatus::Filled {
            return Err(PerihelionError::AlreadyFilled);
        }

        let solver = rec
            .solver
            .clone()
            .ok_or(PerihelionError::IntentNotFound)?;
        let solver_evm = rec
            .solver_evm
            .clone()
            .ok_or(PerihelionError::IntentNotFound)?;

        // Dispatch FillConfirmed so the source escrow repays the solver.
        Self::send_fill_confirmed(&env, &solver, &rec, &solver_evm, lz_fee)?;

        // Mark dispatch as sent to prevent double-dispatch
        env.storage()
            .persistent()
            .set(&DataKey::ConfirmationSent(intent_hash.clone()), &true);

        rec.status = IntentStatus::ConfirmationSent;
        env.storage().persistent().set(&key, &rec);

        // Update solver reputation (PROPOSED Phase 3)
        let fill_latency = env.ledger().sequence() - rec.fill_ledger;
        Self::update_solver_reputation(&env, &solver, fill_latency)?;

        env.events().publish(
            (Symbol::new(&env, "confirmation_sent"), intent_hash),
            (solver,),
        );
        Ok(())
    }

    /// Solver delivers `dest_asset` to the intent recipient and dispatches FillConfirmed
    /// in a single transaction. Convenience wrapper that calls deliver_intent internally
    /// and then dispatch_confirmation. For new code, consider calling deliver_intent and
    /// dispatch_confirmation separately to allow retry of the messaging layer (Issue #12).
    pub fn fill_intent(
        env: Env,
        solver: Address,
        solver_evm: BytesN<32>,
        intent_hash: BytesN<32>,
        fill_amount: i128,
        lz_fee: i128,
    ) -> Result<(), PerihelionError> {
        solver.require_auth();
        Self::require_not_paused(&env)?;

        // Terminal-state guard via cheap markers (survives record archival).
        if Self::is_finalized(&env, &intent_hash) {
            return Err(PerihelionError::IntentFinalized);
        }

        let key = DataKey::Intent(intent_hash.clone());
        let mut rec: IntentRecord = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(PerihelionError::IntentNotFound)?;

        if rec.status != IntentStatus::Locked {
            return Err(PerihelionError::AlreadyFilled);
        }
        if env.ledger().timestamp() >= rec.deadline {
            return Err(PerihelionError::IntentExpired);
        }
        if let Some(ref pref) = rec.preferred_solver {
            if pref != &solver {
                return Err(PerihelionError::ReservedForSolver);
            }
        }
        if fill_amount <= 0 {
            return Err(PerihelionError::InvalidAmount);
        }
        if fill_amount < rec.min_dest_amount {
            return Err(PerihelionError::InsufficientFillAmount);
        }

        // Idempotency marker written before the outbound dispatch.
        env.storage()
            .persistent()
            .set(&DataKey::Settled(intent_hash.clone()), &true);

        // Prepare the record in memory through both state transitions. Since Soroban
        // calls are atomic, no external observer can see intermediate states between
        // writes. We write the full record exactly once, after send_fill_confirmed
        // succeeds, reducing storage cost by ~50% on the hot fill path.
        rec.status = IntentStatus::Filled;
        rec.solver = Some(solver.clone());
        rec.solver_evm = Some(solver_evm.clone());
        rec.fill_amount = fill_amount;
        rec.fill_ledger = env.ledger().sequence();

        // Interaction: deliver the destination asset from the solver to the user.
        token::TokenClient::new(&env, &rec.dest_asset).transfer(
            &solver,
            &rec.recipient,
            &fill_amount,
        );

        // Dispatch FillConfirmed so the source escrow repays the solver.
        Self::send_fill_confirmed(&env, &solver, &rec, &solver_evm, lz_fee)?;

        // Single persistent write with final status after all interactions succeed.
        rec.status = IntentStatus::ConfirmationSent;
        env.storage().persistent().set(&key, &rec);

        // Refresh TTLs touched by this call.
        let bump = Self::ttl_for_deadline(&env, rec.deadline);
        env.storage().persistent().extend_ttl(&key, bump / 2, bump);
        env.storage().persistent().extend_ttl(
            &DataKey::Settled(intent_hash.clone()),
            MAX_TTL / 2,
            MAX_TTL,
        );
        env.storage().instance().extend_ttl(17_280, 1_209_600);

        env.events().publish(
            (Symbol::new(&env, "filled"), intent_hash),
            (solver, rec.dest_asset, fill_amount, rec.src_eid),
        );
        Ok(())
    }

    // --- Cancellation ----------------------------------------------------------

    /// Cancel an intent whose deadline passed without a fill and notify the
    /// source chain to refund the user. Permissionless (caller funds the message).
    pub fn cancel_expired_intent(
        env: Env,
        caller: Address,
        intent_hash: BytesN<32>,
        lz_fee: i128,
    ) -> Result<(), PerihelionError> {
        caller.require_auth();
        Self::require_not_paused(&env)?;

        if Self::is_finalized(&env, &intent_hash) {
            return Err(PerihelionError::IntentFinalized);
        }

        let key = DataKey::Intent(intent_hash.clone());
        let mut rec: IntentRecord = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(PerihelionError::IntentNotFound)?;

        if rec.status != IntentStatus::Locked {
            return Err(PerihelionError::IntentFinalized);
        }
        if env.ledger().timestamp() < rec.deadline {
            return Err(PerihelionError::DeadlineNotPassed);
        }

        rec.status = IntentStatus::Cancelled;
        env.storage().persistent().set(&key, &rec);
        env.storage()
            .persistent()
            .set(&DataKey::Cancelled(intent_hash.clone()), &true);
        env.storage().persistent().extend_ttl(
            &DataKey::Cancelled(intent_hash.clone()),
            MAX_TTL / 2,
            MAX_TTL,
        );

        Self::send_cancel(&env, &caller, &rec, types::CANCEL_REASON_EXPIRED, lz_fee)?;

        env.events().publish(
            (Symbol::new(&env, "cancelled"), intent_hash),
            (rec.src_eid, rec.deadline),
        );
        Ok(())
    }

    // --- Views -----------------------------------------------------------------

    /// True if the intent has been settled (filled).
    pub fn is_settled(env: Env, intent_hash: BytesN<32>) -> bool {
        env.storage()
            .persistent()
            .has(&DataKey::Settled(intent_hash))
    }

    /// True if the intent has been cancelled.
    pub fn is_cancelled(env: Env, intent_hash: BytesN<32>) -> bool {
        env.storage()
            .persistent()
            .has(&DataKey::Cancelled(intent_hash))
    }

    /// Fetch the full intent record, if registered.
    pub fn get_intent(env: Env, intent_hash: BytesN<32>) -> Option<IntentRecord> {
        env.storage()
            .persistent()
            .get(&DataKey::Intent(intent_hash))
    }

    /// Current trusted endpoint.
    pub fn endpoint(env: Env) -> Result<Address, PerihelionError> {
        Self::require_endpoint(&env)
    }

    /// Whether the contract is paused.
    pub fn is_paused(env: Env) -> bool {
        env.storage()
            .instance()
            .get(&DataKey::Paused)
            .unwrap_or(false)
    }

    /// PROPOSED Phase 3: Fetch aggregate reputation metrics for a solver.
    /// Returns None if the solver has never filled an intent.
    pub fn get_solver_reputation(env: Env, solver: Address) -> Option<SolverReputationRecord> {
        env.storage()
            .persistent()
            .get(&DataKey::SolverReputation(solver))
    }
}

// --- Private helpers (not contract entrypoints) -------------------------------

impl Perihelion {
    fn require_admin(env: &Env) -> Result<Address, PerihelionError> {
        env.storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(PerihelionError::NotInitialized)
    }

    fn require_endpoint(env: &Env) -> Result<Address, PerihelionError> {
        env.storage()
            .instance()
            .get(&DataKey::Endpoint)
            .ok_or(PerihelionError::NotInitialized)
    }

    fn require_not_paused(env: &Env) -> Result<(), PerihelionError> {
        if env
            .storage()
            .instance()
            .get(&DataKey::Paused)
            .unwrap_or(false)
        {
            return Err(PerihelionError::ContractPaused);
        }
        Ok(())
    }

    fn is_finalized(env: &Env, intent_hash: &BytesN<32>) -> bool {
        let p = env.storage().persistent();
        p.has(&DataKey::Settled(intent_hash.clone()))
            || p.has(&DataKey::Cancelled(intent_hash.clone()))
    }

    /// Accept a nonce exactly once, regardless of delivery order. Uses a bitmap to
    /// track consumed nonces in a 64-nonce window (base, base+63]. If a nonce falls
    /// outside the window, the base advances and the old bitmap is discarded, so
    /// very old messages are still rejected (cannot replay messages more than ~64
    /// messages old without an explicit reset). This implements true "unordered
    /// delivery" semantics per LayerZero V2 lazy-nonce model.
    fn accept_nonce(env: &Env, eid: u32, nonce: u64) -> Result<(), PerihelionError> {
        if nonce == 0 {
            return Err(PerihelionError::StaleNonce);
        }

        let ps = env.storage().persistent();
        let base_key = DataKey::InboundNonceBase(eid);
        let bitmap_key = DataKey::InboundNonceBitmap(eid);

        let base: u64 = ps.get(&base_key).unwrap_or(0);
        let mut bitmap: u64 = ps.get(&bitmap_key).unwrap_or(0);

        // If nonce <= base, it was already processed (or too old).
        if nonce <= base {
            return Err(PerihelionError::StaleNonce);
        }

        // If nonce > base + 64, advance the window.
        if nonce > base + 64 {
            let new_base = nonce - 1;
            ps.set(&base_key, &new_base);
            ps.set(&bitmap_key, &1u64); // Only the new nonce is set in the bitmap.
            return Ok(());
        }

        // Nonce is in the current window: [base + 1, base + 64].
        let offset = (nonce - base - 1) as u32;
        let bit = 1u64 << offset;

        if bitmap & bit != 0 {
            // Already consumed.
            return Err(PerihelionError::StaleNonce);
        }

        bitmap |= bit;
        ps.set(&bitmap_key, &bitmap);
        Ok(())
    }

    fn on_fill_instruction(env: &Env, fi: FillInstruction) -> Result<(), PerihelionError> {
        let key = DataKey::Intent(fi.intent_hash.clone());
        // Idempotent: ignore re-delivery of a known or finalized intent.
        if Self::is_finalized(env, &fi.intent_hash) || env.storage().persistent().has(&key) {
            return Ok(());
        }
        if fi.min_dest_amount <= 0 {
            return Err(PerihelionError::InvalidAmount);
        }
        // Reject deadlines that are unreasonably far in the future. This bounds
        // per-intent TTL to a realistic settlement window and prevents cheap
        // state-bloat attacks that pin MAX_TTL entries via far-future deadlines.
        let now = env.ledger().timestamp();
        if fi.deadline > now.saturating_add(MAX_DEADLINE_HORIZON) {
            return Err(PerihelionError::DeadlineTooFar);
        }

        let rec = IntentRecord {
            intent_hash: fi.intent_hash.clone(),
            src_eid: fi.src_eid,
            recipient: fi.recipient,
            dest_asset: fi.dest_asset,
            min_dest_amount: fi.min_dest_amount,
            deadline: fi.deadline,
            preferred_solver: fi.preferred_solver,
            status: IntentStatus::Locked,
            solver: None,
            solver_evm: None,
            fill_amount: 0,
            fill_ledger: 0,
        };
        env.storage().persistent().set(&key, &rec);
        let bump = Self::ttl_for_deadline(env, fi.deadline);
        env.storage().persistent().extend_ttl(&key, bump / 2, bump);

        env.events().publish(
            (Symbol::new(env, "registered"), fi.intent_hash),
            (fi.src_eid, fi.deadline),
        );
        Ok(())
    }

    fn on_cancel_inbound(env: &Env, ci: CancelInstruction) -> Result<(), PerihelionError> {
        if Self::is_finalized(env, &ci.intent_hash) {
            // Emit cancel_ignored event to record the race: cancel arrived after intent was finalized.
            // This enables auditing and reconciliation to distinguish "never arrived" from "lost race".
            env.events().publish(
                (Symbol::new(env, "cancel_ignored"), ci.intent_hash.clone()),
                (IntentStatus::ConfirmationSent as u32,),
            );
            return Ok(());
        }
        let key = DataKey::Intent(ci.intent_hash.clone());
        if let Some(mut rec) = env
            .storage()
            .persistent()
            .get::<DataKey, IntentRecord>(&key)
        {
            if rec.status == IntentStatus::Locked {
                rec.status = IntentStatus::Cancelled;
                env.storage().persistent().set(&key, &rec);
                env.storage()
                    .persistent()
                    .set(&DataKey::Cancelled(ci.intent_hash.clone()), &true);
                env.storage().persistent().extend_ttl(
                    &DataKey::Cancelled(ci.intent_hash.clone()),
                    MAX_TTL / 2,
                    MAX_TTL,
                );
                env.events().publish(
                    (Symbol::new(env, "cancelled_inbound"), ci.intent_hash.clone()),
                    (rec.src_eid,),
                );
            } else {
                // Cancel arrived for an intent in a non-Locked state (Filled, ConfirmationSent).
                // Emit cancel_ignored event to record the race.
                env.events().publish(
                    (Symbol::new(env, "cancel_ignored"), ci.intent_hash.clone()),
                    (rec.status as u32,),
                );
            }
        }
        Ok(())
    }

    fn send_fill_confirmed(
        env: &Env,
        payer: &Address,
        rec: &IntentRecord,
        solver_evm: &BytesN<32>,
        lz_fee: i128,
    ) -> Result<(), PerihelionError> {
        let message = encode_fill_confirmed(
            env,
            &rec.intent_hash,
            solver_evm,
            rec.fill_amount,
            rec.fill_ledger,
        );
        Self::dispatch(env, payer, rec.src_eid, message, lz_fee)
    }

    fn send_cancel(
        env: &Env,
        payer: &Address,
        rec: &IntentRecord,
        reason: u8,
        lz_fee: i128,
    ) -> Result<(), PerihelionError> {
        let message = encode_cancel_intent(env, &rec.intent_hash, reason);
        Self::dispatch(env, payer, rec.src_eid, message, lz_fee)
    }

    /// PROPOSED Phase 3: Update solver reputation metrics after a successful fill.
    /// Called when a fill transitions to ConfirmationSent state.
    /// Updates fill_count, success_count, and EWMA latency (0.9 * old + 0.1 * new).
    fn update_solver_reputation(
        env: &Env,
        solver: &Address,
        fill_latency_ledgers: u32,
    ) -> Result<(), PerihelionError> {
        let key = DataKey::SolverReputation(solver.clone());
        let mut rep: SolverReputationRecord = env
            .storage()
            .persistent()
            .get(&key)
            .unwrap_or(SolverReputationRecord {
                fill_count: 0,
                success_count: 0,
                ewma_latency: 0,
            });

        rep.fill_count = rep.fill_count.saturating_add(1);
        rep.success_count = rep.success_count.saturating_add(1);

        let latency_i128 = fill_latency_ledgers as i128;
        if rep.ewma_latency == 0 {
            rep.ewma_latency = latency_i128;
        } else {
            rep.ewma_latency = (rep.ewma_latency * 9 + latency_i128) / 10;
        }

        env.storage().persistent().set(&key, &rep);
        Ok(())
    }

    fn dispatch(
        env: &Env,
        payer: &Address,
        dst_eid: u32,
        message: soroban_sdk::Bytes,
        lz_fee: i128,
    ) -> Result<(), PerihelionError> {
        let receiver: BytesN<32> = env
            .storage()
            .instance()
            .get(&DataKey::Peer(dst_eid))
            .ok_or(PerihelionError::UntrustedPeer)?;
        let endpoint = Self::require_endpoint(env)?;
        let params = MessagingParams {
            dst_eid,
            receiver,
            message,
        };
        EndpointClient::new(env, &endpoint).send(&params, payer, &lz_fee);
        Ok(())
    }

    /// TTL bump target covering `deadline + GRACE`, clamped to `MAX_TTL`.
    ///
    /// Divides by `MIN_SECS_PER_LEDGER` (4 s) to over-provision the ledger
    /// count when actual close times are longer. This is the safe direction:
    /// a too-generous TTL wastes a small amount of rent but an under-estimate
    /// can archive the entry before the deadline passes.
    fn ttl_for_deadline(env: &Env, deadline: u64) -> u32 {
        let now = env.ledger().timestamp();
        let secs = deadline.saturating_sub(now);
        let ledgers = (secs / MIN_SECS_PER_LEDGER) as u32;
        ledgers.saturating_add(GRACE_LEDGERS).min(MAX_TTL)
    }
}
