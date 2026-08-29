// SPDX-License-Identifier: MIT

//! Differential fuzzing for the Soroban message encoder.
//!
//! Uses proptest to generate random structured messages and validate:
//! 1. Rust encode -> Rust decode round-trip equality
//! 2. Structural mutations are rejected identically by both sides
//! 3. Cross-language corpus export for Solidity differential validation
//!
//! Run:
//!   cargo test --test fuzz -- --test-threads=1
//!
//! Extended nightly:
//!   PROPTEST_CASES=10000 cargo test --test fuzz -- --test-threads=1

#![cfg(test)]

extern crate std;

use soroban_sdk::{testutils::Address as _, Address, Bytes, BytesN, Env};

use crate::messages::{decode_message, encode_cancel_intent, encode_fill_confirmed};
use crate::types::{
    CANCEL_REASON_ADMIN, CANCEL_REASON_EXPIRED, CANCEL_REASON_INVALID, MSG_CANCEL_INTENT,
    MSG_FILL_CONFIRMED, MSG_FILL_INSTRUCTION, PROTOCOL_VERSION,
};

use proptest::prelude::*;
use std::format;
use std::fs;
use std::path::Path;
use std::string::String;

/// Maximum realistic Stellar stroop amount (~9e18 for a 10M XLM cap).
const MAX_AMOUNT: i128 = i128::MAX;

/// Read a fixed-size field out of an encoded `Bytes` payload at `offset`.
fn read_field<const N: usize>(encoded: &Bytes, offset: u32) -> [u8; N] {
    let mut out = [0u8; N];
    for (i, slot) in out.iter_mut().enumerate() {
        *slot = encoded.get(offset + i as u32).unwrap();
    }
    out
}

/// Arbitrary 32-byte hash generator.
fn arb_hash() -> impl Strategy<Value = [u8; 32]> {
    any::<[u8; 32]>()
}

/// Arbitrary EVM address (20 bytes, left-padded to 32).
fn arb_evm_address() -> impl Strategy<Value = [u8; 32]> {
    any::<[u8; 20]>().prop_map(|addr_20| {
        let mut word = [0u8; 32];
        word[12..32].copy_from_slice(&addr_20);
        word
    })
}

/// Arbitrary fill amount (0..MAX_AMOUNT).
fn arb_amount() -> impl Strategy<Value = i128> {
    0..=MAX_AMOUNT
}

/// Arbitrary ledger sequence (u32 range).
fn arb_ledger() -> impl Strategy<Value = u32> {
    any::<u32>()
}

/// Arbitrary cancel reason code (0x00, 0x01, 0x02).
fn arb_cancel_reason() -> impl Strategy<Value = u8> {
    prop_oneof![
        Just(CANCEL_REASON_EXPIRED),
        Just(CANCEL_REASON_ADMIN),
        Just(CANCEL_REASON_INVALID),
    ]
}

// -------------------------------------------------------------------------
// FillConfirmed round-trip and mutation tests
// -------------------------------------------------------------------------

