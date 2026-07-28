//! LayerZero payload encoding and decoding.
//!
//! Perihelion sends two message types from Stellar to the source chain:
//! `FillConfirmed` (authorize solver payout) and `CancelIntent` (refund the
//! user). It also receives `FillInstruction` and `CancelIntent` from the source
//! chain. All payloads use the fixed big-endian binary layout from the
//! architecture spec §3.3 so they decode identically in Solidity and Rust.
//!
//! ## Why the inbound decoders below are `#[allow(dead_code)]`
//!
//! `Perihelion::lz_receive` (`lib.rs`) takes an already-typed `LzMessage`
//! argument, not raw `Bytes` — Soroban's native contract-call ABI marshals
//! the argument, so the settlement contract itself never parses the
//! EVM-encoded wire bytes directly. `decode_message`/`decode_fill_instruction`/
//! `decode_cancel_intent` define and pin the inbound half of the wire format
//! (mirroring the outbound `encode_*` functions, which *are* used by
//! `lz_receive`'s dispatch of `FillConfirmed`/`CancelIntent`) for whatever
//! adapter eventually bridges raw LayerZero calldata to a typed contract
//! call — endpoint.rs is presently a mock (see docs/differential-fuzzing.md).
//! Until then, their only callers are `fuzz.rs`'s specification-derived and
//! round-trip tests, which is real, load-bearing usage the plain (non-test)
//! `cdylib` build target can't see.

use soroban_sdk::{Address, Bytes, BytesN, Env};

use crate::types::{
    CancelInstruction, FillInstruction, MSG_CANCEL_INTENT, MSG_FILL_CONFIRMED,
    MSG_FILL_INSTRUCTION, PROTOCOL_VERSION,
    CANCEL_REASON_EXPIRED, CANCEL_REASON_ADMIN, CANCEL_REASON_INVALID,
};

/// Build an `Address` from a raw 32-byte contract-id payload.
///
/// `Address::from_contract_id` (used here in older `soroban-sdk` releases) was
/// made a private host-only constructor; guest (wasm) code has no way to build
/// an `Address` directly from bytes. Round-tripping through a strkey string —
/// the only guest-safe path — is a mechanical replacement, not a fix for the
/// truncation issue tracked as issue #271: the bytes decoded here come from a
/// fixed 32-byte wire field that a full Stellar strkey does not fit into
/// losslessly (see the `FillInstruction` decode callers below, and
/// `fuzz.rs`'s pinned-failure test documenting the resulting round-trip gap).
///
/// Encodes the strkey itself via `crate::strkey` rather than the `stellar-strkey`
/// crate: that crate depends on `std`, which conflicts with this contract's
/// own `no_std` panic handler at wasm link time (duplicate `panic_impl`) —
/// it compiles fine for native `cargo test` but breaks the actual
/// `--target wasm32-unknown-unknown` release build. See `strkey.rs`.
///
/// `pub(crate)` so `fuzz.rs` can build the same golden-vector `Address`
/// values the wire-vector README's canonical table specifies, for
/// specification-derived (not just implementation-derived) test coverage.
///
/// See the module doc-comment for why this is only reachable from tests.
#[allow(dead_code)]
pub(crate) fn address_from_contract_id(env: &Env, id: [u8; 32]) -> Address {
    let strkey = crate::strkey::contract_strkey(&id);
    let strkey_str = core::str::from_utf8(&strkey).expect("strkey encoder only emits ASCII");
    Address::from_str(env, strkey_str)
}

