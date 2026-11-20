// SPDX-License-Identifier: MIT

//! LayerZero payload encoding and decoding.
//!
//! Perihelion sends two message types from Stellar to the source chain:
//! `FillConfirmed` (authorize solver payout) and `CancelIntent` (refund the
//! user). It also receives `FillInstruction` and `CancelIntent` from the source
//! chain. All payloads use the fixed big-endian binary layout from the
//! architecture spec §3.3 so they decode identically in Solidity and Rust.
//!
//! ## Where the inbound decoders run
//!
//! The inbound half of the wire format is implemented by
//! `decode_message`/`decode_fill_instruction`/`decode_cancel_intent` and their
//! `read_field` helper. They are `pub` and are called by
//! `Perihelion::lz_receive_bytes` (`lib.rs`), the raw-`Bytes` entrypoint:
//! `lz_receive` remains the typed entrypoint for an endpoint that marshals a
//! `LzMessage` argument through the Soroban ABI, while `lz_receive_bytes`
//! accepts the unmodified LayerZero `message` bytes, decodes them here, and
//! hands the result to the same pause gate, nonce guard and handlers. Both
//! entrypoints authenticate the endpoint and the registered peer before any
//! bytes are parsed.
//!
//! Because a production entrypoint calls them, these decoders are no longer
//! dead code — they are compiled into the release `cdylib`, and the
//! differential fuzzer (`fuzz.rs`) exercises the very functions that parse
//! attacker-controlled inbound bytes. `endpoint.rs` is still a mock, so the
//! LayerZero adapter that will deliver those bytes does not exist yet; see
//! `docs/differential-fuzzing.md` for the verified scope.

use soroban_sdk::{Address, Bytes, BytesN, Env};

