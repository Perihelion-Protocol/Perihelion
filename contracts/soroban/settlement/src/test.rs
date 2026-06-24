#![cfg(test)]

use super::*;
use soroban_sdk::{
    contract, contractimpl, symbol_short,
    testutils::{Address as _, Ledger as _},
    token, Address, BytesN, Env,
};

// --- Mock LayerZero endpoint --------------------------------------------------
//
// Implements the `send` surface Perihelion depends on, recording each dispatch
// so tests can assert that a FillConfirmed/CancelIntent was emitted. It does not
// perform DVN verification — that is validated at the E2E tier against the real
// stack (see architecture spec §7.3).

#[contract]
pub struct MockEndpoint;

#[contractimpl]
impl MockEndpoint {
    pub fn send(
        env: Env,
        params: MessagingParams,
        _refund_address: Address,
        _native_fee: i128,
    ) -> BytesN<32> {
        let count: u32 = env
            .storage()
            .instance()
            .get(&symbol_short!("count"))
            .unwrap_or(0);
        env.storage()
            .instance()
            .set(&symbol_short!("count"), &(count + 1));
        env.storage()
            .instance()
            .set(&symbol_short!("last"), &params);
        BytesN::from_array(&env, &[0u8; 32])
    }

    pub fn sent(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&symbol_short!("count"))
            .unwrap_or(0)
    }

    pub fn last(env: Env) -> MessagingParams {
        env.storage()
            .instance()
            .get(&symbol_short!("last"))
            .unwrap()
    }
}

// --- Test harness -------------------------------------------------------------

struct Setup {
    env: Env,
    client: PerihelionClient<'static>,
    mock: MockEndpointClient<'static>,
    asset: Address,
    asset_admin: token::StellarAssetClient<'static>,
    src_eid: u32,
    peer: BytesN<32>,
}

fn setup() -> Setup {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().with_mut(|li| {
        li.timestamp = 1_000;
        li.max_entry_ttl = 3_110_400;
    });

    let admin = Address::generate(&env);
    let endpoint = env.register(MockEndpoint, ());
    let mock = MockEndpointClient::new(&env, &endpoint);

    let id = env.register(Perihelion, ());
    let client = PerihelionClient::new(&env, &id);
    client.initialize(&admin, &endpoint);

    let src_eid = 30101u32;
    let peer = BytesN::from_array(&env, &[0xEE; 32]);
    client.set_peer(&src_eid, &peer);

    let issuer = Address::generate(&env);
    let sac = env.register_stellar_asset_contract_v2(issuer);
    let asset = sac.address();
    let asset_admin = token::StellarAssetClient::new(&env, &asset);

    Setup {
        env,
        client,
        mock,
        asset,
        asset_admin,
        src_eid,
        peer,
    }
}

fn hash(env: &Env, b: u8) -> BytesN<32> {
    BytesN::from_array(env, &[b; 32])
}