proptest! {
    #[test]
    fn prop_fill_confirmed_round_trip(
        intent_hash in arb_hash(),
        solver_evm in arb_evm_address(),
        fill_amount in arb_amount(),
        fill_ledger in arb_ledger(),
    ) {
        let env = Env::default();
        let intent_hash_bytes = BytesN::from_array(&env, &intent_hash);
        let solver_evm_bytes = BytesN::from_array(&env, &solver_evm);

        let encoded = encode_fill_confirmed(
            &env,
            &intent_hash_bytes,
            &solver_evm_bytes,
            fill_amount,
            fill_ledger,
        );

        // Assert layout: version(1) | type(1) | hash(32) | solver(32) | amount(16) | ledger(8)
        assert_eq!(encoded.len(), 90, "FillConfirmed must be 90 bytes");
        assert_eq!(encoded.get(0).unwrap(), PROTOCOL_VERSION);
        assert_eq!(encoded.get(1).unwrap(), MSG_FILL_CONFIRMED);

        // Decode hash (bytes 2..34)
        let decoded_hash: [u8; 32] = read_field(&encoded, 2);
        assert_eq!(decoded_hash, intent_hash, "intentHash mismatch");

        // Decode solver_evm (bytes 34..66)
        let decoded_solver: [u8; 32] = read_field(&encoded, 34);
        assert_eq!(decoded_solver, solver_evm, "solverEvm mismatch");

        // Decode amount (bytes 66..82, big-endian u128)
        let amount_bytes: [u8; 16] = read_field(&encoded, 66);
        let decoded_amount = u128::from_be_bytes(amount_bytes) as i128;
        assert_eq!(decoded_amount, fill_amount, "amount mismatch");

        // Decode ledger (bytes 82..90, big-endian u64)
        let ledger_bytes: [u8; 8] = read_field(&encoded, 82);
        let decoded_ledger = u64::from_be_bytes(ledger_bytes) as u32;
        assert_eq!(decoded_ledger, fill_ledger, "ledger mismatch");
    }

    /// Mutation: non-zero high bytes in solver_evm must be rejected by Solidity.
    /// We generate the malformed payload here and export it to the corpus for
    /// cross-language validation.
    #[test]
    fn prop_fill_confirmed_nonzero_high(
        intent_hash in arb_hash(),
        high_bits in any::<[u8; 12]>().prop_filter("high bits must be non-zero", |b| b.iter().any(|&x| x != 0)),
        low_addr in any::<[u8; 20]>(),
        fill_amount in arb_amount(),
        fill_ledger in arb_ledger(),
    ) {
        let env = Env::default();
        let intent_hash_bytes = BytesN::from_array(&env, &intent_hash);

        // Construct malformed solver_evm with non-zero high bits
        let mut malformed_solver = [0u8; 32];
        malformed_solver[0..12].copy_from_slice(&high_bits);
        malformed_solver[12..32].copy_from_slice(&low_addr);
        let solver_evm_bytes = BytesN::from_array(&env, &malformed_solver);

        let encoded = encode_fill_confirmed(
            &env,
            &intent_hash_bytes,
            &solver_evm_bytes,
            fill_amount,
            fill_ledger,
        );

        // This payload is structurally valid on the Rust side (we just encoded it)
        // but MUST be rejected by the Solidity decoder. Export to corpus.
        export_to_corpus("fill_confirmed_nonzero_high", &encoded);

        // The Rust encoder does not validate solver_evm high bits (it's a pass-through).
        // The rejection happens on the Solidity decode side — this test ensures
        // we generate the adversarial case for cross-validation.
        assert_eq!(encoded.len(), 90);
    }
}

// -------------------------------------------------------------------------
// Specification-derived vectors and semantic round-trip
// -------------------------------------------------------------------------
//
// The proptests above are implementation-derived: they generate inputs from
// the Rust encoder and check the Rust decoder agrees with itself. That can
// only prove the two Rust functions are mutual inverses — it cannot catch a
// case where the encoder and decoder agree with each other but both diverge
// from the actual specification (contracts/shared/wire-vectors/README.md),
// which is exactly the failure mode of issue #271 (`Address::from_contract_id`
// reinterprets strkey ASCII text as a raw contract id) and #272
// (`reservation_window` absent from the wire layout). The tests below are
// derived from the golden vectors instead, and from a real Stellar address,
// so they fail if the implementation drifts from the documented layout even
// when both sides of a pure round-trip would still agree.