use crate::strkey;
use crate::types::{
    CancelInstruction, FillInstruction, CANCEL_INTENT_LENGTH, CANCEL_REASON_ADMIN,
    CANCEL_REASON_EXPIRED, CANCEL_REASON_INVALID, FILL_INSTRUCTION_LENGTH,
    MSG_CANCEL_INTENT, MSG_FILL_CONFIRMED, MSG_FILL_INSTRUCTION, PROTOCOL_VERSION,
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
/// Only the test and fuzz modules build `Address` values this way; the live
/// inbound path decodes the 56-byte strkey text field with
/// [`decode_strkey_address`] instead, so this helper stays `#[allow(dead_code)]`
/// for non-test builds.
#[allow(dead_code)]
pub(crate) fn address_from_contract_id(env: &Env, id: [u8; 32]) -> Address {
    let strkey = crate::strkey::contract_strkey(&id);
    let strkey_str = core::str::from_utf8(&strkey).expect("strkey encoder only emits ASCII");
    Address::from_str(env, strkey_str)
}

/// Encode a `FillConfirmed` payload (FILL_CONFIRMED_LENGTH bytes):
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

/// Encode a `CancelIntent` payload (CANCEL_INTENT_LENGTH bytes):
/// `version(1) | type(1) | intent_hash(32) | reason(1)`.
pub fn encode_cancel_intent(env: &Env, intent_hash: &BytesN<32>, reason: u8) -> Bytes {
    let mut b = Bytes::new(env);
    b.push_back(PROTOCOL_VERSION);
    b.push_back(MSG_CANCEL_INTENT);
    b.append(&Bytes::from_array(env, &intent_hash.to_array()));
    b.push_back(reason);
    b
}

/// Default executor `lzReceive` gas limit requested for EVM delivery.
///
/// Both outbound message types (`FillConfirmed` and `CancelIntent`) are handled
/// on the EVM escrow by `_onFillConfirmed` / `_onCancelIntent`, each of which
/// performs an ERC-20 `transfer` (plus event emission and bookkeeping). A
/// measured budget for those handlers is on the order of ~80k gas; this default
/// requests 200,000 gas, leaving a >2x safety margin for cold storage slots,
/// non-standard token implementations and future handler changes. Operators can
/// override it per destination eid via the admin `set_enforced_options` path.
pub const DEFAULT_LZ_RECEIVE_GAS: u64 = 200_000;

/// LayerZero V2 options container type: Type 3 (the only type accepted by
/// endpoint v2; Type 1/2 are legacy).
const OPTIONS_TYPE_3: u8 = 0x0003;
/// Executor worker id in the options blob.
const WORKER_ID_EXECUTOR: u8 = 0x01;
/// Option type `lzReceive` (option type 1) for the executor worker.
const OPTION_TYPE_LZ_RECEIVE: u8 = 0x01;

/// Encode a LayerZero V2 Type-3 options blob requesting `gas` for the executor's
/// `lzReceive` on the destination chain.
///
/// Layout (big-endian, matching `@layerzerolabs/lz-v2-utilities`):
///
/// ```text
/// 0003            options type (uint16, Type 3)
/// 01              worker id (uint8, executor)
/// 0011            option size (uint16, 17 bytes)
/// 01              option type (uint8, lzReceive)
/// 0000000000030d40  gas (uint128, 200_000 in the example)
/// ```
///
/// The same bytes must be used for both `quote_lz_fee` and `dispatch` so the
/// quoted fee matches what is actually sent (issue #1065).
pub fn encode_executor_lz_receive_options(env: &Env, gas: u64) -> Bytes {
    let mut b = Bytes::new(env);
    // Options container type: Type 3.
    b.append(&Bytes::from_array(env, &(OPTIONS_TYPE_3 as u16).to_be_bytes()));
    // Worker id: executor.
    b.push_back(WORKER_ID_EXECUTOR);
    // Option size: 1 byte option type + 16 bytes gas = 17 bytes.
    b.append(&Bytes::from_array(env, &17u16.to_be_bytes()));
    // Option type: lzReceive.
    b.push_back(OPTION_TYPE_LZ_RECEIVE);
    // Gas limit as a big-endian uint128.
    b.append(&Bytes::from_array(env, &(gas as u128).to_be_bytes()));
    b
}

/// Read a fixed-size big-endian field out of `message` at `offset`.
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

/// A `FillInstruction` as it arrives on the wire, before its `dest_asset`
/// identifier is resolved to a token contract.
///
/// `dest_asset` holds the user-signed canonical identifier (`native`,
/// `CODE:ISSUER` or a `C...` strkey, see [`crate::asset`]) with the wire
/// padding stripped. It is already validated structurally; resolving it needs
/// contract storage (the native token and the contract-token allowlist), so
/// `Perihelion::lz_receive_bytes` does that and then calls
/// [`WireFillInstruction::into_fill_instruction`].
#[derive(Clone)]
pub struct WireFillInstruction {
    pub intent_hash: BytesN<32>,
    pub recipient: Address,
    pub dest_asset: Bytes,
    pub min_dest_amount: i128,
    pub deadline: u64,
    pub preferred_solver: Option<Address>,
    pub locked_solver: Option<BytesN<32>>,
    pub reservation_window: u64,
}

impl WireFillInstruction {
    /// Attach the resolved destination token contract.
    pub fn into_fill_instruction(self, dest_asset: Address) -> FillInstruction {
        FillInstruction {
            intent_hash: self.intent_hash,
            recipient: self.recipient,
            dest_asset,
            min_dest_amount: self.min_dest_amount,
            deadline: self.deadline,
            preferred_solver: self.preferred_solver,
            locked_solver: self.locked_solver,
            reservation_window: self.reservation_window,
        }
    }
}

/// Decode an inbound message payload. Returns the message type discriminant and
/// parsed message, or an error if the payload is malformed.
/// Validates version and routes to the appropriate decoder.
///
/// Called by `Perihelion::lz_receive_bytes` on every raw inbound message, and by
/// the differential-fuzz harness, so the fuzzed codec and the live codec are the
/// same code (issue #722).
pub fn decode_message(
    env: &Env,
    message: &Bytes,
) -> Result<(u8, WireFillInstruction, Option<CancelInstruction>), crate::PerihelionError> {
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
            // Return a dummy FillInstruction carrying the cancel's intent_hash so the
            // decoder keeps one return shape. The zero-account strkey and empty
            // asset are placeholders: callers that handle CancelIntent read the
            // third element and ignore this one.
            let zero_addr = Address::from_str(
                env,
                "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
            );
            let dummy = WireFillInstruction {
                intent_hash: ci.intent_hash.clone(),
                recipient: zero_addr,
                dest_asset: Bytes::new(env),
                min_dest_amount: 0,
                deadline: 0,
                preferred_solver: None,
                locked_solver: None,
                reservation_window: 0,
            };
            Ok((msg_type, dummy, Some(ci)))
        }
        _ => Err(PerihelionError::UnknownMessageType),
    }
}

