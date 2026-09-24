// SPDX-License-Identifier: MIT

//! Assertions for the event-shape specification table documented above
//! `mod events` in `lib.rs` (issues #102 and #679). That table calls each
//! event shape a "VERSIONED INTERFACE" that "must be asserted by tests".
//!
//! Every event topic is the event's full snake_case name, exactly as listed
//! in the table — no abbreviations. Each test here asserts the *actual*
//! emitted topic (symbol + topic count), so a future rename of a topic, or
//! drift between the table and the code, fails a test instead of only being
//! caught by someone reading the source. See `docs/EVENT-SHAPES.md`.

#![cfg(test)]

extern crate std;

use super::*;
use soroban_sdk::{
    contract, contractimpl,
    testutils::{Address as _, Events, Ledger as _},
    token, Address, BytesN, Env, Symbol, TryFromVal,
};

/// Minimal LayerZero endpoint stand-in. `quote` and `send` are exercised by
/// the entrypoints under test here (`dispatch_confirmation` and
/// `cancel_expired_intent`); both are free so no fee needs to be funded.
#[contract]
pub struct EventSpecMockEndpoint;

#[contractimpl]
impl EventSpecMockEndpoint {
    pub fn quote(_env: Env, _params: MessagingParams) -> i128 {
        0
    }

    pub fn send(
        env: Env,
        _params: MessagingParams,
        _refund_address: Address,
        _native_fee: i128,
    ) -> BytesN<32> {
        BytesN::from_array(&env, &[0u8; 32])
    }
}

struct Setup {
    env: Env,
    client: PerihelionClient<'static>,
    src_eid: u32,
    peer: BytesN<32>,
    native_token: Address,
}

fn setup() -> Setup {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().with_mut(|li| {
        li.timestamp = 1_000;
        li.max_entry_ttl = 3_110_400;
    });

    let admin = Address::generate(&env);
    let endpoint = env.register(EventSpecMockEndpoint, ());
    let id = env.register(Perihelion, ());
    let client = PerihelionClient::new(&env, &id);

    let issuer = Address::generate(&env);
    let native_sac = env.register_stellar_asset_contract_v2(issuer);
    let native_token = native_sac.address();

    client.initialize(&admin, &endpoint, &native_token);

    let src_eid = 30101u32;
    let peer = BytesN::from_array(&env, &[0xEE; 32]);
    client.propose_peer(&src_eid, &peer);
    env.ledger().with_mut(|li| {
        li.timestamp = 1_000 + MIN_PEER_CHANGE_DELAY + 1;
    });
    client.confirm_peer(&src_eid);
    env.ledger().with_mut(|li| {
        li.timestamp = 1_000;
    });

    Setup {
        env,
        client,
        src_eid,
        peer,
        native_token,
    }
}

fn hash(env: &Env, b: u8) -> BytesN<32> {
    BytesN::from_array(env, &[b; 32])
}

fn deliver_fill_instruction(
    s: &Setup,
    h: &BytesN<32>,
    recipient: &Address,
    dest_asset: &Address,
    deadline: u64,
    nonce: u64,
) {
    let fi = FillInstruction {
        intent_hash: h.clone(),
        src_eid: s.src_eid,
        recipient: recipient.clone(),
        dest_asset: dest_asset.clone(),
        min_dest_amount: 100,
        deadline,
        preferred_solver: None,
        reservation_window: 0,
    };
    let origin = Origin {
        src_eid: s.src_eid,
        sender: s.peer.clone(),
        nonce,
    };
    let guid = BytesN::from_array(&s.env, &[0u8; 32]);
    s.client
        .lz_receive(&origin, &guid, &LzMessage::FillInstruction(fi));
}

fn deliver_cancel(s: &Setup, h: &BytesN<32>, nonce: u64) {
    let ci = CancelInstruction {
        intent_hash: h.clone(),
        reason: CANCEL_REASON_EXPIRED as u32,
    };
    let origin = Origin {
        src_eid: s.src_eid,
        sender: s.peer.clone(),
        nonce,
    };
    let guid = BytesN::from_array(&s.env, &[0u8; 32]);
    s.client.lz_receive(&origin, &guid, &LzMessage::Cancel(ci));
}