#[test]
fn fill_instruction_matches_golden_vector() {
    // contracts/shared/wire-vectors/fill_instruction.hex, decoded per the
    // canonical table in contracts/shared/wire-vectors/README.md.
    //
    // The golden vector uses the 219-byte strkey-text layout (issue #270):
    //   recipient  = 56-byte ASCII strkey of [0xBB; 32] contract id
    //   dest_asset = 56-byte ASCII strkey of [0xCC; 32] contract id, right-zero-padded to 69
    //   preferred_solver = all zeros (open) — encode_fill_instruction always writes zeros
    const GOLDEN: &str = include_str!("../../../shared/wire-vectors/fill_instruction.hex");

    let env = Env::default();
    let recipient = crate::messages::address_from_contract_id(&env, [0xBBu8; 32]);
    let dest_asset = crate::messages::address_from_contract_id(&env, [0xCCu8; 32]);

    let fi = crate::types::FillInstruction {
        intent_hash: BytesN::from_array(&env, &[0xAAu8; 32]),
        src_eid: 30316,
        recipient,
        dest_asset,
        min_dest_amount: 1_000_000_000,
        deadline: 9_999_999_999,
        // encode_fill_instruction writes [0u8; 32] for preferred_solver regardless
        // of this field — "open" (no reservation) is the canonical wire value.
        preferred_solver: None,
        reservation_window: 0,
    };
    let encoded = crate::messages::encode_fill_instruction(&env, &fi);

    let expected = decode_hex(GOLDEN);
    assert_eq!(
        expected.len() as u32,
        crate::types::FILL_INSTRUCTION_LENGTH,
        "golden FillInstruction vector has the wrong length"
    );
    assert_eq!(encoded.len() as usize, expected.len(), "length mismatch: encoder produced {} bytes, golden vector is {} bytes", encoded.len(), expected.len());
    for (i, b) in expected.iter().enumerate() {
        assert_eq!(encoded.get(i as u32).unwrap(), *b, "byte {} mismatch", i);
    }
}

/// Minimal `0x`-prefixed hex decoder (mirrors `test.rs::decode_vector`, kept
/// local here since `fuzz.rs` and `test.rs` are compiled as siblings, not a
/// shared module).
fn decode_hex(s: &str) -> std::vec::Vec<u8> {
    let s = s.trim();
    let s = s.strip_prefix("0x").unwrap_or(s);
    let bytes = s.as_bytes();
    assert_eq!(bytes.len() % 2, 0, "odd-length hex string");
    (0..bytes.len())
        .step_by(2)
        .map(|i| {
            let hi = (bytes[i] as char).to_digit(16).expect("non-hex nibble");
            let lo = (bytes[i + 1] as char).to_digit(16).expect("non-hex nibble");
            ((hi << 4) | lo) as u8
        })
        .collect()
}

#[test]
fn fill_instruction_recipient_round_trips_with_219_byte_format() {
    // Regression test for issue #271 and #270: verify that a payload built with
    // the corrected 219-byte wire format (56-byte strkey text for recipient,
    // 69-byte strkey text for dest_asset) correctly round-trips through the
    // Soroban decoder back to the original address.
    //
    // The OLD (broken) format stored only 32 bytes of the strkey's ASCII text,
    // silently dropping the last 24 characters of the 56-char strkey, and the
    // decoder then reinterpreted those 32 bytes as a raw contract id — two
    // mismatched conventions that ensured no Stellar address could survive the
    // round-trip. This test confirms the fixed behavior: the full strkey text
    // is stored in the wire field and decoded correctly by from_string_bytes.
    let env = Env::default();

    // Use the canonical all-zeros contract strkey as the recipient so this
    // test is deterministic and does not depend on random address generation.
    // ZERO_CONTRACT is a known valid C... strkey (56 chars).
    let zero_contract = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";
    let original = Address::from_str(&env, zero_contract);

    // Build a valid 219-byte payload using the corrected wire format:
    // recipient field is 56 bytes of ASCII strkey text (no truncation).
    let mut strkey_bytes = [0u8; 56];
    let ascii = zero_contract.as_bytes();
    assert_eq!(ascii.len(), 56, "strkey must be exactly 56 chars");
    strkey_bytes.copy_from_slice(ascii);

    // dest_asset: another valid C... strkey (zero-contract), padded to 69 bytes.
    let dest_zero_contract = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";
    let dest_ascii = dest_zero_contract.as_bytes();
    let mut dest_asset_bytes = [0u8; 69];
    dest_asset_bytes[..dest_ascii.len()].copy_from_slice(dest_ascii);

    let mut payload = Bytes::new(&env);
    payload.push_back(PROTOCOL_VERSION);
    payload.push_back(MSG_FILL_INSTRUCTION);
    payload.append(&Bytes::from_array(&env, &[0xAAu8; 32])); // intent_hash
    payload.append(&Bytes::from_array(&env, &30316u32.to_be_bytes())); // src_eid
    payload.append(&Bytes::from_array(&env, &strkey_bytes));    // recipient (56 bytes, full strkey text)
    payload.append(&Bytes::from_array(&env, &dest_asset_bytes)); // dest_asset (69 bytes)
    payload.append(&Bytes::from_array(&env, &1_000_000_000u128.to_be_bytes()));
    payload.append(&Bytes::from_array(&env, &9_999_999_999u64.to_be_bytes()));
    payload.append(&Bytes::from_array(&env, &[0u8; 32])); // preferred_solver: open

    assert_eq!(
        payload.len(),
        crate::types::FILL_INSTRUCTION_LENGTH,
        "payload must be the FillInstruction wire length"
    );

    let (msg_type, fi, _) =
        decode_message(&env, &payload).expect("decoder must accept a well-formed 219-byte payload");
    assert_eq!(msg_type, MSG_FILL_INSTRUCTION);

    // The decoded recipient must equal the original address — the full strkey
    // text round-trips correctly through the 56-byte wire field (issue #271 fixed).
    assert_eq!(
        fi.recipient, original,
        "recipient did not survive the round-trip — issue #271 regression"
    );
}