/// Decode the canonical `FillInstruction` payload (227 bytes):
/// `version(1) | type(1) | intent_hash(32) | reserved(4) | recipient(56) | dest_asset(69) | min_dest_amount(16) | deadline(8) | locked_solver(32) | reservation_window(8)`.
///
/// `reserved` (offset 34) is ignored on receipt: the eid of the locking chain is
/// the authenticated LayerZero origin, so the body never supplies one (#1051).
///
/// # Address decoding
///
/// The `recipient` field carries a Stellar strkey and is decoded into a Soroban
/// `Address`. The `dest_asset` field carries the user-signed asset identifier
/// (`native`, `CODE:ISSUER` or a `C...` contract strkey, see [`crate::asset`])
/// as ASCII, right-zero-padded to 69 bytes. It is validated here and preserved
/// verbatim; it is never decoded as a Soroban `Address`, because two of its
/// three forms are not strkeys. `lz_receive_bytes` resolves it to the token
/// contract.
///
/// # solver identity and preferred solver
///
/// The EVM side encodes the canonical locking solver as a 20-byte EVM address
/// left-padded to 32 bytes. This is not a Stellar strkey and cannot be decoded
/// as a Soroban `Address`, so it is preserved as `locked_solver` and must be
/// echoed by the solver in `fill_intent`. The separate user `preferredSolver`
/// reservation remains unset by this adapter until its cross-chain representation
/// is specified. The trailing `reservation_window` field is explicit on the wire
/// and is decoded as a big-endian `u64`.
///
fn decode_fill_instruction(
    env: &Env,
    message: &Bytes,
) -> Result<WireFillInstruction, crate::PerihelionError> {
    use crate::PerihelionError;

    // Release delivery accepts only the canonical fixed-width payload. The
    // historical 219-byte layout is intentionally not a production decode path.
    if message.len() != FILL_INSTRUCTION_LENGTH {
        return Err(PerihelionError::MalformedPayload);
    }

    // Extract intent_hash (offset 2, 32 bytes)
    let intent_hash_bytes: [u8; 32] = read_field(message, 2)?;
    let intent_hash = BytesN::from_array(env, &intent_hash_bytes);

    // Offset 34 is `reserved` (4 bytes). It is deliberately not read: routing uses
    // the transport origin eid, so a body-supplied value has no effect (#1051).

    // Extract recipient (offset 38, 56 bytes): ASCII strkey characters right-zero-padded.
    // Strip trailing zeros and decode as a Stellar strkey (G... or C...).
    let mut recipient_raw = [0u8; 56];
    for (i, byte) in recipient_raw.iter_mut().enumerate() {
        *byte = message
            .get(38 + i as u32)
            .ok_or(PerihelionError::MalformedPayload)?;
    }
    let recipient = decode_strkey_address(env, &recipient_raw)?;

    // Extract dest_asset (offset 94, 69 bytes): the ASCII asset identifier,
    // right-zero-padded. The field is 69 bytes wide (not 32) so CODE:ISSUER
    // assets survive the wire without truncation — see #270. Strip the padding,
    // check it is one of the canonical forms and keep the identifier bytes.
    let dest_asset_raw: [u8; crate::asset::MAX_DEST_ASSET_LEN] = read_field(message, 94)?;
    let dest_asset_id = &dest_asset_raw[..trimmed_len(&dest_asset_raw)];
    if crate::asset::parse(dest_asset_id).is_none() {
        return Err(PerihelionError::MalformedPayload);
    }
    let dest_asset = Bytes::from_slice(env, dest_asset_id);

    // Extract min_dest_amount (offset 163, 16 bytes, big-endian)
    let mut min_dest_amount_bytes = [0u8; 16];
    for (i, byte) in min_dest_amount_bytes.iter_mut().enumerate() {
        *byte = message
            .get(163 + i as u32)
            .ok_or(PerihelionError::MalformedPayload)?;
    }
    let min_dest_amount = i128::from_be_bytes(min_dest_amount_bytes);
    if min_dest_amount < 0 {
        return Err(PerihelionError::MalformedPayload);
    }

    // Extract deadline (offset 179, 8 bytes, big-endian)
    let mut deadline_bytes = [0u8; 8];
    for (i, byte) in deadline_bytes.iter_mut().enumerate() {
        *byte = message
            .get(179 + i as u32)
            .ok_or(PerihelionError::MalformedPayload)?;
    }
    let deadline = u64::from_be_bytes(deadline_bytes);

    // Offset 187 is the canonical 32-byte EVM identity of the solver that
    // locked the source escrow. Preserve it verbatim; it is not a Stellar
    // Address and must never be converted through strkey parsing.
    let solver_word = read_field::<32>(message, 187)?;
    let locked_solver = if solver_word == [0u8; 32] {
        None
    } else {
        Some(BytesN::from_array(env, &solver_word))
    };

    Ok(WireFillInstruction {
        intent_hash,
        recipient,
        dest_asset,
        min_dest_amount,
        deadline,
        preferred_solver: None,
        locked_solver,
        // Canonical 227-byte layout: read the explicit 8-byte field at offset 219.
        reservation_window: u64::from_be_bytes(read_field::<8>(message, 219)?),
    })
}

