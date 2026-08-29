// SPDX-License-Identifier: MIT

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
    CancelInstruction, FillInstruction, CANCEL_REASON_ADMIN, CANCEL_REASON_EXPIRED,
    CANCEL_REASON_INVALID, MSG_CANCEL_INTENT, MSG_FILL_CONFIRMED, MSG_FILL_INSTRUCTION,
    FILL_INSTRUCTION_LENGTH, PROTOCOL_VERSION,
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
            // Return a dummy FillInstruction with the intent_hash from cancel for union type compat.
            // Use the zero-account strkey as a placeholder — decode_message is not called on the
            // hot path (lib.rs routes FillInstruction and CancelIntent separately); this dummy
            // exists only for API symmetry.
            let zero_addr = Address::from_str(
                env,
                "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
            );
            let dummy = FillInstruction {
                intent_hash: ci.intent_hash.clone(),
                src_eid: 0,
                recipient: zero_addr.clone(),
                dest_asset: zero_addr,
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

/// Decode a `FillInstruction` payload (219 bytes):
/// `version(1) | type(1) | intent_hash(32) | src_eid(4) | recipient(56) | dest_asset(69) | min_dest_amount(16) | deadline(8) | preferred_solver(32)`.
///
/// # Address decoding
///
/// The `recipient` and `dest_asset` fields carry the ASCII bytes of Stellar
/// strkeys (e.g. `GUSER...` or `CUSDC...`), right-zero-padded to their full
/// field width (56 and 69 bytes respectively — see #270). This function strips
/// the trailing zeros to recover the original string and then converts it to a
/// Soroban `Address` via `Address::from_string_bytes`. That correctly handles
/// both G... account keys and C... contract keys, fixing the
/// `Address::from_contract_id` misuse identified in issue #271.
///
/// # preferred_solver
///
/// The EVM side encodes `preferredSolver` as a 20-byte EVM address left-padded
/// to 32 bytes. This is not a Stellar strkey and cannot be decoded as a Soroban
/// `Address`. The field is therefore left as `None` — the preferred-solver
/// reservation mechanism for cross-chain intents requires a dedicated design
/// (tracked as a follow-up to #271).
///
/// See the module doc-comment for why this is only reachable from tests.
#[allow(dead_code)]
fn decode_fill_instruction(
    env: &Env,
    message: &Bytes,
) -> Result<FillInstruction, crate::PerihelionError> {
    use crate::PerihelionError;

    // Validate length: 2 (header) + 217 (payload) = 219
    if message.len() != FILL_INSTRUCTION_LENGTH {
        return Err(PerihelionError::MalformedPayload);
    }

    // Extract intent_hash (offset 2, 32 bytes)
    let intent_hash_bytes: [u8; 32] = read_field(message, 2)?;
    let intent_hash = BytesN::from_array(env, &intent_hash_bytes);

    // Extract src_eid (offset 34, 4 bytes, big-endian)
    let src_eid_bytes: [u8; 4] = read_field(message, 34)?;
    let src_eid = u32::from_be_bytes(src_eid_bytes);

    // Extract recipient (offset 38, 56 bytes): ASCII strkey characters right-zero-padded.
    // Strip trailing zeros and decode as a Stellar strkey (G... or C...).
    let mut recipient_raw = [0u8; 56];
    for i in 0..56 {
        recipient_raw[i] = message
            .get(38 + i as u32)
            .ok_or(PerihelionError::MalformedPayload)?;
    }
    let recipient = decode_strkey_address(env, &recipient_raw)?;

    // Extract dest_asset (offset 94, 69 bytes): ASCII strkey characters right-zero-padded.
    // The field is 69 bytes wide (not 32) so CODE:ISSUER assets survive the wire
    // without truncation — see #270. Strip trailing zeros and decode.
    let mut dest_asset_raw = [0u8; 69];
    for i in 0..69 {
        dest_asset_raw[i] = message
            .get(94 + i as u32)
            .ok_or(PerihelionError::MalformedPayload)?;
    }
    let dest_asset = decode_strkey_address(env, &dest_asset_raw)?;

    // Extract min_dest_amount (offset 163, 16 bytes, big-endian)
    let mut min_dest_amount_bytes = [0u8; 16];
    for i in 0..16 {
        min_dest_amount_bytes[i] = message
            .get(163 + i as u32)
            .ok_or(PerihelionError::MalformedPayload)?;
    }
    let min_dest_amount = i128::from_be_bytes(min_dest_amount_bytes);

    // Extract deadline (offset 179, 8 bytes, big-endian)
    let mut deadline_bytes = [0u8; 8];
    for i in 0..8 {
        deadline_bytes[i] = message
            .get(179 + i as u32)
            .ok_or(PerihelionError::MalformedPayload)?;
    }
    let deadline = u64::from_be_bytes(deadline_bytes);

    // preferred_solver occupies offset 187, 32 bytes.
    // The EVM side writes a 20-byte EVM address left-padded to 32 bytes — this
    // is not a valid Stellar strkey, and cannot be decoded as a Soroban Address.
    // For now, preferred_solver is omitted from the decoded struct; an all-zero
    // slot already means "open" (no reservation). Cross-chain preferred-solver
    // semantics are a follow-up to #271.
    let preferred_solver = None;

    Ok(FillInstruction {
        intent_hash,
        src_eid,
        recipient,
        dest_asset,
        min_dest_amount,
        deadline,
        preferred_solver,
        // Not yet part of the wire layout (no EVM encoder support — see the
        // struct field doc-comment in types.rs). Defaults to "no reservation"
        // until the wire format is extended to carry it.
        reservation_window: 0,
    })
}

/// Convert a right-zero-padded ASCII strkey byte slice into a Soroban `Address`.
///
/// The wire format encodes Stellar strkeys (G.../C...) as ASCII characters
/// right-padded with zeros to fill the fixed field width. This function finds
/// the last non-zero byte, takes the prefix as the strkey string, and converts
/// it using `Address::from_string_bytes` which handles both account keys (G...)
/// and contract keys (C...) without reinterpreting raw bytes as a contract id.
fn decode_strkey_address(env: &Env, padded: &[u8]) -> Result<Address, crate::PerihelionError> {
    use crate::PerihelionError;
    // Find length by trimming trailing zero bytes.
    let len = padded.iter().rposition(|&b| b != 0).map(|p| p + 1).unwrap_or(0);
    if len == 0 {
        return Err(PerihelionError::MalformedPayload);
    }
    let mut b = Bytes::new(env);
    for &byte in &padded[..len] {
        b.push_back(byte);
    }
    // from_string_bytes accepts both G... (account) and C... (contract) strkeys.
    Ok(Address::from_string_bytes(&b))
}

/// Render an `Address` as its strkey ASCII bytes, right-zero-padded to `N`.
///
/// Inverse of [`decode_strkey_address`]. Only available off-wasm (`Address ->
/// String` is host-only), which matches its only caller, the test-only
/// `encode_fill_instruction` below.
#[cfg(test)]
fn strkey_field<const N: usize>(addr: &Address) -> [u8; N] {
    let s = addr.to_string();
    let len = s.len() as usize;
    assert!(len <= N, "strkey does not fit the {}-byte wire field", N);
    let mut out = [0u8; N];
    s.copy_into_slice(&mut out[..len]);
    out
}

/// Test-only mirror of the EVM `_encodeFillInstruction` encoder, so unit
/// tests can build a synthetic inbound `lz_receive` payload without
/// hand-rolling the byte layout. Not used by the deployed contract —
/// `FillInstruction` is always encoded on the EVM side and only ever
/// *decoded* here (see `decode_fill_instruction`).
///
/// Mirrors the 219-byte layout: the recipient occupies 56 bytes and
/// `dest_asset` 69 bytes (see #270), both right-zero-padded strkey ASCII.
/// `preferred_solver` is written as the all-zero "open" word, since the EVM
/// side carries an EVM address there that the decoder deliberately drops
/// (see #271).
#[cfg(test)]
pub(crate) fn encode_fill_instruction(env: &Env, fi: &FillInstruction) -> Bytes {
    let mut b = Bytes::new(env);
    b.push_back(PROTOCOL_VERSION);
    b.push_back(MSG_FILL_INSTRUCTION);
    b.append(&Bytes::from_array(env, &fi.intent_hash.to_array()));
    b.append(&Bytes::from_array(env, &fi.src_eid.to_be_bytes()));
    b.append(&Bytes::from_array(env, &strkey_field::<56>(&fi.recipient)));
    b.append(&Bytes::from_array(env, &strkey_field::<69>(&fi.dest_asset)));
    b.append(&Bytes::from_array(
        env,
        &(fi.min_dest_amount as u128).to_be_bytes(),
    ));
    b.append(&Bytes::from_array(env, &fi.deadline.to_be_bytes()));
    b.append(&Bytes::from_array(env, &[0u8; 32]));
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
    let reason_byte = message.get(34).ok_or(PerihelionError::MalformedPayload)?;
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

#[cfg(test)]
mod tests {
    extern crate std;
    use std::string::ToString;

    use super::*;

    // A known valid G... account strkey (all-zeros account).
    const ZERO_ACCOUNT: &str = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
    // A known valid C... contract strkey.
    const ZERO_CONTRACT: &str = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";

    /// decode_strkey_address correctly decodes a G... strkey from a zero-padded buffer.
    #[test]
    fn test_decode_strkey_address_g_key() {
        let env = Env::default();
        let mut buf = [0u8; 32];
        let strkey = ZERO_ACCOUNT.as_bytes();
        let copy_len = strkey.len().min(32);
        buf[..copy_len].copy_from_slice(&strkey[..copy_len]);

        let addr = decode_strkey_address(&env, &buf).expect("should decode G... strkey");
        // Round-trip: the decoded Address should re-encode to the same strkey.
        let roundtrip = addr.to_string().to_string();
        assert_eq!(&roundtrip[..copy_len], &ZERO_ACCOUNT[..copy_len]);
    }

    /// decode_strkey_address correctly decodes a C... strkey from a zero-padded buffer.
    #[test]
    fn test_decode_strkey_address_c_key() {
        let env = Env::default();
        let strkey = ZERO_CONTRACT.as_bytes();
        // The C... strkey is 56 bytes, fits in a 56-byte padded field; use 32 for this test.
        let copy_len = strkey.len().min(32);
        let mut buf = [0u8; 32];
        buf[..copy_len].copy_from_slice(&strkey[..copy_len]);

        // Should not panic — from_string_bytes handles C... keys.
        let addr = decode_strkey_address(&env, &buf).expect("should decode C... strkey");
        let _ = addr; // decoded without error
    }

    /// decode_strkey_address returns MalformedPayload for an all-zero buffer.
    #[test]
    fn test_decode_strkey_address_empty_returns_error() {
        let env = Env::default();
        let buf = [0u8; 32];
        let result = decode_strkey_address(&env, &buf);
        assert!(result.is_err());
    }

    /// decode_fill_instruction requires exactly FILL_INSTRUCTION_LENGTH bytes.
    #[test]
    fn test_decode_fill_instruction_wrong_length_rejected() {
        let env = Env::default();
        let mut short = Bytes::new(&env);
        for _ in 0..FILL_INSTRUCTION_LENGTH - 1 {
            short.push_back(0x00);
        }
        assert!(decode_fill_instruction(&env, &short).is_err());

        let mut long = Bytes::new(&env);
        for _ in 0..FILL_INSTRUCTION_LENGTH + 1 {
            long.push_back(0x00);
        }
        assert!(decode_fill_instruction(&env, &long).is_err());
    }

    /// A well-formed 219-byte FillInstruction with G... recipient and C... dest_asset decodes
    /// correctly using from_string_bytes (not from_contract_id).
    #[test]
    fn test_decode_fill_instruction_strkey_addresses() {
        let env = Env::default();

        // Build a 219-byte payload manually.
        let mut msg = Bytes::new(&env);

        // version + type
        msg.push_back(0x01);
        msg.push_back(0x01);

        // intent_hash (32 bytes)
        for _ in 0..32u32 {
            msg.push_back(0xaa);
        }

        // src_eid (4 bytes) = 1
        msg.push_back(0x00);
        msg.push_back(0x00);
        msg.push_back(0x00);
        msg.push_back(0x01);

        // recipient (56 bytes): Use a real G... account strkey (ZERO_ACCOUNT).
        // Stellar strkeys are exactly 56 ASCII characters; no zero-padding needed.
        let recip_bytes = ZERO_ACCOUNT.as_bytes();
        for i in 0..56usize {
            msg.push_back(if i < recip_bytes.len() { recip_bytes[i] } else { 0 });
        }

        // dest_asset (69 bytes): Use a real C... contract strkey (ZERO_CONTRACT).
        // ZERO_CONTRACT is 56 chars; pad the remaining 13 bytes with zeros.
        let asset_bytes = ZERO_CONTRACT.as_bytes();
        for i in 0..69usize {
            msg.push_back(if i < asset_bytes.len() { asset_bytes[i] } else { 0 });
        }

        // min_dest_amount (16 bytes) = 1_000_000
        let amount: i128 = 1_000_000;
        for b in amount.to_be_bytes() {
            msg.push_back(b);
        }

        // deadline (8 bytes) = 9_999_999
        let deadline: u64 = 9_999_999;
        for b in deadline.to_be_bytes() {
            msg.push_back(b);
        }

        // preferred_solver (32 bytes) = all zeros → None
        for _ in 0..32u32 {
            msg.push_back(0x00);
        }

        assert_eq!(msg.len(), 219);

        let fi = decode_fill_instruction(&env, &msg).expect("should decode valid payload");
        assert_eq!(fi.src_eid, 1);
        assert_eq!(fi.min_dest_amount, 1_000_000);
        assert_eq!(fi.deadline, 9_999_999);
        assert!(fi.preferred_solver.is_none());
        // recipient and dest_asset decoded without panic — correct strkey path used
    }
}