#[allow(clippy::too_many_arguments)]
fn register_intent(
    s: &Setup,
    h: &BytesN<32>,
    recipient: &Address,
    min: i128,
    deadline: u64,
    nonce: u64,
    preferred: Option<Address>,
) {
    let fi = FillInstruction {
        intent_hash: h.clone(),
        src_eid: s.src_eid,
        recipient: recipient.clone(),
        dest_asset: s.asset.clone(),
        min_dest_amount: min,
        deadline,
        preferred_solver: preferred,
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

// --- Happy path ---------------------------------------------------------------

#[test]
fn registers_and_fills() {
    let s = setup();
    let recipient = Address::generate(&s.env);
    let solver = Address::generate(&s.env);
    s.asset_admin.mint(&solver, &1_000_000);

    let h = hash(&s.env, 1);
    register_intent(&s, &h, &recipient, 100_000, 5_000, 1, None);
    assert!(s.client.get_intent(&h).is_some());

    let solver_evm = BytesN::from_array(&s.env, &[0x11; 32]);
    s.client.fill_intent(&solver, &solver_evm, &h, &250_000, &0);

    let tok = token::TokenClient::new(&s.env, &s.asset);
    assert_eq!(tok.balance(&recipient), 250_000);
    assert_eq!(tok.balance(&solver), 750_000);
    assert!(s.client.is_settled(&h));
    assert_eq!(s.mock.sent(), 1); // FillConfirmed dispatched
    assert_eq!(
        s.client.get_intent(&h).unwrap().status,
        IntentStatus::ConfirmationSent
    );
}

#[test]
fn cancel_after_deadline_notifies_source() {
    let s = setup();
    let recipient = Address::generate(&s.env);
    let caller = Address::generate(&s.env);
    let h = hash(&s.env, 2);
    register_intent(&s, &h, &recipient, 100_000, 5_000, 1, None);

    s.env.ledger().with_mut(|li| li.timestamp = 6_000); // past deadline
    s.client.cancel_expired_intent(&caller, &h, &0);

    assert!(s.client.is_cancelled(&h));
    assert_eq!(s.mock.sent(), 1); // CancelIntent dispatched
    assert_eq!(
        s.client.get_intent(&h).unwrap().status,
        IntentStatus::Cancelled
    );
}

// --- Invariant guards ---------------------------------------------------------

#[test]
#[should_panic(expected = "Error(Contract, #141)")] // IntentFinalized
fn rejects_double_fill() {
    let s = setup();
    let recipient = Address::generate(&s.env);
    let solver = Address::generate(&s.env);
    s.asset_admin.mint(&solver, &1_000_000);
    let h = hash(&s.env, 3);
    register_intent(&s, &h, &recipient, 1, 5_000, 1, None);
    let evm = BytesN::from_array(&s.env, &[0x11; 32]);
    s.client.fill_intent(&solver, &evm, &h, &100, &0);
    s.client.fill_intent(&solver, &evm, &h, &100, &0); // already settled
}

#[test]
#[should_panic(expected = "Error(Contract, #144)")] // InsufficientFillAmount
fn rejects_fill_below_floor() {
    let s = setup();
    let recipient = Address::generate(&s.env);
    let solver = Address::generate(&s.env);
    s.asset_admin.mint(&solver, &1_000_000);
    let h = hash(&s.env, 4);
    register_intent(&s, &h, &recipient, 100_000, 5_000, 1, None);
    let evm = BytesN::from_array(&s.env, &[0x11; 32]);
    s.client.fill_intent(&solver, &evm, &h, &99_999, &0);
}

#[test]
#[should_panic(expected = "Error(Contract, #142)")] // IntentExpired
fn rejects_fill_after_deadline() {
    let s = setup();
    let recipient = Address::generate(&s.env);
    let solver = Address::generate(&s.env);
    s.asset_admin.mint(&solver, &1_000_000);
    let h = hash(&s.env, 5);
    register_intent(&s, &h, &recipient, 1, 5_000, 1, None);
    s.env.ledger().with_mut(|li| li.timestamp = 5_000); // == deadline
    let evm = BytesN::from_array(&s.env, &[0x11; 32]);
    s.client.fill_intent(&solver, &evm, &h, &100, &0);
}

#[test]
#[should_panic(expected = "Error(Contract, #143)")] // DeadlineNotPassed
fn rejects_cancel_before_deadline() {
    let s = setup();
    let recipient = Address::generate(&s.env);
    let caller = Address::generate(&s.env);
    let h = hash(&s.env, 6);
    register_intent(&s, &h, &recipient, 1, 5_000, 1, None);
    s.client.cancel_expired_intent(&caller, &h, &0); // timestamp 1_000 < 5_000
}

#[test]
#[should_panic(expected = "Error(Contract, #140)")] // IntentNotFound
fn rejects_fill_of_unknown_intent() {
    let s = setup();
    let solver = Address::generate(&s.env);
    let evm = BytesN::from_array(&s.env, &[0x11; 32]);
    s.client
        .fill_intent(&solver, &evm, &hash(&s.env, 99), &100, &0);
}

#[test]
#[should_panic(expected = "Error(Contract, #132)")] // ReservedForSolver
fn rejects_fill_by_non_preferred_solver() {
    let s = setup();
    let recipient = Address::generate(&s.env);
    let preferred = Address::generate(&s.env);
    let solver = Address::generate(&s.env);
    s.asset_admin.mint(&solver, &1_000_000);
    let h = hash(&s.env, 7);
    register_intent(&s, &h, &recipient, 1, 5_000, 1, Some(preferred));
    let evm = BytesN::from_array(&s.env, &[0x11; 32]);
    s.client.fill_intent(&solver, &evm, &h, &100, &0);
}

#[test]
#[should_panic(expected = "Error(Contract, #163)")] // UntrustedPeer
fn rejects_message_from_untrusted_peer() {
    let s = setup();
    let recipient = Address::generate(&s.env);
    let fi = FillInstruction {
        intent_hash: hash(&s.env, 8),
        src_eid: s.src_eid,
        recipient,
        dest_asset: s.asset.clone(),
        min_dest_amount: 1,
        deadline: 5_000,
        preferred_solver: None,
    };
    let bad_sender = BytesN::from_array(&s.env, &[0xAB; 32]);
    let origin = Origin {
        src_eid: s.src_eid,
        sender: bad_sender,
        nonce: 1,
    };
    let guid = BytesN::from_array(&s.env, &[0u8; 32]);
    s.client
        .lz_receive(&origin, &guid, &LzMessage::FillInstruction(fi));
}

#[test]
#[should_panic(expected = "Error(Contract, #162)")] // StaleNonce
fn rejects_replayed_nonce() {
    let s = setup();
    let recipient = Address::generate(&s.env);
    register_intent(&s, &hash(&s.env, 9), &recipient, 1, 5_000, 5, None);
    // Second message reuses nonce 5 (<= high-water mark) -> rejected.
    register_intent(&s, &hash(&s.env, 10), &recipient, 1, 5_000, 5, None);
}

#[test]
#[should_panic(expected = "Error(Contract, #100)")] // AlreadyInitialized
fn rejects_double_initialize() {
    let s = setup();
    let admin = Address::generate(&s.env);
    let endpoint = Address::generate(&s.env);
    s.client.initialize(&admin, &endpoint);
}

#[test]
#[should_panic(expected = "Error(Contract, #102)")] // ContractPaused
fn rejects_fill_while_paused() {
    let s = setup();
    s.client.set_paused(&true);
    let solver = Address::generate(&s.env);
    let evm = BytesN::from_array(&s.env, &[0x11; 32]);
    s.client
        .fill_intent(&solver, &evm, &hash(&s.env, 11), &100, &0);
}

// --- Outbound codec -----------------------------------------------------------

#[test]
fn fill_confirmed_payload_layout() {
    let env = Env::default();
    let h = BytesN::from_array(&env, &[1u8; 32]);
    let solver = BytesN::from_array(&env, &[2u8; 32]);
    let b = crate::messages::encode_fill_confirmed(&env, &h, &solver, 1234, 7);
    assert_eq!(b.len(), 90);
    assert_eq!(b.get(0).unwrap(), PROTOCOL_VERSION);
    assert_eq!(b.get(1).unwrap(), MSG_FILL_CONFIRMED);
}

#[test]
fn cancel_intent_payload_layout() {
    let env = Env::default();
    let h = BytesN::from_array(&env, &[9u8; 32]);
    let b = crate::messages::encode_cancel_intent(&env, &h, CANCEL_REASON_EXPIRED);
    assert_eq!(b.len(), 35);
    assert_eq!(b.get(0).unwrap(), PROTOCOL_VERSION);
    assert_eq!(b.get(1).unwrap(), MSG_CANCEL_INTENT);
    assert_eq!(b.get(34).unwrap(), CANCEL_REASON_EXPIRED);
}

// --- Cross-chain wire-format conformance --------------------------------------
//
// These assert the encoder emits the exact golden bytes in
// `contracts/shared/wire-vectors/`. The EVM decoder has a matching test reading
// the same files, so the two stacks cannot drift apart silently. Keep the inputs
// here in lockstep with the documented canonical values in the vectors README.

const FILL_CONFIRMED_GOLDEN: &str = include_str!("../../../shared/wire-vectors/fill_confirmed.hex");
const CANCEL_INTENT_GOLDEN: &str = include_str!("../../../shared/wire-vectors/cancel_intent.hex");

/// Core-only hex decode of an `0x`-prefixed vector into a fixed-size array.
fn decode_vector<const N: usize>(s: &str) -> [u8; N] {
    let s = s.trim();
    let s = s.strip_prefix("0x").unwrap_or(s);
    let chars = s.as_bytes();
    assert_eq!(chars.len(), 2 * N, "vector length mismatch");
    let mut out = [0u8; N];
    let mut i = 0;
    while i < N {
        out[i] = (nibble(chars[2 * i]) << 4) | nibble(chars[2 * i + 1]);
        i += 1;
    }
    out
}

fn nibble(c: u8) -> u8 {
    match c {
        b'0'..=b'9' => c - b'0',
        b'a'..=b'f' => c - b'a' + 10,
        b'A'..=b'F' => c - b'A' + 10,
        _ => panic!("non-hex character in vector"),
    }
}

fn assert_bytes_eq(actual: &soroban_sdk::Bytes, expected: &[u8]) {
    assert_eq!(actual.len(), expected.len() as u32, "length");
    for (i, b) in expected.iter().enumerate() {
        assert_eq!(actual.get(i as u32).unwrap(), *b, "byte {}", i);
    }
}

#[test]
fn fill_confirmed_matches_golden_vector() {
    let env = Env::default();
    let h = BytesN::from_array(&env, &[0x11u8; 32]);
    let mut solver_word = [0u8; 32];
    let mut i = 12;
    while i < 32 {
        solver_word[i] = 0xAA;
        i += 1;
    }
    let solver = BytesN::from_array(&env, &solver_word);
    let b = crate::messages::encode_fill_confirmed(&env, &h, &solver, 1_000_000, 42);
    assert_bytes_eq(&b, &decode_vector::<90>(FILL_CONFIRMED_GOLDEN));
}

#[test]
fn cancel_intent_matches_golden_vector() {
    let env = Env::default();
    let h = BytesN::from_array(&env, &[0x22u8; 32]);
    let b = crate::messages::encode_cancel_intent(&env, &h, CANCEL_REASON_EXPIRED);
    assert_bytes_eq(&b, &decode_vector::<35>(CANCEL_INTENT_GOLDEN));
}

// --- Lifecycle -> wire integration --------------------------------------------
//
// These run a full register -> fill / cancel lifecycle and assert the message it
// dispatches is exactly what the EVM escrow will decode: `intent_hash` at offset
// 2 and `solver_evm` at offset 34 are the fields PerihelionEscrow's decoders
// read. Together with the EVM-side relay round trips, this closes the loop that
// what Soroban emits is what the source chain consumes.

#[test]
fn fill_dispatches_evm_decodable_confirmation() {
    let s = setup();
    let recipient = Address::generate(&s.env);
    let solver = Address::generate(&s.env);
    s.asset_admin.mint(&solver, &1_000_000);

    let h = hash(&s.env, 1);
    register_intent(&s, &h, &recipient, 100_000, 5_000, 1, None);
    let solver_evm = BytesN::from_array(&s.env, &[0xAB; 32]);
    s.client.fill_intent(&solver, &solver_evm, &h, &250_000, &0);

    let msg = s.mock.last().message;
    assert_eq!(msg.len(), 90);
    assert_eq!(msg.get(0).unwrap(), PROTOCOL_VERSION);
    assert_eq!(msg.get(1).unwrap(), MSG_FILL_CONFIRMED);
    let hb = h.to_array();
    let sb = solver_evm.to_array();
    for (i, (hbyte, sbyte)) in hb.iter().zip(sb.iter()).enumerate() {
        let off = i as u32;
        assert_eq!(msg.get(2 + off).unwrap(), *hbyte, "intent_hash byte {}", i);
        assert_eq!(msg.get(34 + off).unwrap(), *sbyte, "solver_evm byte {}", i);
    }
}

#[test]
fn cancel_dispatches_evm_decodable_cancel() {
    let s = setup();
    let recipient = Address::generate(&s.env);
    let caller = Address::generate(&s.env);

    let h = hash(&s.env, 2);
    register_intent(&s, &h, &recipient, 100_000, 5_000, 1, None);
    s.env.ledger().with_mut(|li| li.timestamp = 6_000); // past deadline
    s.client.cancel_expired_intent(&caller, &h, &0);

    let msg = s.mock.last().message;
    assert_eq!(msg.len(), 35);
    assert_eq!(msg.get(0).unwrap(), PROTOCOL_VERSION);
    assert_eq!(msg.get(1).unwrap(), MSG_CANCEL_INTENT);
    let hb = h.to_array();
    for (i, hbyte) in hb.iter().enumerate() {
        assert_eq!(
            msg.get(2 + i as u32).unwrap(),
            *hbyte,
            "intent_hash byte {}",
            i
        );
    }
    assert_eq!(msg.get(34).unwrap(), CANCEL_REASON_EXPIRED);
}

// --- Solver Reputation (PROPOSED Phase 3) ------------------------------------

#[test]
fn solver_reputation_updates_on_fill() {
    let s = setup();
    let recipient = Address::generate(&s.env);
    let solver = Address::generate(&s.env);
    s.asset_admin.mint(&solver, &500_000);

    let h1 = hash(&s.env, 10);
    register_intent(&s, &h1, &recipient, 100_000, 50_000, 1, None);
    let solver_evm = BytesN::from_array(&s.env, &[0xCC; 32]);
    s.client.fill_intent(&solver, &solver_evm, &h1, &250_000, &0);

    // Check reputation was created
    let rep = s.client.get_solver_reputation(&solver);
    assert!(rep.is_some());
    let rep_rec = rep.unwrap();
    assert_eq!(rep_rec.fill_count, 1);
    assert_eq!(rep_rec.success_count, 1);
    // First fill has ewma_latency of 0

    // Fill a second intent
    let h2 = hash(&s.env, 11);
    register_intent(&s, &h2, &recipient, 100_000, 50_000, 2, None);
    s.client.fill_intent(&solver, &solver_evm, &h2, &250_000, &0);

    let rep2 = s.client.get_solver_reputation(&solver);
    assert!(rep2.is_some());
    let rep2_rec = rep2.unwrap();
    assert_eq!(rep2_rec.fill_count, 2);
    assert_eq!(rep2_rec.success_count, 2);
}

#[test]
fn solver_reputation_returns_none_for_unfilled_solver() {
    let s = setup();
    let solver = Address::generate(&s.env);
    let rep = s.client.get_solver_reputation(&solver);
    assert!(rep.is_none());
}

// --- Split delivery and dispatch (Issue #12) --------------------------------

#[test]
fn deliver_intent_records_filled_without_dispatch() {
    let s = setup();
    let recipient = Address::generate(&s.env);
    let solver = Address::generate(&s.env);
    s.asset_admin.mint(&solver, &500_000);

    let h = hash(&s.env, 20);
    register_intent(&s, &h, &recipient, 100_000, 50_000, 1, None);
    let solver_evm = BytesN::from_array(&s.env, &[0xDD; 32]);

    // Deliver without dispatch
    s.client
        .deliver_intent(&solver, &solver_evm, &h, &250_000);

    // Intent should be in Filled status
    let rec = s.client.get_intent(&h).unwrap();
    assert_eq!(rec.status, IntentStatus::Filled);

    // No confirmation dispatch should have occurred (mock endpoint sent count unchanged)
    let count_after = s.mock.sent();
    assert_eq!(count_after, 0, "deliver_intent should not dispatch");
}

#[test]
fn dispatch_confirmation_sends_message_and_advances_status() {
    let s = setup();
    let recipient = Address::generate(&s.env);
    let solver = Address::generate(&s.env);
    s.asset_admin.mint(&solver, &500_000);

    let h = hash(&s.env, 21);
    register_intent(&s, &h, &recipient, 100_000, 50_000, 1, None);
    let solver_evm = BytesN::from_array(&s.env, &[0xEE; 32]);

    // Deliver first
    s.client
        .deliver_intent(&solver, &solver_evm, &h, &250_000);

    // Then dispatch confirmation (permissionless caller)
    let caller = Address::generate(&s.env);
    s.client.dispatch_confirmation(&caller, &h, &0);

    // Intent should now be ConfirmationSent
    let rec = s.client.get_intent(&h).unwrap();
    assert_eq!(rec.status, IntentStatus::ConfirmationSent);

    // FillConfirmed should have been dispatched
    let count_after = s.mock.sent();
    assert_eq!(count_after, 1);
}

#[test]
#[should_panic(expected = "Error(Contract, #141)")] // IntentFinalized
fn dispatch_confirmation_rejects_double_dispatch() {
    let s = setup();
    let recipient = Address::generate(&s.env);
    let solver = Address::generate(&s.env);
    s.asset_admin.mint(&solver, &500_000);

    let h = hash(&s.env, 22);
    register_intent(&s, &h, &recipient, 100_000, 50_000, 1, None);
    let solver_evm = BytesN::from_array(&s.env, &[0xFF; 32]);

    // Deliver and dispatch
    s.client
        .deliver_intent(&solver, &solver_evm, &h, &250_000);
    let caller = Address::generate(&s.env);
    s.client.dispatch_confirmation(&caller, &h, &0);

    // Second dispatch should fail
    s.client.dispatch_confirmation(&caller, &h, &0);
}

#[test]
#[should_panic(expected = "Error(Contract, #146)")] // AlreadyFilled (not Filled status)
fn dispatch_confirmation_rejects_non_filled_intent() {
    let s = setup();
    let recipient = Address::generate(&s.env);

    let h = hash(&s.env, 23);
    register_intent(&s, &h, &recipient, 100_000, 50_000, 1, None);

    // Try to dispatch before delivering
    let caller = Address::generate(&s.env);
    s.client.dispatch_confirmation(&caller, &h, &0);
}
