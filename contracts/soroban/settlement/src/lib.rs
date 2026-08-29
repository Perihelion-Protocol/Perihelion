// SPDX-License-Identifier: MIT

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
mod strkey;
mod types;

#[cfg(test)]
mod test;

#[cfg(test)]
mod fuzz;

#[cfg(test)]
mod event_shape_spec;

pub use endpoint::{EndpointClient, LzEndpoint};
pub use error::PerihelionError;
pub use types::*;

use soroban_sdk::{contract, contractimpl, token, Address, BytesN, Env, Symbol, symbol_short};

use messages::{encode_cancel_intent, encode_fill_confirmed};

// =============================================================================
// EVENT CONSTANTS (issue #341)
// =============================================================================
// All event names are compile-time constants to ensure consistency with the
// event-shape spec, prevent typos, and enable compile-time checking. Names of
// 9 characters or fewer use symbol_short!; longer names remain as Symbol::new
// in runtime-evaluated const helpers.

mod events {
    use soroban_sdk::{symbol_short, Symbol};

    pub const INITIALIZED: Symbol = symbol_short!("initialized");
    pub const ENDPOINT_SET: Symbol = symbol_short!("endpoint_set");
    pub const PEER_SET: Symbol = symbol_short!("peer_set");
    pub const PEER_CHANGE_PROPOSED: Symbol = symbol_short!("peer_prop");
    pub const PEER_CHANGE_CANCELLED: Symbol = symbol_short!("peer_cancel");
    pub const ADMIN_TRANSFER_STARTED: Symbol = symbol_short!("adm_start");
    pub const ADMIN_TRANSFER_COMPLETED: Symbol = symbol_short!("adm_complete");
    pub const PAUSED_SET: Symbol = symbol_short!("paused_set");
    pub const NATIVE_TOKEN_SET: Symbol = symbol_short!("native_tok");
    pub const KEEPER_REWARD_SET: Symbol = symbol_short!("reward_set");
    pub const KEEPER_REWARD_PAID: Symbol = symbol_short!("reward_pd");
    pub const KEEPER_REWARD_SKIPPED: Symbol = symbol_short!("reward_sk");
    pub const REGISTERED: Symbol = symbol_short!("registered");
    pub const FILLED: Symbol = symbol_short!("filled");
    pub const CONFIRMATION_SENT: Symbol = symbol_short!("confirmed");
    pub const CANCELLED: Symbol = symbol_short!("cancelled");
    pub const CANCELLED_INBOUND: Symbol = symbol_short!("canl_in");
    pub const CANCEL_IGNORED: Symbol = symbol_short!("canl_ign");
    pub const ROLLING_WINDOW_CAP_TRIGGERED: Symbol = symbol_short!("roll_cap");
    /// Issue #500: delayed endpoint rotation, mirroring the peer-change events.
    pub const ENDPOINT_CHANGE_PROPOSED: Symbol = symbol_short!("endp_prop");
    pub const ENDPOINT_CHANGE_CANCELLED: Symbol = symbol_short!("endp_canl");
}

// =============================================================================
// EVENT SHAPE SPECIFICATION (issue #102)
// =============================================================================
//
// Events are the off-chain integration surface for indexers, relayers, and
// monitoring tooling. Each event shape below is a VERSIONED INTERFACE that must
// be asserted by tests. Changes to event topics or payloads MUST be reflected
// in both the constants above AND the corresponding EVM-side events.
//
// EVM equivalence: See `contracts/evm/src/PerihelionEscrow.sol` for matching
// event definitions. Cross-chain wire vectors in `contracts/shared/wire-vectors/`.
//
// Event shapes (topics tuple, data tuple):
//
// | Symbol                   | Topics                          | Data                                           |
// |--------------------------|---------------------------------|------------------------------------------------|
// | `initialized`            | ("initialized",)                 | (admin: Address, endpoint: Address)              |
// | `endpoint_set`         | ("endpoint_set",)                | (old: Address, new: Address)                     |
// | `peer_set`             | ("peer_set",)                    | (eid: u32, old: Option<BytesN<32>>, new: BytesN<32>) |
// | `admin_transfer_started` | ("admin_transfer_started",)      | (old: Address, new: Address)                     |
// | `admin_transfer_completed` | ("admin_transfer_completed",)  | (old: Address, new: Address)                     |
// | `paused_set`           | ("paused_set",)                  | (paused: bool)                                   |
// | `native_token_set`     | ("native_token_set",)            | (native_token: Address)                          |
// | `keeper_reward_set`    | ("keeper_reward_set",)           | (reward: i128)                                   |
// | `keeper_reward_paid`   | ("keeper_reward_paid", intent_hash) | (caller: Address, reward: i128)               |
// | `keeper_reward_skipped` | ("keeper_reward_skipped", intent_hash) | (caller: Address, reward: i128)            |
// | `registered`           | ("registered", intent_hash)        | (src_eid: u32, deadline: u64)                    |
// | `filled`               | ("filled", intent_hash)          | (solver: Address, dest_asset: Address, fill_amount: i128, src_eid: u32) |
// | `confirmation_sent`    | ("confirmation_sent", intent_hash) | (solver: Address)                                |
// | `cancelled`            | ("cancelled", intent_hash)       | (src_eid: u32, deadline: u64)                    |
// | `cancelled_inbound`     | ("cancelled_inbound", intent_hash) | (src_eid: u32)                                  |
// | `cancel_ignored`       | ("cancel_ignored", intent_hash)    | (status: u32)                           |

/// Default TTL ceiling for extensions (issue #340). Mirrors the representative
/// network `max_entry_ttl`; operator must set_max_ttl if network value differs.
/// 3110400 ledgers at ~5 s/ledger = ~180 days.
pub const MAX_TTL_DEFAULT: u32 = 3_110_400;
// Re-export for backwards compatibility and convenience.
pub const MAX_TTL: u32 = MAX_TTL_DEFAULT;
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
/// 7 days = 604_800 s matches `MAX_DEADLINE_HORIZON_SEC` (exported alias) and
/// `MAX_DEADLINE_HORIZON` in the SDK's `validateIntent` (sdk/src/intent.ts),
/// which enforces the same ceiling client-side before an intent is ever signed,
/// and covers any realistic cross-chain settlement window.
pub const MAX_DEADLINE_HORIZON: u64 = 604_800;

/// Minimum time window (seconds) required after deliver_intent for dispatch_confirmation
/// to complete. Solvers cannot deliver into a window too short for the confirmation
/// to land before the deadline. Mirrors EVM's MIN_CONFIRMATION_GRACE (issue #293).
/// 30 minutes = 1_800 s provides a buffer for confirmation relay and on-chain processing.
pub const MAX_DISPATCH_WINDOW: u64 = 1_800;

/// Minimum delay for peer changes (issue #165). Brings Soroban peer-management
/// under comparable delay/governance as the EVM side (PerihelionTimelock.MIN_DELAY).
/// Matches the EVM's 1-day minimum to give users time to react to peer rotations.
pub const MIN_PEER_CHANGE_DELAY: u64 = 86_400; // 1 day in seconds

/// Grace period for confirming a peer change after the minimum delay elapses.
/// Proposals older than this window are rejected as stale (issue #292).
/// Mirrors EVM's GRACE_PERIOD to prevent indefinite confirmation windows.
pub const PEER_CHANGE_GRACE: u64 = 1_209_600; // 14 days in seconds

