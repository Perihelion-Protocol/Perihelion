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