/// Encode a `FillConfirmed` payload (90 bytes):
/// `version(1) | type(1) | intent_hash(32) | solver_evm(32) | amount(16) | ledger(8)`.
///
/// ## Field authority
///
/// | Field         | Consumer   | Notes |
/// |---------------|------------|-------|
/// | `intent_hash` | EVM escrow | Identifies the lock to release. |
/// | `solver_evm`  | EVM escrow | Payout destination (may differ from locking solver key). |
/// | `fill_amount` | Off-chain  | Stellar-side delivery amount — **informational only**. |
/// | `fill_ledger` | Off-chain  | Stellar ledger sequence — **informational only**. |
///
/// ## `fill_amount` field — informational only
///
/// The `fill_amount` encoded here is the Stellar-side delivery amount, carried
/// for off-chain observability (explorer display, solver accounting). It does
/// **not** control how much the EVM escrow releases: `PerihelionEscrow._onFillConfirmed`
/// releases `l.amount` — the measured-delta locked amount — regardless of this
/// field. That is the correct and intentional design: the source-chain escrow
/// already holds the exact value to release, so re-trusting a Stellar-declared
/// amount would be redundant and would open a griefing vector. The field is
/// decoded and emitted in the EVM `Released` event so that off-chain tooling can
/// reconcile the Stellar fill with the EVM payout without a separate RPC call;
/// it must never be used to gate or size the release.
///
/// ## `fill_ledger` field — u32 → u64 widening
///
/// Stellar ledger sequence numbers are `u32` (`env.ledger().sequence()`). The
/// wire format encodes them as `u64` (8 bytes, big-endian) for two reasons:
///
/// 1. **Future-proofing**: Stellar's ledger counter will overflow a `u32` in
///    roughly 136 years at current rates. Encoding as `u64` on the wire today
///    costs 4 extra bytes per message and avoids a breaking wire-format change
///    when the Stellar runtime eventually widens the type.
/// 2. **Symmetry**: The EVM side reads the field as `uint64`, so the wire type
///    matches the receiver's native integer width without sign-extension risk.
///
/// The widening is lossless: `fill_ledger as u64` preserves the exact value.
/// The field is decoded and emitted in the EVM `Released` event for dispute
/// resolution and audit; it does not affect fund movement.
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
    // Widen u32 ledger sequence to u64 for the wire format. Lossless cast;
    // rationale in the doc-comment above (future-proofing + EVM symmetry).
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

/// Read a fixed-size big-endian field out of `message` at `offset`.
/// See the module doc-comment for why this is only reachable from tests.
#[allow(dead_code)]
fn read_field<const N: usize>(
    message: &Bytes,
    offset: u32,
) -> Result<[u8; N], crate::PerihelionError> {
    use crate::PerihelionError;
    let mut out = [0u8; N];
    for (i, slot) in out.iter_mut().enumerate() {
        *slot = message
            .get(offset + i as u32)
            .ok_or(PerihelionError::MalformedPayload)?;
    }
    Ok(out)
}

/// Decode an inbound message payload. Returns the message type discriminant and
/// parsed message, or an error if the payload is malformed.
/// Validates version and routes to the appropriate decoder.
/// See the module doc-comment for why this is only reachable from tests.
#[allow(dead_code)]
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
                recipient: address_from_contract_id(env, [0u8; 32]),
                dest_asset: address_from_contract_id(env, [0u8; 32]),
                min_dest_amount: 0,
                deadline: 0,
                preferred_solver: None,
                reservation_window: 0,
            };
            Ok((msg_type, dummy, Some(ci)))
        }
        _ => Err(PerihelionError::MalformedPayload),
    }
}

/// Decode a `FillInstruction` payload (158 bytes):
/// `version(1) | type(1) | intent_hash(32) | src_eid(4) | recipient(32) | dest_asset(32) | min_dest_amount(16) | deadline(8) | preferred_solver(32)`.
/// See the module doc-comment for why this is only reachable from tests.
#[allow(dead_code)]
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
    let intent_hash_bytes: [u8; 32] = read_field(message, 2)?;
    let intent_hash = BytesN::from_array(env, &intent_hash_bytes);

    // Extract src_eid (offset 34, 4 bytes, big-endian)
    let src_eid_bytes: [u8; 4] = read_field(message, 34)?;
    let src_eid = u32::from_be_bytes(src_eid_bytes);

    // Extract recipient (offset 38, 32 bytes strkey body)
    let recipient_bytes: [u8; 32] = read_field(message, 38)?;
    let recipient = address_from_contract_id(env, recipient_bytes);

    // Extract dest_asset (offset 70, 32 bytes)
    let dest_asset_bytes: [u8; 32] = read_field(message, 70)?;
    let dest_asset = address_from_contract_id(env, dest_asset_bytes);

    // Extract min_dest_amount (offset 102, 16 bytes, big-endian)
    let min_dest_amount_bytes: [u8; 16] = read_field(message, 102)?;
    let min_dest_amount = i128::from_be_bytes(min_dest_amount_bytes);

    // Extract deadline (offset 118, 8 bytes, big-endian)
    let deadline_bytes: [u8; 8] = read_field(message, 118)?;
    let deadline = u64::from_be_bytes(deadline_bytes);

    // Extract preferred_solver (offset 126, 32 bytes; if all zeros, None)
    let preferred_solver_bytes: [u8; 32] = read_field(message, 126)?;

    let preferred_solver = if preferred_solver_bytes == [0u8; 32] {
        None
    } else {
        Some(address_from_contract_id(env, preferred_solver_bytes))
    };

    Ok(FillInstruction {
        intent_hash,
        src_eid,
        recipient,
        dest_asset,
        min_dest_amount,
        deadline,
        preferred_solver,
        // Not yet part of the 158-byte wire layout (no EVM encoder support —
        // see the struct field doc-comment in types.rs). Defaults to "no
        // reservation" until the wire format is extended to carry it.
        reservation_window: 0,
    })
}