/// Maximum delay for peer changes. Prevents governance from bricking peer
/// rotation with an unworkably long delay. Mirrors EVM's MAX_DELAY.
pub const MAX_PEER_CHANGE_DELAY: u64 = 2_592_000; // 30 days in seconds

#[contract]
pub struct Perihelion;

#[contractimpl]
impl Perihelion {
    /// Initialize with an admin, the trusted LayerZero endpoint, and the native token address.
    ///
    /// # Validation (issue #18)
    /// - `admin` and `endpoint` must be distinct addresses. Conflating them
    ///   collapses the authorization model: the endpoint is the trusted transport
    ///   layer (sole caller of `lz_receive`), while admin is the governance key
    ///   (rotates config, pauses/unpauses). These roles must remain separate.
    ///   The EVM escrow rejects a zero endpoint address; we extend that principle
    ///   by also rejecting role collisions, since misconfiguration at init is
    ///   unrecoverable (there is no re-init path).
    ///
    /// # Expected address kinds
    /// - `endpoint`: must be a **contract** address — the LayerZero endpoint
    ///   contract deployed on Stellar that calls `lz_receive`.
    /// - `admin`: typically an **account** (keypair) or a multisig/timelock
    ///   contract. Should never be the same address as `endpoint`.
    /// - `native_token`: the SAC (Stellar Asset Contract) address for the native
    ///   token on the current network. Differs by network (Testnet, Futurenet, Pubnet).
    ///   Used to pay keeper rewards. Issue #173.
    ///
    /// Emits an `initialized` event so deployment tooling can confirm the
    /// configured values without polling storage.
    pub fn initialize(
        env: Env,
        admin: Address,
        endpoint: Address,
        native_token: Address,
    ) -> Result<(), PerihelionError> {
        let storage = env.storage().instance();
        if storage.has(&DataKey::Admin) {
            return Err(PerihelionError::AlreadyInitialized);
        }
        // Issue #18: reject identical admin and endpoint — role separation invariant.
        if admin == endpoint {
            return Err(PerihelionError::AdminEndpointCollision);
        }
        storage.set(&DataKey::Admin, &admin);
        storage.set(&DataKey::Endpoint, &endpoint);
        storage.set(&DataKey::NativeToken, &native_token);
        storage.set(&DataKey::Paused, &false);
        // Issue #173: initialize keeper reward to 0. Admin must call set_keeper_reward
        // to enable keeper incentives for cancel_expired_intent.
        storage.set(&DataKey::KeeperReward, &0i128);
        storage.extend_ttl(17_280, 1_209_600);

        // Issue #16/#18: emit an event so deployment tooling and off-chain
        // monitors can confirm the configured roles without polling storage.
        env.events().publish(
            (events::INITIALIZED,),
            (admin, endpoint),
        );
        Ok(())
    }

    // --- Admin configuration ---------------------------------------------------

    /// Rotate the trusted endpoint. Admin-only.
    ///
    /// Emits an `endpoint_set` event with `(old, new)` so off-chain monitors
    /// can alert on endpoint rotations (issue #16). Endpoint rotations are
    /// high-sensitivity: a malicious rotation would redirect all inbound
    /// LayerZero message delivery.
    pub fn set_endpoint(env: Env, new_endpoint: Address) -> Result<(), PerihelionError> {
        Self::require_admin(&env)?.require_auth();
        let old: Option<Address> = env.storage().instance().get(&DataKey::Endpoint);
        env.storage()
            .instance()
            .set(&DataKey::Endpoint, &new_endpoint);
        env.events().publish(
            (events::ENDPOINT_SET,),
            (old, new_endpoint),
        );
        Ok(())
    }

    /// Propose a new trusted endpoint, subject to the same delayed two-step
    /// flow as `propose_peer` (issue #500). Admin-only.
    ///
    /// `set_endpoint` above rotates the endpoint instantly; this is an
    /// additive, delayed alternative for admins who want the same one-day
    /// public delay / `PEER_CHANGE_GRACE` confirmation window already used
    /// for peer rotations, since the endpoint is the stronger of the two
    /// authorities (`lz_receive` trusts it unconditionally before the peer
    /// check even runs). `set_endpoint` is left in place unchanged; callers
    /// choose which path to use.
    ///
    /// Emits `endp_prop(old, new, ready_at)`.
    pub fn propose_endpoint(env: Env, new_endpoint: Address) -> Result<(), PerihelionError> {
        Self::require_admin(&env)?.require_auth();
        let old: Option<Address> = env.storage().instance().get(&DataKey::Endpoint);
        let now = env.ledger().timestamp();
        let ready_at = now + MIN_PEER_CHANGE_DELAY;

        env.storage()
            .instance()
            .set(&DataKey::PendingEndpoint, &new_endpoint);
        env.storage()
            .instance()
            .set(&DataKey::PendingEndpointTime, &now);
        env.events().publish(
            (events::ENDPOINT_CHANGE_PROPOSED,),
            (old, new_endpoint, ready_at),
        );
        Ok(())
    }

    /// Confirm and apply a pending endpoint change (issue #500). Admin-only.
    /// Must be called after `MIN_PEER_CHANGE_DELAY` has elapsed since
    /// `propose_endpoint` and within `PEER_CHANGE_GRACE` of that delay
    /// elapsing, mirroring `confirm_peer`.
    ///
    /// Emits `endpoint_set(old, new)` on success — the same event
    /// `set_endpoint` emits, so existing monitors need not distinguish
    /// which path rotated the endpoint.
    ///
    /// # Errors
    /// - `NotPendingEndpointChange` if no endpoint change is pending
    /// - `EndpointChangeNotReady` if the minimum delay has not yet elapsed
    /// - `EndpointChangeExpired` if the grace period has elapsed since the proposal
    pub fn confirm_endpoint(env: Env) -> Result<(), PerihelionError> {
        Self::require_admin(&env)?.require_auth();

        let proposed_endpoint: Address = env
            .storage()
            .instance()
            .get(&DataKey::PendingEndpoint)
            .ok_or(PerihelionError::NotPendingEndpointChange)?;

        let proposed_at: u64 = env
            .storage()
            .instance()
            .get(&DataKey::PendingEndpointTime)
            .ok_or(PerihelionError::NotPendingEndpointChange)?;

        let now = env.ledger().timestamp();
        if now < proposed_at + MIN_PEER_CHANGE_DELAY {
            return Err(PerihelionError::EndpointChangeNotReady);
        }

        if now > proposed_at + MIN_PEER_CHANGE_DELAY + PEER_CHANGE_GRACE {
            env.storage().instance().remove(&DataKey::PendingEndpoint);
            env.storage()
                .instance()
                .remove(&DataKey::PendingEndpointTime);
            return Err(PerihelionError::EndpointChangeExpired);
        }

        let old: Option<Address> = env.storage().instance().get(&DataKey::Endpoint);
        env.storage()
            .instance()
            .set(&DataKey::Endpoint, &proposed_endpoint);
        env.storage().instance().remove(&DataKey::PendingEndpoint);
        env.storage()
            .instance()
            .remove(&DataKey::PendingEndpointTime);

        env.events().publish(
            (events::ENDPOINT_SET,),
            (old, proposed_endpoint),
        );
        Ok(())
    }