/// Asserts an event with topic[0..] containing `expected_topic` was emitted,
/// with exactly `expected_topic_count` topics (the shape, not just presence).
fn assert_event_shape(env: &Env, expected_topic: &str, expected_topic_count: u32) {
    let expected = Symbol::new(env, expected_topic);
    let events = env.events().all();
    let found = events.iter().any(|(_, topics, _)| {
        topics.len() == expected_topic_count
            && topics.iter().any(|t| {
                Symbol::try_from_val(env, &t)
                    .map(|s| s == expected)
                    .unwrap_or(false)
            })
    });
    assert!(
        found,
        "expected an event with topic '{}' and {} topic(s), none found",
        expected_topic, expected_topic_count
    );
}

// --- Documented as `admin_transfer_started` / `admin_transfer_completed` -----

#[test]
fn admin_transfer_started_topic() {
    let s = setup();
    let new_admin = Address::generate(&s.env);
    s.client.set_admin(&new_admin);
    assert_event_shape(&s.env, "admin_transfer_started", 1);
}

#[test]
fn admin_transfer_completed_topic() {
    let s = setup();
    let new_admin = Address::generate(&s.env);
    s.client.set_admin(&new_admin);
    s.client.accept_admin();
    assert_event_shape(&s.env, "admin_transfer_completed", 1);
}

// --- Documented as `native_token_set` -----------------------------------------

#[test]
fn native_token_set_topic() {
    let s = setup();
    let new_native = Address::generate(&s.env);
    s.client.set_native_token(&new_native);
    assert_event_shape(&s.env, "native_token_set", 1);
}

// --- Documented as `keeper_reward_set` / `keeper_reward_paid` ----------------

#[test]
fn keeper_reward_set_topic() {
    let s = setup();
    s.client.set_keeper_reward(&1_000i128);
    assert_event_shape(&s.env, "keeper_reward_set", 1);
}

#[test]
fn keeper_reward_paid_topic() {
    let s = setup();
    let recipient = Address::generate(&s.env);
    let dest_issuer = Address::generate(&s.env);
    let dest_sac = s.env.register_stellar_asset_contract_v2(dest_issuer);
    let dest_asset = dest_sac.address();

    token::StellarAssetClient::new(&s.env, &s.native_token).mint(&s.client.address, &1_000_000);

    let h = hash(&s.env, 1);
    deliver_fill_instruction(&s, &h, &recipient, &dest_asset, 5_000, 1);

    s.client.set_keeper_reward(&500i128);
    s.env.ledger().with_mut(|li| li.timestamp = 6_000);

    let keeper = Address::generate(&s.env);
    s.client.cancel_expired_intent(&keeper, &h, &0);

    assert_event_shape(&s.env, "keeper_reward_paid", 2);
}

// --- Documented as `confirmation_sent` ----------------------------------------

#[test]
fn confirmation_sent_topic() {
    let s = setup();
    let recipient = Address::generate(&s.env);
    let solver = Address::generate(&s.env);

    let dest_issuer = Address::generate(&s.env);
    let dest_sac = s.env.register_stellar_asset_contract_v2(dest_issuer);
    let dest_asset = dest_sac.address();
    token::StellarAssetClient::new(&s.env, &dest_asset).mint(&solver, &1_000_000);

    let h = hash(&s.env, 2);
    deliver_fill_instruction(&s, &h, &recipient, &dest_asset, 9_000, 1);

    let solver_evm = BytesN::from_array(&s.env, &[0xAB; 32]);
    s.client.deliver_intent(&solver, &solver_evm, &h, &250);

    let caller = Address::generate(&s.env);
    s.client.dispatch_confirmation(&caller, &h, &0);

    assert_event_shape(&s.env, "confirmation_sent", 2);
}

// --- Documented as `cancelled_inbound` / `cancel_ignored` --------------------

