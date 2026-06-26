//! Outbound LayerZero payload encoding.
//!
//! Perihelion sends two message types from Stellar to the source chain:
//! `FillConfirmed` (authorize solver payout) and `CancelIntent` (refund the
//! user). Both use the fixed big-endian binary layout from the architecture
//! spec §3.3 so they decode identically in Solidity.
//!
//! Inbound decoding (FillInstruction/Cancel) happens at the endpoint adapter
//! boundary and is represented by the typed [`crate::types::LzMessage`]; see the
//! note there.

use soroban_sdk::{Bytes, BytesN, Env};

use crate::types::{MSG_CANCEL_INTENT, MSG_FILL_CONFIRMED, PROTOCOL_VERSION};

/// Encode a `FillConfirmed` payload (90 bytes):
/// `version(1) | type(1) | intent_hash(32) | solver_evm(32) | amount(16) | ledger(8)`.
///
/// ## `amount` field — informational only
///
/// The `fill_amount` encoded here is the Stellar-side delivery amount, carried
/// for off-chain observability (explorer display, solver accounting). It does
/// **not** control how much the EVM escrow releases: `PerihelionEscrow._onFillConfirmed`
/// releases `l.amount` — the measured-delta locked amount — regardless of this
/// field. That is the correct and intentional design: the source-chain escrow
/// already holds the exact value to release, so re-trusting a Stellar-declared
/// amount would be redundant and would open a griefing vector. The field exists
/// so that off-chain tooling can reconcile the Stellar fill with the EVM payout
/// without a separate RPC call; it must never be used to gate or size the release.
pub fn encode_fill_confirmed(
    env: &Env,
    intent_hash: &BytesN<32>,
    solver_evm: &BytesN<32>,
    fill_amount: i128,
    fill_ledger: u32,
) -> Bytes {
    let mut b = Bytes::new(env);
    b.push_back(PROTOCOL_VERSION);
    b.push_back(MSG_FILL_CONFIRMED);
    b.append(&Bytes::from_array(env, &intent_hash.to_array()));
    b.append(&Bytes::from_array(env, &solver_evm.to_array()));
    // Amount is validated non-negative before encoding; widen to u128 wire form.
    // See doc-comment above: this value is informational and is not used by the
    // EVM escrow to size the release.
    b.append(&Bytes::from_array(
        env,
        &(fill_amount as u128).to_be_bytes(),
    ));
    b.append(&Bytes::from_array(env, &(fill_ledger as u64).to_be_bytes()));
    b
}

/// Encode a `CancelIntent` payload (35 bytes):
/// `version(1) | type(1) | intent_hash(32) | reason(1)`.
pub fn encode_cancel_intent(env: &Env, intent_hash: &BytesN<32>, reason: u8) -> Bytes {
    let mut b = Bytes::new(env);
    b.push_back(PROTOCOL_VERSION);
    b.push_back(MSG_CANCEL_INTENT);
    b.append(&Bytes::from_array(env, &intent_hash.to_array()));
    b.push_back(reason);
    b
}