    /// Cancel a pending endpoint change (issue #500). Admin-only. Mirrors
    /// `cancel_pending_peer`.
    ///
    /// Emits `endp_canl()`.
    pub fn cancel_pending_endpoint(env: Env) -> Result<(), PerihelionError> {
        Self::require_admin(&env)?.require_auth();

        env.storage().instance().remove(&DataKey::PendingEndpoint);
        env.storage()
            .instance()
            .remove(&DataKey::PendingEndpointTime);

        env.events().publish((events::ENDPOINT_CHANGE_CANCELLED,), ());
        Ok(())
    }

    /// Retrieve a pending endpoint change, if one exists (issue #500).
    /// Returns (proposed_endpoint, proposed_at_timestamp, ready_at, expires_at)
    /// or None if no change is pending. Mirrors `get_pending_peer`.
    pub fn get_pending_endpoint(
        env: Env,
    ) -> Result<Option<(Address, u64, u64, u64)>, PerihelionError> {
        let endpoint: Option<Address> = env.storage().instance().get(&DataKey::PendingEndpoint);
        let time: Option<u64> = env.storage().instance().get(&DataKey::PendingEndpointTime);

        Ok(match (endpoint, time) {
            (Some(e), Some(t)) => {
                let ready_at = t.saturating_add(MIN_PEER_CHANGE_DELAY);
                let expires_at = t
                    .saturating_add(MIN_PEER_CHANGE_DELAY)
                    .saturating_add(PEER_CHANGE_GRACE);
                Some((e, t, ready_at, expires_at))
            }
            _ => None,
        })
    }

    /// Propose a new peer (EVM escrow address) for a source endpoint id (issue #165).
    /// Admin-only. Initiates a delayed peer change; the change becomes effective
    /// only after the minimum delay has elapsed and the admin calls `confirm_peer`.
    ///
    /// This brings Soroban peer-management under the same governance/delay model as
    /// the EVM side (PerihelionTimelock), preventing instant unauthorized peer
    /// rotation if the admin key is compromised. The delay gives users a window to
    /// detect and react to a suspicious peer change (e.g., via monitoring alerts).
    ///
    /// Emits `peer_change_proposed(eid, old_peer, new_peer, ready_at)` (issue #165).
    ///
    /// # Peer symmetry (issue #15)
    /// The same peer address is used for **both** inbound validation
    /// (`lz_receive` checks `origin.sender == Peer(origin.src_eid)`) and
    /// outbound dispatch (`dispatch` looks up `Peer(dst_eid)` where
    /// `dst_eid == rec.src_eid`). This is the intended design: the trusted
    /// counterparty for a given endpoint id is symmetric.
    pub fn propose_peer(env: Env, eid: u32, new_peer: BytesN<32>) -> Result<(), PerihelionError> {
        Self::require_admin(&env)?.require_auth();
        let old_peer: Option<BytesN<32>> = env.storage().instance().get(&DataKey::Peer(eid));
        let now = env.ledger().timestamp();
        let ready_at = now + MIN_PEER_CHANGE_DELAY;

        env.storage()
            .instance()
            .set(&DataKey::PendingPeer(eid), &new_peer);
        env.storage()
            .instance()
            .set(&DataKey::PendingPeerTime(eid), &now);
        env.events().publish(
            (events::PEER_CHANGE_PROPOSED,),
            (eid, old_peer, new_peer, ready_at),
        );
        Ok(())
    }

    /// Confirm and apply a pending peer change (issue #165). Admin-only.
    /// Must be called after the minimum delay (`MIN_PEER_CHANGE_DELAY`) has elapsed
    /// since `propose_peer` was called and within the grace period (`PEER_CHANGE_GRACE`).
    /// Atomically sets the new peer address and clears the pending state.
    ///
    /// Emits `peer_set(eid, old, new)` when the change is applied (issue #16).
    /// Emits `peer_change_expired(eid)` when rejecting a stale proposal (issue #292).
    ///
    /// # Errors
    /// - `NotPendingPeerChange` if no peer change is pending for this eid
    /// - `PeerChangeNotReady` if the minimum delay has not yet elapsed
    /// - `PeerChangeExpired` if the grace period has elapsed since the proposal
    pub fn confirm_peer(env: Env, eid: u32) -> Result<(), PerihelionError> {
        Self::require_admin(&env)?.require_auth();

        let proposed_peer: BytesN<32> = env
            .storage()
            .instance()
            .get(&DataKey::PendingPeer(eid))
            .ok_or(PerihelionError::NotPendingPeerChange)?;

        let proposed_at: u64 = env
            .storage()
            .instance()
            .get(&DataKey::PendingPeerTime(eid))
            .ok_or(PerihelionError::NotPendingPeerChange)?;

        let now = env.ledger().timestamp();
        if now < proposed_at + MIN_PEER_CHANGE_DELAY {
            return Err(PerihelionError::PeerChangeNotReady);
        }

        if now > proposed_at + MIN_PEER_CHANGE_DELAY + PEER_CHANGE_GRACE {
            env.events().publish(
                (Symbol::new(&env, "peer_change_expired"),),
                (eid,),
            );
            env.storage().instance().remove(&DataKey::PendingPeer(eid));
            env.storage().instance().remove(&DataKey::PendingPeerTime(eid));
            return Err(PerihelionError::PeerChangeExpired);
        }

        let old_peer: Option<BytesN<32>> = env.storage().instance().get(&DataKey::Peer(eid));
        env.storage()
            .instance()
            .set(&DataKey::Peer(eid), &proposed_peer);
        env.storage().instance().remove(&DataKey::PendingPeer(eid));
        env.storage()
            .instance()
            .remove(&DataKey::PendingPeerTime(eid));

        env.events().publish(
            (events::PEER_SET,),
            (eid, old_peer, proposed_peer),
        );
        Ok(())
    }

    /// Cancel a pending peer change (issue #165). Admin-only.
    /// Clears any pending peer change without applying it, allowing the admin
    /// to revoke a proposed change before the delay expires.
    ///
    /// Emits `peer_change_cancelled(eid)` (issue #165).
    pub fn cancel_pending_peer(env: Env, eid: u32) -> Result<(), PerihelionError> {
        Self::require_admin(&env)?.require_auth();

        env.storage().instance().remove(&DataKey::PendingPeer(eid));
        env.storage()
            .instance()
            .remove(&DataKey::PendingPeerTime(eid));

        env.events().publish(
            (events::PEER_CHANGE_CANCELLED,),
            (eid,),
        );
        Ok(())
    }

    /// Retrieve the currently-active peer address for an endpoint id.
    pub fn get_peer(env: Env, eid: u32) -> Result<Option<BytesN<32>>, PerihelionError> {
        Ok(env.storage().instance().get(&DataKey::Peer(eid)))
    }

    /// Retrieve a pending peer change, if one exists (issue #165).
    /// Returns (proposed_peer, proposed_at_timestamp, ready_at, expires_at) or None if no change pending.
    /// Allows callers to observe the confirmation window without manual computation (issue #292).
    pub fn get_pending_peer(env: Env, eid: u32) -> Result<Option<(BytesN<32>, u64, u64, u64)>, PerihelionError> {
        let peer: Option<BytesN<32>> = env.storage().instance().get(&DataKey::PendingPeer(eid));
        let time: Option<u64> = env.storage().instance().get(&DataKey::PendingPeerTime(eid));

        Ok(match (peer, time) {
            (Some(p), Some(t)) => {
                let ready_at = t.saturating_add(MIN_PEER_CHANGE_DELAY);
                let expires_at = t.saturating_add(MIN_PEER_CHANGE_DELAY).saturating_add(PEER_CHANGE_GRACE);
                Some((p, t, ready_at, expires_at))
            }
            _ => None,
        })
    }