/// Convert a right-zero-padded ASCII strkey byte slice into a Soroban `Address`.
///
/// The wire format encodes Stellar strkeys (G.../C...) as ASCII characters
/// right-padded with zeros to fill the fixed field width. This function finds
/// the last non-zero byte, takes the prefix as the strkey string, and converts
/// it using `Address::from_string_bytes` which handles both account keys (G...)
/// and contract keys (C...) without reinterpreting raw bytes as a contract id.
///
/// `Address::from_string_bytes` traps the host on invalid input rather than
/// returning an error, so the strkey is fully validated first (length, prefix,
/// alphabet, version byte and CRC16). Any failure is `MalformedPayload` (issue #902).
fn decode_strkey_address(env: &Env, padded: &[u8]) -> Result<Address, crate::PerihelionError> {
    use crate::PerihelionError;
    let strkey_bytes = &padded[..trimmed_len(padded)];
    if !strkey::is_valid_strkey(strkey_bytes) {
        return Err(PerihelionError::MalformedPayload);
    }
    let mut b = Bytes::new(env);
    for &byte in strkey_bytes {
        b.push_back(byte);
    }
    // from_string_bytes accepts both G... (account) and C... (contract) strkeys.
    Ok(Address::from_string_bytes(&b))
}

/// Length of a right-zero-padded ASCII wire field with the padding removed.
fn trimmed_len(padded: &[u8]) -> usize {
    padded
        .iter()
        .rposition(|&b| b != 0)
        .map(|p| p + 1)
        .unwrap_or(0)
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
    assert!(len <= N, "strkey does not fit the {N}-byte wire field");
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
/// Mirrors the 227-byte layout: the recipient occupies 56 bytes and
/// `dest_asset` 69 bytes (see #270), both right-zero-padded strkey ASCII.
/// `preferred_solver` is written as the all-zero "open" word, since the EVM
/// side carries an EVM address there that the decoder deliberately drops
/// (see #271).
#[cfg(test)]
pub(crate) fn encode_fill_instruction(env: &Env, fi: &FillInstruction) -> Bytes {
    encode_fill_instruction_with_dest_asset(env, fi, &strkey_field::<69>(&fi.dest_asset))
}

/// [`encode_fill_instruction`], but writing `dest_asset_id` (any canonical
/// identifier: `native`, `CODE:ISSUER` or a `C...` strkey) into the
/// `dest_asset` field in place of `fi.dest_asset`'s strkey.
#[cfg(test)]
pub(crate) fn encode_fill_instruction_with_dest_asset(
    env: &Env,
    fi: &FillInstruction,
    dest_asset_id: &[u8],
) -> Bytes {
    assert!(
        dest_asset_id.len() <= 69,
        "dest_asset does not fit the 69-byte wire field"
    );
    let mut dest_asset_field = [0u8; 69];
    dest_asset_field[..dest_asset_id.len()].copy_from_slice(dest_asset_id);
    let mut b = Bytes::new(env);
    b.push_back(PROTOCOL_VERSION);
    b.push_back(MSG_FILL_INSTRUCTION);
    b.append(&Bytes::from_array(env, &fi.intent_hash.to_array()));
    // reserved (offset 34): always zero on the wire, see the decoder note above.
    b.append(&Bytes::from_array(env, &[0u8; 4]));
    b.append(&Bytes::from_array(env, &strkey_field::<56>(&fi.recipient)));
    b.append(&Bytes::from_array(env, &dest_asset_field));
    b.append(&Bytes::from_array(
        env,
        &(fi.min_dest_amount as u128).to_be_bytes(),
    ));
    b.append(&Bytes::from_array(env, &fi.deadline.to_be_bytes()));
    if let Some(ref locked_solver) = fi.locked_solver {
        b.append(&Bytes::from_array(env, &locked_solver.to_array()));
    } else {
        b.append(&Bytes::from_array(env, &[0u8; 32]));
    }
    b.append(&Bytes::from_array(
        env,
        &fi.reservation_window.to_be_bytes(),
    ));
    b
}

/// Decode a `CancelIntent` payload (CANCEL_INTENT_LENGTH bytes):
/// `version(1) | type(1) | intent_hash(32) | reason(1)`.
fn decode_cancel_intent(
    env: &Env,
    message: &Bytes,
) -> Result<CancelInstruction, crate::PerihelionError> {
    use crate::PerihelionError;

    // Validate length: 2 (header) + 33 (payload) = 35
    if message.len() != CANCEL_INTENT_LENGTH {
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

    use super::*;
    use crate::fuzz::decode_hex;
    use crate::PerihelionError;

    // A known valid G... account strkey (all-zeros account).
    const ZERO_ACCOUNT: &str = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
    // A known valid C... contract strkey.
    const ZERO_CONTRACT: &str = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";

    /// decode_strkey_address correctly decodes a G... strkey from a zero-padded buffer.
    #[test]
    fn test_decode_strkey_address_g_key() {
        let env = Env::default();
        let mut buf = [0u8; 56];
        buf.copy_from_slice(ZERO_ACCOUNT.as_bytes());

        let addr = decode_strkey_address(&env, &buf).expect("should decode G... strkey");
        // Round-trip: the decoded Address should re-encode to the same strkey.
        // `Address::to_string` already returns a `soroban_sdk::String`, and that
        // type has no `Index`/`Deref`-to-`str`, so the comparison stays in the
        // SDK's own string domain instead of converting out of it.
        let roundtrip = addr.to_string();
        assert_eq!(roundtrip, soroban_sdk::String::from_str(&env, ZERO_ACCOUNT));
    }

    /// decode_strkey_address correctly decodes a C... strkey from a zero-padded buffer.
    #[test]
    fn test_decode_strkey_address_c_key() {
        let env = Env::default();
        let mut buf = [0u8; 56];
        buf.copy_from_slice(ZERO_CONTRACT.as_bytes());

        // Should not panic — from_string_bytes handles C... keys.
        let addr = decode_strkey_address(&env, &buf).expect("should decode C... strkey");
        let _ = addr; // decoded without error
    }

    /// decode_strkey_address returns MalformedPayload for an all-zero buffer.
    #[test]
    fn test_decode_strkey_address_empty_returns_error() {
        let env = Env::default();
        let buf = [0u8; 56];
        let result = decode_strkey_address(&env, &buf);
        assert_eq!(result.err(), Some(PerihelionError::MalformedPayload));
    }

    /// Negative vectors for issue #902: each malformed strkey must come back as
    /// `MalformedPayload` from the decoder, never as a host trap.
    #[test]
    fn test_decode_strkey_address_malformed_vectors_return_error() {
        let env = Env::default();
        let valid = ZERO_ACCOUNT.as_bytes();

        // Bad checksum: last character changed, prefix and alphabet still valid.
        let mut bad_checksum = [0u8; 56];
        bad_checksum.copy_from_slice(valid);
        bad_checksum[55] = b'A';
        assert_eq!(
            decode_strkey_address(&env, &bad_checksum).err(),
            Some(PerihelionError::MalformedPayload)
        );

        // Wrong version byte: the prefix is swapped to G over a contract payload,
        // so the version byte and the checksum no longer agree.
        let mut wrong_version = [0u8; 56];
        wrong_version.copy_from_slice(ZERO_CONTRACT.as_bytes());
        wrong_version[0] = b'G';
        assert_eq!(
            decode_strkey_address(&env, &wrong_version).err(),
            Some(PerihelionError::MalformedPayload)
        );

        // Interior NUL: a zero byte inside the strkey, followed by more characters.
        let mut interior_nul = [0u8; 56];
        interior_nul.copy_from_slice(valid);
        interior_nul[20] = 0;
        assert_eq!(
            decode_strkey_address(&env, &interior_nul).err(),
            Some(PerihelionError::MalformedPayload)
        );

        // Short strkey: 55 characters, one short of the canonical length.
        let mut short = [0u8; 56];
        short[..55].copy_from_slice(&valid[..55]);
        assert_eq!(
            decode_strkey_address(&env, &short).err(),
            Some(PerihelionError::MalformedPayload)
        );
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

    /// The shared off-by-one negative vectors (one byte short / one byte long)
    /// must both be rejected by the decoder.
    #[test]
    fn test_decode_fill_instruction_rejects_neg_length_vectors() {
        const SHORT: &str =
            include_str!("../../../shared/wire-vectors/neg/fill_instruction_short.hex");
        const LONG: &str =
            include_str!("../../../shared/wire-vectors/neg/fill_instruction_long.hex");

        let env = Env::default();

        let short_bytes = decode_hex(SHORT);
        assert_eq!(
            short_bytes.len() as u32,
            FILL_INSTRUCTION_LENGTH - 1,
            "fill_instruction_short.hex must be one byte short"
        );
        let mut short_msg = Bytes::new(&env);
        for b in short_bytes {
            short_msg.push_back(b);
        }
        assert!(
            decode_fill_instruction(&env, &short_msg).is_err(),
            "decoder must reject a payload one byte short"
        );

        let long_bytes = decode_hex(LONG);
        assert_eq!(
            long_bytes.len() as u32,
            FILL_INSTRUCTION_LENGTH + 1,
            "fill_instruction_long.hex must be one byte long"
        );
        let mut long_msg = Bytes::new(&env);
        for b in long_bytes {
            long_msg.push_back(b);
        }
        assert!(
            decode_fill_instruction(&env, &long_msg).is_err(),
            "decoder must reject a payload one byte long"
        );
    }

    /// Issue #903: the 219-byte legacy layout (no trailing `reservation_window`)
    /// shares protocol version 0x01 with the canonical 227-byte layout, so it must
    /// be rejected rather than decoded with the window defaulted to 0. Checked
    /// through `decode_message`, the codec `lz_receive_bytes` dispatches on.
    #[test]
    fn test_decode_message_rejects_219_byte_legacy_fill_instruction() {
        const LEGACY: &str =
            include_str!("../../../shared/wire-vectors/neg/fill_instruction_legacy_219.hex");

        let env = Env::default();
        let mut legacy_msg = Bytes::new(&env);
        for b in decode_hex(LEGACY) {
            legacy_msg.push_back(b);
        }
        assert_eq!(legacy_msg.len(), FILL_INSTRUCTION_LENGTH - 8);
        assert_eq!(
            decode_message(&env, &legacy_msg).err(),
            Some(PerihelionError::MalformedPayload)
        );
    }

    /// A well-formed FillInstruction derived from the shared golden wire vector
    /// (`contracts/shared/wire-vectors/fill_instruction.hex`) decodes correctly.
    ///
    /// Using the shared vector (rather than hand-assembling bytes) ensures this
    /// test and the EVM conformance test cannot drift from each other — if either
    /// encoder or decoder diverges from the documented layout, a test goes red.
    #[test]
    fn test_decode_fill_instruction_strkey_addresses() {
        // Loaded via include_str! so it is baked into the test binary at
        // compile time and cannot differ between runs.
        const GOLDEN: &str = include_str!("../../../shared/wire-vectors/fill_instruction.hex");

        let env = Env::default();

        let bytes = decode_hex(GOLDEN);
        assert_eq!(
            bytes.len() as u32,
            FILL_INSTRUCTION_LENGTH,
            "golden fill_instruction.hex must be FILL_INSTRUCTION_LENGTH bytes"
        );

        let mut msg = Bytes::new(&env);
        for b in &bytes {
            msg.push_back(*b);
        }

        let fi = decode_fill_instruction(&env, &msg).expect("golden vector must decode");

        // Values match the canonical table in wire-vectors/README.md.
        assert_eq!(fi.min_dest_amount, 1_000_000_000);
        assert_eq!(fi.deadline, 9_999_999_999);
        assert!(fi.preferred_solver.is_none());
        assert_eq!(fi.reservation_window, 0);
        // recipient and dest_asset decoded without panic — correct strkey path used
    }

    #[test]
    fn test_decode_fill_instruction_rejects_negative_min_dest_amount() {
        let env = Env::default();
        let mut msg = Bytes::new(&env);
        msg.push_back(0x01);
        msg.push_back(0x01);
        for _ in 0..32u32 {
            msg.push_back(0xaa);
        }
        for byte in [0u8, 0, 0, 1] {
            msg.push_back(byte);
        }
        for byte in ZERO_ACCOUNT.as_bytes() {
            msg.push_back(*byte);
        }
        for byte in ZERO_CONTRACT.as_bytes() {
            msg.push_back(*byte);
        }
        for _ in 0..13u32 {
            msg.push_back(0);
        }
        msg.push_back(0x80);
        for _ in 1..16u32 {
            msg.push_back(0);
        }
        for _ in 0..8u32 {
            msg.push_back(0);
        }
        for _ in 0..32u32 {
            msg.push_back(0);
        }
        for _ in 0..8u32 {
            msg.push_back(0);
        }
        assert_eq!(msg.len(), FILL_INSTRUCTION_LENGTH);
        assert!(decode_fill_instruction(&env, &msg).is_err());
    }

    fn vector_bytes(env: &Env, hex: &str) -> Bytes {
        let mut msg = Bytes::new(env);
        for b in decode_hex(hex) {
            msg.push_back(b);
        }
        msg
    }

    /// Each of the three canonical `destAsset` forms decodes from its golden
    /// vector, and the identifier is preserved byte-for-byte (padding stripped).
    #[test]
    fn test_decode_fill_instruction_keeps_each_dest_asset_form() {
        let env = Env::default();
        let cases: [(&str, &[u8]); 3] = [
            (
                include_str!("../../../shared/wire-vectors/fill_instruction.hex"),
                b"CDGMZTGMZTGMZTGMZTGMZTGMZTGMZTGMZTGMZTGMZTGMZTGMZTGMZLND",
            ),
            (
                include_str!("../../../shared/wire-vectors/fill_instruction_native_asset.hex"),
                b"native",
            ),
            (
                include_str!("../../../shared/wire-vectors/fill_instruction_classic_asset.hex"),
                b"USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
            ),
        ];
        for (hex, id) in cases {
            let fi = decode_fill_instruction(&env, &vector_bytes(&env, hex))
                .expect("golden vector must decode");
            assert_eq!(fi.dest_asset, Bytes::from_slice(&env, id));
            assert_eq!(fi.min_dest_amount, 1_000_000_000);
        }
    }

    /// The Type-3 executor `lzReceive` options blob has the exact documented
    /// layout for the default gas budget (issue #1065).
    #[test]
    fn test_encode_executor_lz_receive_options_default_gas() {
        let env = Env::default();
        let opts = encode_executor_lz_receive_options(&env, DEFAULT_LZ_RECEIVE_GAS);

        let mut expected = [0u8; 21];
        expected[0..2].copy_from_slice(&[0x00, 0x03]); // Type 3
        expected[2] = 0x01; // executor worker id
        expected[3..5].copy_from_slice(&[0x00, 0x11]); // option size = 17
        expected[5] = 0x01; // lzReceive option type
        expected[6..22 - 1].copy_from_slice(&(DEFAULT_LZ_RECEIVE_GAS as u128).to_be_bytes());

        assert_eq!(opts.len(), 21);
        for (i, byte) in expected.iter().enumerate() {
            assert_eq!(opts.get(i as u32), Some(*byte), "byte {} mismatch", i);
        }
        // 200_000 == 0x00030d40, encoded as a 16-byte big-endian uint128.
        assert_eq!(
            opts,
            Bytes::from_array(
                &env,
                &[
                    0x00, 0x03, 0x01, 0x00, 0x11, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
                    0x00, 0x00, 0x00, 0x00, 0x00, 0x03, 0x0d, 0x40,
                ]
            )
        );
    }

    /// A `G...` account strkey is a valid strkey but not an asset identifier.
    #[test]
    fn test_decode_fill_instruction_rejects_account_dest_asset() {
        const ACCOUNT: &str = include_str!(
            "../../../shared/wire-vectors/neg/fill_instruction_account_dest_asset.hex"
        );
        let env = Env::default();
        assert_eq!(
            decode_message(&env, &vector_bytes(&env, ACCOUNT)).err(),
            Some(PerihelionError::MalformedPayload)
        );
    }
}