// -------------------------------------------------------------------------
// CancelIntent round-trip and mutation tests
// -------------------------------------------------------------------------

proptest! {
    #[test]
    fn prop_cancel_intent_round_trip(
        intent_hash in arb_hash(),
        reason in arb_cancel_reason(),
    ) {
        let env = Env::default();
        let intent_hash_bytes = BytesN::from_array(&env, &intent_hash);

        let encoded = encode_cancel_intent(&env, &intent_hash_bytes, reason);

        // Assert layout: version(1) | type(1) | hash(32) | reason(1)
        assert_eq!(encoded.len(), 35, "CancelIntent must be 35 bytes");
        assert_eq!(encoded.get(0).unwrap(), PROTOCOL_VERSION);
        assert_eq!(encoded.get(1).unwrap(), MSG_CANCEL_INTENT);

        // Decode hash (bytes 2..34)
        let decoded_hash: [u8; 32] = read_field(&encoded, 2);
        assert_eq!(decoded_hash, intent_hash, "intentHash mismatch");

        // Decode reason (byte 34)
        let decoded_reason = encoded.get(34).unwrap();
        assert_eq!(decoded_reason, reason, "reason mismatch");
    }

    /// Mutation: unknown reason codes (outside [0, 2]) must be rejected by BOTH sides.
    ///
    /// This test verifies symmetry: the Rust decoder rejects bad reason codes, and the
    /// same payload is exported to the corpus so the Solidity differential harness can
    /// assert the EVM decoder also rejects it. Both sides must behave identically.
    #[test]
    fn prop_cancel_intent_unknown_reason(
        intent_hash in arb_hash(),
        bad_reason in any::<u8>().prop_filter("must be invalid reason", |&r| r > 2),
    ) {
        let env = Env::default();
        let _intent_hash_bytes = BytesN::from_array(&env, &intent_hash);

        // Encode with bad reason
        let mut encoded = Bytes::new(&env);
        encoded.push_back(PROTOCOL_VERSION);
        encoded.push_back(MSG_CANCEL_INTENT);
        encoded.append(&Bytes::from_array(&env, &intent_hash));
        encoded.push_back(bad_reason);

        assert_eq!(encoded.len(), 35);
        export_to_corpus("cancel_intent_bad_reason", &encoded);

        // Verify the Rust decoder also rejects the bad reason code.
        // This closes the differential-fuzz gap: previously the test only exported
        // the corpus payload but never asserted the Rust side rejects it, meaning
        // a regression in the Rust decoder (e.g., accidentally accepting all reason
        // codes) would go undetected even while the Solidity side correctly rejected.
        let decode_result = crate::messages::decode_message(&env, &encoded);
        prop_assert!(
            decode_result.is_err(),
            "Rust decoder must reject unknown reason code 0x{:02x}, but it accepted the payload",
            bad_reason
        );
    }
}

// -------------------------------------------------------------------------
// Corpus export for cross-language validation
// -------------------------------------------------------------------------