    /// Begin a two-step admin handover (issue #17).
    ///
    /// Stores `new_admin` as `PendingAdmin`. The nominee must call
    /// `accept_admin` (authorizing as themselves) to complete the transfer.
    /// This mirrors the EVM `transferOwnership` / `acceptOwnership` pattern and
    /// prevents a fat-fingered or uncontrolled address from permanently capturing
    /// governance.
    ///
    /// To cancel a pending handover, call `set_admin` again with the current
    /// admin's own address (or any address the current admin controls).
    /// Effectively this overwrites the pending nominee without completing the
    /// handover, since the current admin remains in place until `accept_admin`
    /// is called.
    ///
    /// Emits `admin_transfer_started(old, new)` (issue #16).
    pub fn set_admin(env: Env, new_admin: Address) -> Result<(), PerihelionError> {
        let current = Self::require_admin(&env)?;
        current.require_auth();
        env.storage()
            .instance()
            .set(&DataKey::PendingAdmin, &new_admin);
        env.events().publish(
            (events::ADMIN_TRANSFER_STARTED,),
            (current, new_admin),
        );
        Ok(())
    }

    /// Complete a pending admin handover (issue #17).
    ///
    /// Must be called by the address stored in `PendingAdmin`. Atomically
    /// promotes the nominee to `Admin` and clears `PendingAdmin`.
    ///
    /// Emits `admin_transfer_completed(old, new)` (issue #16).
    pub fn accept_admin(env: Env) -> Result<(), PerihelionError> {
        let pending: Address = env
            .storage()
            .instance()
            .get(&DataKey::PendingAdmin)
            .ok_or(PerihelionError::NotPendingAdmin)?;
        pending.require_auth();
        let old = Self::require_admin(&env)?;
        env.storage().instance().set(&DataKey::Admin, &pending);
        env.storage().instance().remove(&DataKey::PendingAdmin);
        env.storage().instance().extend_ttl(17_280, 1_209_600);
        env.events().publish(
            (events::ADMIN_TRANSFER_COMPLETED,),
            (old, pending),
        );
        Ok(())
    }

    /// Emergency halt of state-mutating entrypoints. Admin-only. Fail-safe: a
    /// paused contract cannot move funds.
    ///
    /// Emits `paused_set(value)` (issue #16).
    pub fn set_paused(env: Env, paused: bool) -> Result<(), PerihelionError> {
        Self::require_admin(&env)?.require_auth();
        env.storage().instance().set(&DataKey::Paused, &paused);
        env.events().publish(
            (events::PAUSED_SET,),
            (paused,),
        );
        Ok(())
    }

    /// Pause or unpause a specific corridor (endpoint id). Admin-only.
    /// When paused, all inbound FillInstructions on that corridor are rejected,
    /// effectively quarantining a single compromised chain without halting others
    /// (issue #25, issue #287).
    ///
    /// Exit paths (dispatch_confirmation, cancel_expired_intent, on_cancel_inbound)
    /// remain available even when a corridor is paused, to prevent fund stranding.
    ///
    /// Emits `paused_eid_set(eid, paused)` event.
    pub fn set_paused_eid(env: Env, eid: u32, paused: bool) -> Result<(), PerihelionError> {
        Self::require_admin(&env)?.require_auth();
        env.storage()
            .instance()
            .set(&DataKey::PausedEid(eid), &paused);
        env.events().publish(
            (Symbol::new(&env, "paused_eid_set"),),
            (eid, paused),
        );
        Ok(())
    }

    /// Set the keeper reward paid to callers of `cancel_expired_intent`. Admin-only.
    /// A non-zero reward incentivizes third parties to refund expired intents,
    /// improving the liveness of the cancellation path (issue #173).
    ///
    /// The reward is paid in stroops (Stellar's smallest unit, 1 XLM = 10_000_000 stroops).
    /// Set to 0 to disable the keeper reward and require self-service refunds.
    ///
    /// # Safety
    /// Increasing the reward decreases contract reserves. Operators should ensure
    /// sufficient funds are available to cover the payout (or accept refund failures
    /// if reserves are depleted). A typical pattern is to prepay a reserve account
    /// and use the `set_keeper_reward` to control the payout rate.
    ///
    /// Emits `keeper_reward_set(new_reward)` event.
    pub fn set_keeper_reward(env: Env, reward: i128) -> Result<(), PerihelionError> {
        Self::require_admin(&env)?.require_auth();
        if reward < 0 {
            return Err(PerihelionError::InvalidAmount);
        }
        env.storage().instance().set(&DataKey::KeeperReward, &reward);
        env.events().publish(
            (events::KEEPER_REWARD_SET,),
            (reward,),
        );
        Ok(())
    }

    /// Set the per-intent maximum amount (value cap). Admin-only.
    /// Rejects any intent with min_dest_amount > max_amount. Set to 0 to disable.
    /// Issue #286: This cap is applied to the destination asset amount on Stellar
    /// (denominated in 7 decimals for Stellar assets).
    ///
    /// Emits `max_intent_amount_set(max_amount)` event.
    pub fn set_max_intent_amount(env: Env, max_amount: i128) -> Result<(), PerihelionError> {
        Self::require_admin(&env)?.require_auth();
        if max_amount < 0 {
            return Err(PerihelionError::InvalidAmount);
        }
        env.storage()
            .instance()
            .set(&DataKey::MaxIntentAmount, &max_amount);
        env.events().publish(
            (Symbol::new(&env, "max_intent_amount_set"),),
            (max_amount,),
        );
        Ok(())
    }

    /// Set the rolling-window value cap. Admin-only.
    /// Aggregates min_dest_amount across all intents registered within each duration window.
    /// If the cumulative amount exceeds cap, the rolling-window breach is triggered.
    /// Issue #286: This cap is applied to the destination asset amount on Stellar.
    ///
    /// # Parameters
    /// - `duration`: rolling window size in seconds (0 to disable)
    /// - `cap`: maximum aggregate amount per window (0 to disable)
    ///
    /// Emits `rolling_window_cap_set(duration, cap)` event.
    pub fn set_rolling_window_cap(env: Env, duration: u64, cap: i128) -> Result<(), PerihelionError> {
        Self::require_admin(&env)?.require_auth();
        if cap < 0 {
            return Err(PerihelionError::InvalidAmount);
        }
        env.storage()
            .instance()
            .set(&DataKey::RollingWindowDuration, &duration);
        env.storage()
            .instance()
            .set(&DataKey::RollingWindowCap, &cap);
        env.events().publish(
            (Symbol::new(&env, "rolling_window_cap_set"),),
            (duration, cap),
        );
        Ok(())
    }

    /// Reset the triggered rolling-window cap to allow new intents. Admin-only.
    /// Must be called at or after RollingWindowResetEarliestAt to unblock registration.
    /// Issue #286: Mirrors the EVM's resetRollingWindowCap behavior.
    ///
    /// Emits `rolling_window_cap_reset()` event.
    pub fn reset_rolling_window_cap(env: Env) -> Result<(), PerihelionError> {
        Self::require_admin(&env)?.require_auth();

        let now = env.ledger().timestamp();
        if let Some(reset_at) = env
            .storage()
            .instance()
            .get::<DataKey, u64>(&DataKey::RollingWindowResetEarliestAt)
        {
            if now < reset_at {
                return Err(PerihelionError::DeadlineNotPassed);
            }
        }

        env.storage()
            .instance()
            .set(&DataKey::RollingWindowTriggered, &false);
        env.storage()
            .instance()
            .remove(&DataKey::RollingWindowResetEarliestAt);
        env.events().publish(
            (Symbol::new(&env, "rolling_window_cap_reset"),),
            (),
        );
        Ok(())
    }