#[test]
fn cancelled_inbound_topic() {
    let s = setup();
    let recipient = Address::generate(&s.env);
    let dest_issuer = Address::generate(&s.env);
    let dest_sac = s.env.register_stellar_asset_contract_v2(dest_issuer);
    let dest_asset = dest_sac.address();

    let h = hash(&s.env, 3);
    deliver_fill_instruction(&s, &h, &recipient, &dest_asset, 5_000, 1);
    deliver_cancel(&s, &h, 2);

    assert_event_shape(&s.env, "cancelled_inbound", 2);
}

#[test]
fn cancel_ignored_topic() {
    let s = setup();
    let recipient = Address::generate(&s.env);
    let solver = Address::generate(&s.env);

    let dest_issuer = Address::generate(&s.env);
    let dest_sac = s.env.register_stellar_asset_contract_v2(dest_issuer);
    let dest_asset = dest_sac.address();
    token::StellarAssetClient::new(&s.env, &dest_asset).mint(&solver, &1_000_000);

    let h = hash(&s.env, 4);
    deliver_fill_instruction(&s, &h, &recipient, &dest_asset, 9_000, 1);

    let solver_evm = BytesN::from_array(&s.env, &[0xAB; 32]);
    s.client.deliver_intent(&solver, &solver_evm, &h, &250);

    // Intent is already finalized (Settled) — the inbound cancel is ignored.
    deliver_cancel(&s, &h, 2);

    assert_event_shape(&s.env, "cancel_ignored", 2);
}

// --- Peer rotation delayed-flow events ---------------------------------------

#[test]
fn peer_change_proposed_topic() {
    let s = setup();
    let new_peer = BytesN::from_array(&s.env, &[0x11; 32]);
    s.client.propose_peer(&s.src_eid, &new_peer);
    assert_event_shape(&s.env, "peer_change_proposed", 1);
}

#[test]
fn peer_change_cancelled_topic() {
    let s = setup();
    let new_peer = BytesN::from_array(&s.env, &[0x11; 32]);
    s.client.propose_peer(&s.src_eid, &new_peer);
    s.client.cancel_pending_peer(&s.src_eid);
    assert_event_shape(&s.env, "peer_change_cancelled", 1);
}

// --- Issue #679: topics longer than symbol_short!'s 9-character limit --------
//
// These four, together with admin_transfer_completed, native_token_set,
// keeper_reward_set and peer_change_cancelled above, are the eight events
// whose topics previously failed to compile.

#[test]
fn initialized_topic() {
    let s = setup();
    // `initialize` ran inside `setup`; re-run it on a fresh contract so the
    // event is the latest invocation's output.
    let id = s.env.register(Perihelion, ());
    let client = PerihelionClient::new(&s.env, &id);
    let admin = Address::generate(&s.env);
    let endpoint = s.env.register(EventSpecMockEndpoint, ());
    client.initialize(&admin, &endpoint, &s.native_token);
    assert_event_shape(&s.env, "initialized", 1);
}

#[test]
fn endpoint_set_topic() {
    let s = setup();
    let new_endpoint = s.env.register(EventSpecMockEndpoint, ());
    s.client.propose_endpoint(&new_endpoint);
    s.env.ledger().with_mut(|li| {
        li.timestamp = 1_000 + MIN_PEER_CHANGE_DELAY + 1;
    });
    s.client.confirm_endpoint();
    assert_event_shape(&s.env, "endpoint_set", 1);
}

#[test]
fn paused_set_topic() {
    let s = setup();
    s.client.set_paused(&true);
    assert_event_shape(&s.env, "paused_set", 1);
}

#[test]
fn registered_topic() {
    let s = setup();
    let recipient = Address::generate(&s.env);
    let dest_issuer = Address::generate(&s.env);
    let dest_asset = s
        .env
        .register_stellar_asset_contract_v2(dest_issuer)
        .address();
    let h = hash(&s.env, 5);
    deliver_fill_instruction(&s, &h, &recipient, &dest_asset, 5_000, 1);
    assert_event_shape(&s.env, "registered", 2);
}
