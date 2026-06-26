//! LayerZero payload encoding and decoding.
//!
//! Perihelion sends two message types from Stellar to the source chain:
//! `FillConfirmed` (authorize solver payout) and `CancelIntent` (refund the
//! user). It also receives `FillInstruction` and `CancelIntent` from the source
//! chain. All payloads use the fixed big-endian binary layout from the
//! architecture spec §3.3 so they decode identically in Solidity and Rust.

use soroban_sdk::{Address, Bytes, BytesN, Env};

use crate::types::{
    CancelInstruction, FillInstruction, MSG_CANCEL_INTENT, MSG_FILL_CONFIRMED,
    MSG_FILL_INSTRUCTION, PROTOCOL_VERSION,
};

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

/// Decode an inbound message payload. Returns the message type discriminant and
/// parsed message, or an error if the payload is malformed.
/// Validates version and routes to the appropriate decoder.
pub fn decode_message(
    env: &Env,
    message: &Bytes,
) -> Result<(u8, FillInstruction, Option<CancelInstruction>), crate::PerihelionError> {
    use crate::PerihelionError;

    // Minimum: version(1) + type(1)
    if message.len() < 2 {
        return Err(PerihelionError::MalformedPayload);
    }

    let version = message.get(0).ok_or(PerihelionError::MalformedPayload)?;
    if version != PROTOCOL_VERSION {
        return Err(PerihelionError::MalformedPayload);
    }

    let msg_type = message.get(1).ok_or(PerihelionError::MalformedPayload)?;

    match msg_type {
        MSG_FILL_INSTRUCTION => {
            let fi = decode_fill_instruction(env, message)?;
            Ok((msg_type, fi, None))
        }
        MSG_CANCEL_INTENT => {
            let ci = decode_cancel_intent(env, message)?;
            // Return a dummy FillInstruction with the intent_hash from cancel for union type compat
            let dummy = FillInstruction {
                intent_hash: ci.intent_hash.clone(),
                src_eid: 0,
                recipient: Address::from_contract_id(env, &BytesN::from_array(env, &[0u8; 32])),
                dest_asset: Address::from_contract_id(env, &BytesN::from_array(env, &[0u8; 32])),
                min_dest_amount: 0,
                deadline: 0,
                preferred_solver: None,
            };
            Ok((msg_type, dummy, Some(ci)))
        }
        _ => Err(PerihelionError::MalformedPayload),
    }
}

/// Decode a `FillInstruction` payload (158 bytes):
/// `version(1) | type(1) | intent_hash(32) | src_eid(4) | recipient(32) | dest_asset(32) | min_dest_amount(16) | deadline(8) | preferred_solver(32)`.
fn decode_fill_instruction(
    env: &Env,
    message: &Bytes,
) -> Result<FillInstruction, crate::PerihelionError> {
    use crate::PerihelionError;

    // Validate length: 2 (header) + 156 (payload) = 158
    if message.len() != 158 {
        return Err(PerihelionError::MalformedPayload);
    }

    // Extract intent_hash (offset 2, 32 bytes)
    let mut intent_hash_bytes = [0u8; 32];
    for i in 0..32 {
        intent_hash_bytes[i] = message
            .get(2 + i as u32)
            .ok_or(PerihelionError::MalformedPayload)?;
    }
    let intent_hash = BytesN::from_array(env, &intent_hash_bytes);

    // Extract src_eid (offset 34, 4 bytes, big-endian)
    let mut src_eid_bytes = [0u8; 4];
    for i in 0..4 {
        src_eid_bytes[i] = message
            .get(34 + i as u32)
            .ok_or(PerihelionError::MalformedPayload)?;
    }
    let src_eid = u32::from_be_bytes(src_eid_bytes);

    // Extract recipient (offset 38, 32 bytes strkey body)
    let mut recipient_bytes = [0u8; 32];
    for i in 0..32 {
        recipient_bytes[i] = message
            .get(38 + i as u32)
            .ok_or(PerihelionError::MalformedPayload)?;
    }
    let recipient = Address::from_contract_id(env, &BytesN::from_array(env, &recipient_bytes));

    // Extract dest_asset (offset 70, 32 bytes)
    let mut dest_asset_bytes = [0u8; 32];
    for i in 0..32 {
        dest_asset_bytes[i] = message
            .get(70 + i as u32)
            .ok_or(PerihelionError::MalformedPayload)?;
    }
    let dest_asset = Address::from_contract_id(env, &BytesN::from_array(env, &dest_asset_bytes));

    // Extract min_dest_amount (offset 102, 16 bytes, big-endian)
    let mut min_dest_amount_bytes = [0u8; 16];
    for i in 0..16 {
        min_dest_amount_bytes[i] = message
            .get(102 + i as u32)
            .ok_or(PerihelionError::MalformedPayload)?;
    }
    let min_dest_amount = i128::from_be_bytes(min_dest_amount_bytes);

    // Extract deadline (offset 118, 8 bytes, big-endian)
    let mut deadline_bytes = [0u8; 8];
    for i in 0..8 {
        deadline_bytes[i] = message
            .get(118 + i as u32)
            .ok_or(PerihelionError::MalformedPayload)?;
    }
    let deadline = u64::from_be_bytes(deadline_bytes);

    // Extract preferred_solver (offset 126, 32 bytes; if all zeros, None)
    let mut preferred_solver_bytes = [0u8; 32];
    for i in 0..32 {
        preferred_solver_bytes[i] = message
            .get(126 + i as u32)
            .ok_or(PerihelionError::MalformedPayload)?;
    }

    let preferred_solver = if preferred_solver_bytes == [0u8; 32] {
        None
    } else {
        Some(Address::from_contract_id(
            env,
            &BytesN::from_array(env, &preferred_solver_bytes),
        ))
    };

    Ok(FillInstruction {
        intent_hash,
        src_eid,
        recipient,
        dest_asset,
        min_dest_amount,
        deadline,
        preferred_solver,
    })
}

/// Decode a `CancelIntent` payload (35 bytes):
/// `version(1) | type(1) | intent_hash(32) | reason(1)`.
fn decode_cancel_intent(
    env: &Env,
    message: &Bytes,
) -> Result<CancelInstruction, crate::PerihelionError> {
    use crate::PerihelionError;

    // Validate length: 2 (header) + 33 (payload) = 35
    if message.len() != 35 {
        return Err(PerihelionError::MalformedPayload);
    }

    // Extract intent_hash (offset 2, 32 bytes)
    let mut intent_hash_bytes = [0u8; 32];
    for i in 0..32 {
        intent_hash_bytes[i] = message
            .get(2 + i as u32)
            .ok_or(PerihelionError::MalformedPayload)?;
    }
    let intent_hash = BytesN::from_array(env, &intent_hash_bytes);

    // Extract reason (offset 34, 1 byte)
    let reason = message
        .get(34)
        .ok_or(PerihelionError::MalformedPayload)? as u32;

    Ok(CancelInstruction { intent_hash, reason })
}