    /// Set the native token (SAC) address. Admin-only. Required for keeper reward
    /// payouts. The address differs per network (Testnet, Futurenet, Pubnet).
    /// Issue #173.
    pub fn set_native_token(env: Env, native_token: Address) -> Result<(), PerihelionError> {
        Self::require_admin(&env)?.require_auth();
        env.storage()
            .instance()
            .set(&DataKey::NativeToken, &native_token);
        env.events().publish(
            (events::NATIVE_TOKEN_SET,),
            (native_token,),
        );
        Ok(())
    }

    /// Get the native token address. Returns None if not yet configured.
    pub fn native_token(env: Env) -> Option<Address> {
        env.storage().instance().get(&DataKey::NativeToken)
    }

    /// Set the maximum TTL for storage entry extensions (issue #340). Admin-only.
    /// Must be called if the network's max_entry_ttl differs from MAX_TTL_DEFAULT.
    /// All TTL extensions are clamped to this value; setting it too low can cause
    /// archival failures if the network value is higher. Setting it to 0 disables
    /// this check (not recommended). Typical value: 3110400 for mainnet/testnet.
    pub fn set_max_ttl(env: Env, max_ttl: u32) -> Result<(), PerihelionError> {
        Self::require_admin(&env)?.require_auth();
        if max_ttl == 0 {
            return Err(PerihelionError::InvalidAmount);
        }
        env.storage().instance().set(&DataKey::MaxTtl, &max_ttl);
        Ok(())
    }