/// Export a payload to the shared fuzz corpus directory for Solidity to consume.
fn export_to_corpus(name: &str, payload: &Bytes) {
    let corpus_dir =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../shared/wire-vectors/fuzz-corpus");
    fs::create_dir_all(&corpus_dir).expect("Failed to create corpus dir");

    let mut hex = String::with_capacity(payload.len() as usize * 2 + 2);
    hex.push_str("0x");
    for i in 0..payload.len() {
        hex.push_str(&format!("{:02x}", payload.get(i).unwrap()));
    }

    let file_path = corpus_dir.join(format!("{}.hex", name));
    fs::write(&file_path, hex).expect("Failed to write corpus file");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_export_to_corpus() {
        let env = Env::default();
        let hash = BytesN::from_array(&env, &[0x11u8; 32]);
        let solver = BytesN::from_array(&env, &[0xAAu8; 32]);
        let encoded = encode_fill_confirmed(&env, &hash, &solver, 1_000_000, 42);
        export_to_corpus("test_export", &encoded);
        // Verify file exists
        let corpus_dir =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../../shared/wire-vectors/fuzz-corpus");
        let file_path = corpus_dir.join("test_export.hex");
        assert!(file_path.exists(), "Corpus file should exist");
    }

    /// Regression: the 218-byte FillInstruction negative vector must be rejected
    /// by the Soroban decoder with MalformedPayload (length check: expects 219).
    #[test]
    fn fill_instruction_short_neg_vector_is_rejected() {
        const SHORT: &str =
            include_str!("../../../shared/wire-vectors/neg/fill_instruction_short.hex");
        let env = Env::default();
        let bytes = decode_hex(SHORT);
        assert_eq!(bytes.len(), 218, "fill_instruction_short.hex must be 218 bytes");
        let mut payload = Bytes::new(&env);
        for b in bytes {
            payload.push_back(b);
        }
        let result = crate::messages::decode_message(&env, &payload);
        assert!(
            result.is_err(),
            "decoder must reject a 218-byte FillInstruction (expects 219)"
        );
    }

    /// Regression: the 220-byte FillInstruction negative vector must be rejected
    /// by the Soroban decoder with MalformedPayload (length check: expects 219).
    #[test]
    fn fill_instruction_bad_version_neg_vector_is_rejected() {
        const BAD_VERSION: &str =
            include_str!("../../../shared/wire-vectors/neg/fill_instruction_bad_version.hex");
        let env = Env::default();
        let bytes = decode_hex(BAD_VERSION);
        assert_eq!(bytes.len(), 219);
        let mut payload = Bytes::new(&env);
        for b in bytes {
            payload.push_back(b);
        }
        assert!(
            crate::messages::decode_message(&env, &payload).is_err(),
            "decoder must reject a FillInstruction with an unknown version"
        );
    }

    #[test]
    fn fill_instruction_bad_type_neg_vector_is_rejected() {
        const BAD_TYPE: &str =
            include_str!("../../../shared/wire-vectors/neg/fill_instruction_bad_type.hex");
        let env = Env::default();
        let bytes = decode_hex(BAD_TYPE);
        assert_eq!(bytes.len(), 219);
        let mut payload = Bytes::new(&env);
        for b in bytes {
            payload.push_back(b);
        }
        assert!(
            crate::messages::decode_message(&env, &payload).is_err(),
            "decoder must reject an unknown FillInstruction message type"
        );
    }

    #[test]
    fn fill_instruction_long_neg_vector_is_rejected() {
        const LONG: &str =
            include_str!("../../../shared/wire-vectors/neg/fill_instruction_long.hex");
        let env = Env::default();
        let bytes = decode_hex(LONG);
        assert_eq!(bytes.len(), 220, "fill_instruction_long.hex must be 220 bytes");
        let mut payload = Bytes::new(&env);
        for b in bytes {
            payload.push_back(b);
        }
        let result = crate::messages::decode_message(&env, &payload);
        assert!(
            result.is_err(),
            "decoder must reject a 220-byte FillInstruction (expects 219)"
        );
    }
}