/// Extract the raw 32-byte contract-id payload backing an `Address`.
///
/// Inverse of [`address_from_contract_id`]. Only available off-wasm (the
/// underlying `Address -> ScAddress` conversion is host-only), which matches
/// its only caller, `encode_fill_instruction`, a test helper that stands in
/// for the EVM-side encoder and never runs in the deployed guest contract.
#[cfg(test)]
fn contract_id_bytes(addr: &Address) -> [u8; 32] {
    use soroban_sdk::xdr::ScAddress;
    match ScAddress::from(addr) {
        ScAddress::Contract(hash) => hash.0,
        ScAddress::Account(_) => panic!("expected a contract address, got an account address"),
    }
}

/// Test-only mirror of the EVM `_encodeFillInstruction` encoder, so unit
/// tests can build a synthetic inbound `lz_receive` payload without
/// hand-rolling the byte layout. Not used by the deployed contract —
/// `FillInstruction` is always encoded on the EVM side and only ever
/// *decoded* here (see `decode_fill_instruction`).
#[cfg(test)]
pub(crate) fn encode_fill_instruction(env: &Env, fi: &FillInstruction) -> Bytes {
    let mut b = Bytes::new(env);
    b.push_back(PROTOCOL_VERSION);
    b.push_back(MSG_FILL_INSTRUCTION);
    b.append(&Bytes::from_array(env, &fi.intent_hash.to_array()));
    b.append(&Bytes::from_array(env, &fi.src_eid.to_be_bytes()));
    b.append(&Bytes::from_array(env, &contract_id_bytes(&fi.recipient)));
    b.append(&Bytes::from_array(env, &contract_id_bytes(&fi.dest_asset)));
    b.append(&Bytes::from_array(
        env,
        &(fi.min_dest_amount as u128).to_be_bytes(),
    ));
    b.append(&Bytes::from_array(env, &fi.deadline.to_be_bytes()));
    let solver_word = match &fi.preferred_solver {
        Some(addr) => contract_id_bytes(addr),
        None => [0u8; 32],
    };
    b.append(&Bytes::from_array(env, &solver_word));
    b
}

/// Decode a `CancelIntent` payload (35 bytes):
/// `version(1) | type(1) | intent_hash(32) | reason(1)`.
/// See the module doc-comment for why this is only reachable from tests.
#[allow(dead_code)]
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
    let intent_hash_bytes: [u8; 32] = read_field(message, 2)?;
    let intent_hash = BytesN::from_array(env, &intent_hash_bytes);

    // Extract and validate reason (offset 34, 1 byte).
    // Only the three cross-chain reason codes are valid on the wire; reject
    // anything else to keep the decoder strict and match EVM behaviour.
    let reason_byte = message
        .get(34)
        .ok_or(PerihelionError::MalformedPayload)?;
    if reason_byte != CANCEL_REASON_EXPIRED
        && reason_byte != CANCEL_REASON_ADMIN
        && reason_byte != CANCEL_REASON_INVALID
    {
        return Err(PerihelionError::MalformedPayload);
    }

    Ok(CancelInstruction {
        intent_hash,
        reason: reason_byte as u32,
    })
}