    /// Get the configured maximum TTL, or the default if not set.
    pub fn get_max_ttl(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::MaxTtl)
            .unwrap_or(MAX_TTL_DEFAULT)
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
        // NOTE: Pause checks are intentionally placed before nonce consumption.
        // If paused, the message is rejected without advancing the nonce, so it
        // can be re-delivered once unpaused. This is critical for correctness:
        // a rejected message must remain re-deliverable.
        match message {
            LzMessage::FillInstruction(fi) => {
                // FillInstruction registers new intents, so it's blocked by pause.
                Self::require_eid_not_paused(&env, origin.src_eid)?;
                Self::accept_nonce(&env, origin.src_eid, origin.nonce)?;
                Self::on_fill_instruction(&env, origin.src_eid, fi)
            }
            LzMessage::Cancel(ci) => {
                // CancelIntent is an exit path — it unwinds existing intents and
                // remains available even during pause to prevent fund stranding.
                Self::accept_nonce(&env, origin.src_eid, origin.nonce)?;
                Self::on_cancel_inbound(&env, ci)
            }
        }
    }

    // --- Solver fill -----------------------------------------------------------

    /// Validate fill inputs and stage the intent record for filling (issue #338).
    /// Returns the data key and the mutated record ready for commitment.
    /// This is the canonical validation point shared by both fill entrypoints.
    fn validate_and_stage_fill(
        env: &Env,
        solver: &Address,
        intent_hash: &BytesN<32>,
        fill_amount: i128,
    ) -> Result<(DataKey, IntentRecord), PerihelionError> {
        // Terminal-state guard via cheap markers (survives record archival).
        if Self::is_finalized(env, intent_hash) {
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
        let now = env.ledger().timestamp();
        if now >= rec.deadline {
            return Err(PerihelionError::IntentExpired);
        }
        if now + MAX_DISPATCH_WINDOW > rec.deadline {
            return Err(PerihelionError::IntentExpired);
        }
        if let Some(ref pref) = rec.preferred_solver {
            if pref != solver && now < rec.reservation_expires {
                return Err(PerihelionError::ReservedForSolver);
            }
        }
        if fill_amount <= 0 {
            return Err(PerihelionError::InvalidAmount);
        }
        if fill_amount < rec.min_dest_amount {
            return Err(PerihelionError::InsufficientFillAmount);
        }

        Ok((key, rec))
    }

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

        let (key, mut rec) = Self::validate_and_stage_fill(&env, &solver, &intent_hash, fill_amount)?;

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
            (events::FILLED, intent_hash),
            (solver, rec.dest_asset, fill_amount, rec.src_eid),
        );
        Ok(())
    }

    /// Dispatch the FillConfirmed message for an already-filled intent.
    /// Permissionless: any party can pay to push a stuck confirmation through.
    /// Guarded against double-dispatch by a marker. Advances intent to `ConfirmationSent`.
    /// Returns error if the intent is not in `Filled` status or confirmation already sent.
    ///
    /// Note: This is an exit path — it completes a payment for value already delivered
    /// on Stellar. A pause halting this path would strand solver funds with no recovery,
    /// so it remains available even during a global pause (issue #288).
    pub fn dispatch_confirmation(
        env: Env,
        caller: Address,
        intent_hash: BytesN<32>,
        lz_fee: i128,
    ) -> Result<(), PerihelionError> {
        caller.require_auth();

        // Guard against double-dispatch
        if env
            .storage()
            .persistent()
            .has(&DataKey::ConfirmationSent(intent_hash.clone()))
        {
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

        let solver = rec.solver.clone().ok_or(PerihelionError::IntentNotFound)?;
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
        // Extend ConfirmationSent to MAX_TTL so it outlives record archival and
        // status() can return ConfirmationSent even after the IntentRecord is gone
        // (issue #284 / #29 retention-asymmetry invariant).
        env.storage().persistent().extend_ttl(
            &DataKey::ConfirmationSent(intent_hash.clone()),
            MAX_TTL / 2,
            MAX_TTL,
        );

        rec.status = IntentStatus::ConfirmationSent;
        env.storage().persistent().set(&key, &rec);

        // Update solver reputation (PROPOSED Phase 3)
        let fill_latency = env.ledger().sequence().saturating_sub(rec.fill_ledger);
        Self::update_solver_reputation(&env, &solver, fill_latency)?;

        env.events().publish(
            (events::CONFIRMATION_SENT, intent_hash),
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

        let (key, mut rec) = Self::validate_and_stage_fill(&env, &solver, &intent_hash, fill_amount)?;

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

        // Write the ConfirmationSent marker so status() can distinguish
        // ConfirmationSent from Filled-but-undispatched (issue #284), and extend
        // it to MAX_TTL so it survives record archival alongside Settled.
        env.storage()
            .persistent()
            .set(&DataKey::ConfirmationSent(intent_hash.clone()), &true);

        // Refresh TTLs touched by this call.
        let bump = Self::ttl_for_deadline(&env, rec.deadline);
        env.storage().persistent().extend_ttl(&key, bump / 2, bump);
        env.storage().persistent().extend_ttl(
            &DataKey::Settled(intent_hash.clone()),
            MAX_TTL / 2,
            MAX_TTL,
        );
        env.storage().persistent().extend_ttl(
            &DataKey::ConfirmationSent(intent_hash.clone()),
            MAX_TTL / 2,
            MAX_TTL,
        );
        env.storage().instance().extend_ttl(17_280, 1_209_600);

        env.events().publish(
            (events::FILLED, intent_hash),
            (solver, rec.dest_asset, fill_amount, rec.src_eid),
        );
        Ok(())
    }

    // --- Cancellation ----------------------------------------------------------

    /// Cancel an intent whose deadline passed without a fill and notify the
    /// source chain to refund the user. Permissionless (caller funds the LayerZero message).
    /// If a keeper reward is configured (issue #173), the caller receives a refund to incentivize
    /// timely cancellation and improve refund liveness.
    ///
    /// Note: This is an exit path — it refunds a user by dispatching a message and cannot
    /// increase exposure. A pause halting this path would strand users' funds with no recovery,
    /// so it remains available even during a global pause (issue #288).
    ///
    /// # Keeper reward (issue #173)
    /// When `keeper_reward > 0`, the contract pays the caller a refund of XLM stroops,
    /// compensating for the LayerZero fee. This incentivizes third parties (keepers) to
    /// monitor and refund expired intents, improving protocol liveness. The reward is paid
    /// from the contract's balance (funded by admin pre-deposit or user-prepaid tips).
    /// If the contract has insufficient XLM to pay the reward, the call fails and the
    /// cancellation does not proceed.
    pub fn cancel_expired_intent(
        env: Env,
        caller: Address,
        intent_hash: BytesN<32>,
        lz_fee: i128,
    ) -> Result<(), PerihelionError> {
        caller.require_auth();

        // Cancelled marker: already cancelled — terminal, return IntentFinalized.
        if env
            .storage()
            .persistent()
            .has(&DataKey::Cancelled(intent_hash.clone()))
        {
            return Err(PerihelionError::IntentFinalized);
        }

        // Settled marker: intent was filled — return AlreadyFilled so callers can
        // distinguish "nothing to cancel" from "already cancelled".
        if env
            .storage()
            .persistent()
            .has(&DataKey::Settled(intent_hash.clone()))
        {
            return Err(PerihelionError::AlreadyFilled);
        }

        let key = DataKey::Intent(intent_hash.clone());
        let mut rec: IntentRecord = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(PerihelionError::IntentNotFound)?;

        // Belt-and-suspenders: status check covers edge cases where markers lag.
        if rec.status != IntentStatus::Locked {
            return Err(match rec.status {
                IntentStatus::Filled | IntentStatus::ConfirmationSent => {
                    PerihelionError::AlreadyFilled
                }
                _ => PerihelionError::IntentFinalized,
            });
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

        // Issue #173: pay keeper reward if configured. The reward is paid from
        // contract reserves after the cancellation is finalized, so failures to
        // pay do not roll back the cancellation.
        let keeper_reward: i128 = env
            .storage()
            .instance()
            .get(&DataKey::KeeperReward)
            .unwrap_or(0);
        if keeper_reward > 0 {
            // Retrieve the native token address from storage. Issue #173.
            if let Some(native_token) = env.storage().instance().get(&DataKey::NativeToken) {
                // Transfer the keeper reward using the idiomatic TokenClient pattern.
                // The contract is the sender; the caller is the recipient.
                token::TokenClient::new(&env, &native_token).transfer(
                    &env.current_contract_address(),
                    &caller,
                    &keeper_reward,
                );
                // Emit an observable event for the reward payout. Issue #173.
                env.events().publish(
                    (events::KEEPER_REWARD_PAID, intent_hash.clone()),
                    (caller.clone(), keeper_reward),
                );
            } else {
                // native_token is not configured: skip the reward rather than
                // failing the cancellation. This allows deployment to proceed
                // before the native token address is set, though keeper rewards
                // will not be paid. Operators must call set_native_token and
                // then re-enable rewards via set_keeper_reward.
                //
                // Emit an event so this misconfigured state (a positive
                // keeper_reward advertised via the view but not payable) is
                // observable off-chain instead of failing silently — a keeper
                // that funded the LayerZero fee expecting this reward would
                // otherwise have no signal explaining the missing payout.
                env.events().publish(
                    (events::KEEPER_REWARD_SKIPPED, intent_hash.clone()),
                    (caller.clone(), keeper_reward),
                );
            }
        }

        env.events().publish(
            (events::CANCELLED, intent_hash),
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
    ///
    /// **Retention asymmetry (issue #29):** `get_intent` reads the full
    /// `IntentRecord` from persistent storage, which is retained only to
    /// `ttl_for_deadline(deadline)` (the intent's deadline + GRACE_LEDGERS,
    /// clamped to MAX_TTL). The terminal idempotency markers `Settled` and
    /// `Cancelled` are bumped to a full `MAX_TTL` on every terminal
    /// transition, so they outlive the record.
    ///
    /// Consequence: after the grace window the record may be archived while
    /// `is_settled` / `is_cancelled` still return `true`. A consumer that
    /// treats `get_intent == None` as "intent never existed / still pending"
    /// will be wrong for aged, settled/cancelled intents.
    ///
    /// **For authoritative terminal state use [`status`], which consults the
    /// durable markers first and falls back to the record only if no marker is
    /// set.** Never rely on `get_intent == None` alone to conclude an intent is
    /// unsettled; always call `status` or check the markers directly.
    pub fn get_intent(env: Env, intent_hash: BytesN<32>) -> Option<IntentRecord> {
        env.storage()
            .persistent()
            .get(&DataKey::Intent(intent_hash))
    }

    /// Combined, authoritative intent status view (issue #29, #284).
    ///
    /// Consults the durable idempotency markers first (they survive record
    /// archival), then falls back to the live `IntentRecord`. Returns:
    ///
    /// - `IntentStatus::ConfirmationSent` — `ConfirmationSent` marker is set;
    ///   `dispatch_confirmation` (or `fill_intent`) has successfully dispatched
    ///   the cross-chain FillConfirmed message.
    /// - `IntentStatus::Filled` — `Settled` marker is set but `ConfirmationSent`
    ///   marker is absent; the solver delivered the asset on Stellar via
    ///   `deliver_intent` but `dispatch_confirmation` has not yet been called.
    ///   The solver is not yet repaid on the source chain. Callers should invoke
    ///   `dispatch_confirmation` to push the confirmation through.
    /// - `IntentStatus::Cancelled` — `Cancelled` marker is set.
    /// - The `IntentRecord::status` value — if the record is still live and no
    ///   terminal marker exists yet (e.g. `Locked`, `Filled` before dispatch).
    /// - `None` — neither a marker nor a live record exists. The intent hash
    ///   was never registered on this contract, or the record was archived
    ///   before a terminal marker was written (should not occur under normal
    ///   operation, but callers must handle it).
    ///
    /// **Integrators: always call `status` for terminal-state queries.** Do not
    /// use `get_intent == None` as a proxy for "unknown or pending".
    pub fn status(env: Env, intent_hash: BytesN<32>) -> Option<IntentStatus> {
        let p = env.storage().persistent();
        // Check ConfirmationSent first: FillConfirmed has been dispatched.
        if p.has(&DataKey::ConfirmationSent(intent_hash.clone())) {
            return Some(IntentStatus::ConfirmationSent);
        }
        // Settled without ConfirmationSent: deliver_intent ran but
        // dispatch_confirmation has not yet been called (issue #284).
        if p.has(&DataKey::Settled(intent_hash.clone())) {
            return Some(IntentStatus::Filled);
        }
        if p.has(&DataKey::Cancelled(intent_hash.clone())) {
            return Some(IntentStatus::Cancelled);
        }
        // Fall back to the live record for pre-terminal states.
        p.get::<DataKey, IntentRecord>(&DataKey::Intent(intent_hash))
            .map(|r| r.status)
    }

    /// Quote the LayerZero native fee required to dispatch an outbound message
    /// to `dst_eid` (the source-chain EVM escrow). Solvers and keepers MUST
    /// call this before `fill_intent` / `cancel_expired_intent` and pass the
    /// returned value (with a small buffer for fee fluctuation) as `lz_fee`.
    ///
    /// Passing a `lz_fee` below the quoted amount will return
    /// `InsufficientLzFee` from `dispatch`, before any irreversible effect
    /// (token delivery or cancellation) is performed.
    ///
    /// The `message` parameter is a pre-encoded LayerZero payload. Passing a
    /// zero-length message is valid for a rough worst-case estimate; the actual
    /// fee depends on the encoded message length, which is fixed per message
    /// type (FillConfirmed: 90 bytes, CancelIntent: 35 bytes).
    pub fn quote_lz_fee(
        env: Env,
        dst_eid: u32,
        message: soroban_sdk::Bytes,
    ) -> Result<i128, PerihelionError> {
        let receiver: BytesN<32> = env
            .storage()
            .instance()
            .get(&DataKey::Peer(dst_eid))
            .ok_or(PerihelionError::UntrustedPeer)?;
        let endpoint = Self::require_endpoint(&env)?;
        let params = MessagingParams {
            dst_eid,
            receiver,
            message,
        };
        Ok(EndpointClient::new(&env, &endpoint).quote(&params))
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

    /// Whether the given source-chain corridor is individually paused.
    pub fn is_eid_paused(env: Env, eid: u32) -> bool {
        env.storage()
            .instance()
            .get(&DataKey::PausedEid(eid))
            .unwrap_or(false)
    }

    /// Current keeper reward in stroops, paid to callers of `cancel_expired_intent`.
    /// Zero means the keeper incentive is disabled and refunds are self-serve only (issue #173).
    pub fn keeper_reward(env: Env) -> i128 {
        env.storage()
            .instance()
            .get(&DataKey::KeeperReward)
            .unwrap_or(0)
    }

    /// Get the per-intent maximum amount cap. Returns 0 if unlimited (issue #286).
    pub fn get_max_intent_amount(env: Env) -> i128 {
        env.storage()
            .instance()
            .get(&DataKey::MaxIntentAmount)
            .unwrap_or(0)
    }

    /// Get the rolling-window duration in seconds. Returns 0 if disabled (issue #286).
    pub fn get_rolling_window_duration(env: Env) -> u64 {
        env.storage()
            .instance()
            .get(&DataKey::RollingWindowDuration)
            .unwrap_or(0)
    }

    /// Get the rolling-window cap. Returns 0 if unlimited (issue #286).
    pub fn get_rolling_window_cap(env: Env) -> i128 {
        env.storage()
            .instance()
            .get(&DataKey::RollingWindowCap)
            .unwrap_or(0)
    }

    /// Check if the rolling-window cap has been triggered. Returns true if breached (issue #286).
    pub fn is_rolling_window_cap_triggered(env: Env) -> bool {
        env.storage()
            .instance()
            .get(&DataKey::RollingWindowTriggered)
            .unwrap_or(false)
    }

    /// Get the earliest timestamp at which the rolling-window cap can be reset.
    /// Returns None if not triggered (issue #286).
    pub fn get_rolling_window_reset_earliest_at(env: Env) -> Option<u64> {
        env.storage()
            .instance()
            .get(&DataKey::RollingWindowResetEarliestAt)
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

    /// Check neither the global pause nor the per-eid corridor pause.
    fn require_eid_not_paused(env: &Env, eid: u32) -> Result<(), PerihelionError> {
        Self::require_not_paused(env)?;
        if env
            .storage()
            .instance()
            .get(&DataKey::PausedEid(eid))
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

    /// Accept a nonce exactly once, regardless of delivery order. Uses an
    /// unbounded per-`(eid, word_index)` bitmap that mirrors the EVM
    /// `_inboundNonceBitmap[srcEid][wordIndex]` layout (issue #285).
    ///
    /// A nonce `n` is tracked at:
    ///   word_index = n / 64
    ///   bit_index  = n % 64
    ///
    /// Each storage word covers 64 consecutive nonces. Words are created lazily
    /// on first use and **never discarded**, so messages from any in-flight
    /// delivery window (no matter how large the gap between nonces) are always
    /// accepted exactly once. This makes the two implementations semantically
    /// equivalent: no "window advance" can silently drop in-flight messages.
    ///
    /// Storage cost is one persistent entry per 64 nonces, proportional to
    /// actual traffic.
    ///
    /// This is the **LayerZero transport nonce** guard — distinct from the
    /// `Intent.nonce` 256-bit random field in the EIP-712 payload (collision
    /// prevention only). The application-layer idempotency guard is the
    /// `Settled` / `Cancelled` persistent markers. See §11 in
    /// `docs/TECHNICAL-ARCHITECTURE.md`.
    fn accept_nonce(env: &Env, eid: u32, nonce: u64) -> Result<(), PerihelionError> {
        if nonce == 0 {
            return Err(PerihelionError::StaleNonce);
        }

        let word_index: u64 = nonce / 64;
        let bit_index: u32 = (nonce % 64) as u32;
        let bit: u64 = 1u64 << bit_index;

        let ps = env.storage().persistent();
        let word_key = DataKey::InboundNonceWord(eid, word_index);
        let mut word: u64 = ps.get(&word_key).unwrap_or(0);

        if word & bit != 0 {
            // Nonce already consumed — reject as stale/replay.
            return Err(PerihelionError::StaleNonce);
        }

        word |= bit;
        ps.set(&word_key, &word);
        // REPLAY-SAFETY: archival of this entry re-opens the 64 nonces it
        // covers. Always extend TTL to MAX_TTL so the word outlives any
        // realistic in-flight delivery window.
        ps.extend_ttl(&word_key, MAX_TTL / 2, MAX_TTL);
        Ok(())
    }

    /// Check per-intent and rolling-window value caps. Reverts if exceeded.
    fn enforce_value_caps(env: &Env, amount: i128) -> Result<(), PerihelionError> {
        let storage = env.storage().instance();

        // Check 1: Per-intent maximum
        if let Some(max_amount) = storage.get::<DataKey, i128>(&DataKey::MaxIntentAmount) {
            if max_amount > 0 && amount > max_amount {
                return Err(PerihelionError::ExceedsMaxIntentAmount);
            }
        }

        // Check 2: Rolling-window cap (disabled if duration is zero)
        if let Some(duration) = storage.get::<DataKey, u64>(&DataKey::RollingWindowDuration) {
            if duration > 0 {
                if let Some(cap) = storage.get::<DataKey, i128>(&DataKey::RollingWindowCap) {
                    if cap > 0 {
                        // Reject if cap has already been triggered.
                        if let Some(true) =
                            storage.get::<DataKey, bool>(&DataKey::RollingWindowTriggered)
                        {
                            return Err(PerihelionError::RollingWindowCapTriggered);
                        }

                        // Calculate current window start. Each window spans [windowStart, windowStart + duration).
                        let now = env.ledger().timestamp();
                        let window_start = (now / duration) * duration;

                        // Advance memoized window if time has moved to a new bucket.
                        let latest_window_start = storage
                            .get::<DataKey, u64>(&DataKey::LatestWindowStart)
                            .unwrap_or(0);
                        if window_start > latest_window_start {
                            storage.set(&DataKey::LatestWindowStart, &window_start);
                            // In a new window; prior bucket is abandoned. Restart accumulator.
                            if let Some(prev_start) = latest_window_start.checked_sub(duration) {
                                storage.remove(&DataKey::RollingWindowBucket(prev_start));
                            }
                        }

                        // Accumulate this intent's amount into the current window.
                        let accumulated = storage
                            .get::<DataKey, i128>(&DataKey::RollingWindowBucket(window_start))
                            .unwrap_or(0)
                            .checked_add(amount)
                            .ok_or(PerihelionError::ArithmeticError)?;

                        if accumulated > cap {
                            // Cap exceeded: trigger halt and record the window for diagnostics.
                            storage.set(&DataKey::RollingWindowTriggered, &true);
                            storage.set(
                                &DataKey::RollingWindowResetEarliestAt,
                                &now.checked_add(duration)
                                    .ok_or(PerihelionError::ArithmeticError)?,
                            );
                            env.events().publish(
                                (events::ROLLING_WINDOW_CAP_TRIGGERED,),
                                (window_start, accumulated),
                            );
                            return Err(PerihelionError::RollingWindowCapExceeded);
                        }

                        // Update the bucket.
                        storage.set(&DataKey::RollingWindowBucket(window_start), &accumulated);
                    }
                }
            }
        }

        Ok(())
    }

    fn on_fill_instruction(
        env: &Env,
        transport_src_eid: u32,
        fi: FillInstruction,
    ) -> Result<(), PerihelionError> {
        // The intent's return-path eid must equal the transport-authenticated
        // origin eid. If they differ, a compromised or misconfigured adapter
        // could declare a different src_eid in the body and route the eventual
        // FillConfirmed/CancelIntent to a different chain than the one that
        // actually locked the funds. We override fi.src_eid with the transport
        // value rather than just asserting-equal so that adapters are not
        // required to populate the field (they may leave it zero); the
        // authoritative value is always the transport origin.
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

        // Issue #15/#289: verify that a peer is configured for transport_src_eid BEFORE
        // registering the intent. If no peer exists for this eid, dispatch
        // (FillConfirmed / CancelIntent) will fail at settlement time with
        // UntrustedPeer, permanently stranding the intent. Rejecting here
        // surfaces the operator misconfiguration early and prevents stranding.
        //
        // Peer symmetry note: `DataKey::Peer(src_eid)` is the same entry used
        // by both inbound validation (lz_receive checks origin.sender against
        // Peer(origin.src_eid)) and outbound dispatch (dispatch looks up
        // Peer(rec.src_eid) to find the EVM escrow receiver). This is intentional
        // and documented in set_peer above.
        //
        // Note on the two distinct src_eid values:
        // - `origin.src_eid` (LayerZero transport source): the eid of the chain
        //   that sent this LayerZero message. Already validated by lz_receive
        //   against the registered peer before we arrive here.
        // - `fi.src_eid` (intent source eid): the eid embedded inside the
        //   FillInstruction payload, identifying which chain holds the locked
        //   funds. For well-formed messages from a compliant EVM escrow these
        //   two values are always equal (the escrow sets fi.src_eid = stellarEid
        //   which is the Stellar endpoint id, NOT its own eid; see the EVM codec).
        //   We validate against transport_src_eid because that is what dispatch
        //   will use at settlement time (stored in rec.src_eid).
        if !env
            .storage()
            .instance()
            .has(&DataKey::Peer(transport_src_eid))
        {
            return Err(PerihelionError::UntrustedPeer);
        }

        // Check value caps before registering the intent.
        Self::enforce_value_caps(env, fi.min_dest_amount)?;

        let rec = IntentRecord {
            intent_hash: fi.intent_hash.clone(),
            // Use transport_src_eid (authenticated) instead of fi.src_eid (body-declared).
            src_eid: transport_src_eid,
            recipient: fi.recipient,
            dest_asset: fi.dest_asset,
            min_dest_amount: fi.min_dest_amount,
            deadline: fi.deadline,
            preferred_solver: fi.preferred_solver,
            reservation_expires: if fi.reservation_window > 0 {
                env.ledger()
                    .timestamp()
                    .saturating_add(fi.reservation_window)
            } else {
                fi.deadline
            },
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
            (events::REGISTERED, fi.intent_hash),
            (transport_src_eid, fi.deadline),
        );
        Ok(())
    }

    fn on_cancel_inbound(env: &Env, ci: CancelInstruction) -> Result<(), PerihelionError> {
        if Self::is_finalized(env, &ci.intent_hash) {
            // Emit cancel_ignored event to record the race: cancel arrived after intent was finalized.
            // This enables auditing and reconciliation to distinguish "never arrived" from "lost race".
            let observed = if env.storage().persistent().has(&DataKey::Cancelled(ci.intent_hash.clone())) {
                IntentStatus::Cancelled
            } else {
                IntentStatus::ConfirmationSent
            };
            env.events().publish(
                (events::CANCEL_IGNORED, ci.intent_hash.clone()),
                (observed as u32,),
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
                    (events::CANCELLED_INBOUND, ci.intent_hash.clone()),
                    (rec.src_eid,),
                );
            } else {
                // Cancel arrived for an intent in a non-Locked state (Filled, ConfirmationSent).
                // Emit cancel_ignored event to record the race.
                env.events().publish(
                    (events::CANCEL_IGNORED, ci.intent_hash.clone()),
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
        let mut rep: SolverReputationRecord =
            env.storage()
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
        // Pre-check: quote the required fee and reject early if underpaid.
        // This surfaces fee estimation failures as InsufficientLzFee rather
        // than an opaque revert from inside the endpoint, enabling solver
        // operators to distinguish underpayment from other dispatch errors.
        let client = EndpointClient::new(env, &endpoint);
        let required = client.quote(&params);
        if lz_fee < required {
            return Err(PerihelionError::InsufficientLzFee);
        }
        client.send(&params, payer, &lz_fee);
        Ok(())
    }

    /// TTL bump target covering `deadline + GRACE`, clamped to `MAX_TTL`.
    ///
    /// Divides by `MIN_SECS_PER_LEDGER` (4 s) to over-provision the ledger
    /// count when actual close times are longer. This is the safe direction:
    /// a too-generous TTL wastes a small amount of rent but an under-estimate
    /// can archive the entry before the deadline passes.
    ///
    /// The division and `.min(MAX_TTL as u64)` clamp are performed in `u64`
    /// **before** the cast to `u32` (issue #30). A plain `as u32` on a `u64`
    /// value exceeding `u32::MAX` wraps modulo 2^32, producing a deceptively
    /// small TTL for a far-future deadline. By clamping first we guarantee the
    /// value is provably in `[0, MAX_TTL]` when narrowed.
    fn ttl_for_deadline(env: &Env, deadline: u64) -> u32 {
        let now = env.ledger().timestamp();
        let secs = deadline.saturating_sub(now);
        let ledgers_u64 = (secs / MIN_SECS_PER_LEDGER)
            .saturating_add(GRACE_LEDGERS as u64)
            .min(MAX_TTL as u64);
        // Safe: value is in [0, MAX_TTL] ⊆ [0, u32::MAX].
        ledgers_u64 as u32
    }
}
