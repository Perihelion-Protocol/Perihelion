// SPDX-License-Identifier: MIT

//! Cross-chain timing and wire-format constants shared across Solidity, Soroban, and the SDK.
//!
//! GENERATED FILE — DO NOT EDIT. Derived from `contracts/shared/protocol-constants.json`
//! by `scripts/gen-protocol-constants.mjs`. Regenerate with `make protocol-constants`.

/// Minimum time window (seconds) required after `deliver_intent` for `dispatch_confirmation`.
pub const MIN_DISPATCH_WINDOW: u64 = 1_800;

/// Cross-chain latency budget `L` (seconds) for LayerZero DVN verification and executor delivery.
pub const CROSS_CHAIN_LATENCY_BUDGET: u64 = 1_200;

/// Lower bound on EVM `confirmationGrace` (seconds).
pub const MIN_CONFIRMATION_GRACE: u64 = 3_000;

/// Upper bound on EVM `confirmationGrace` (seconds).
pub const MAX_CONFIRMATION_GRACE: u64 = 604_800;

/// Minimum fill headroom (seconds) before intent deadline required by off-chain tooling.
pub const MIN_FILL_HEADROOM_SECS: u64 = 1_920;

/// Maximum deadline horizon (seconds) from current ledger timestamp accepted for `FillInstruction`.
pub const MAX_DEADLINE_HORIZON: u64 = 604_800;

/// Extra safety margin (seconds) on top of `MIN_DISPATCH_WINDOW` for split `deliver_intent` path.
pub const SAFETY_MARGIN: u64 = 600;

/// Wire protocol version for all LayerZero payloads.
pub const PROTOCOL_VERSION: u8 = 0x01;

/// Message type discriminants (first byte after the version byte).
pub const MSG_FILL_INSTRUCTION: u8 = 0x01;
pub const MSG_FILL_CONFIRMED: u8 = 0x02;
pub const MSG_CANCEL_INTENT: u8 = 0x03;

/// Fixed wire length of a `FillInstruction` payload.
pub const FILL_INSTRUCTION_LENGTH: u32 = 227;

/// Fixed wire length of `FillConfirmed` (version + type + hash + solver + amount + ledger).
pub const FILL_CONFIRMED_LENGTH: u32 = 90;

/// Fixed wire length of `CancelIntent` (version + type + hash + reason).
pub const CANCEL_INTENT_LENGTH: u32 = 35;

/// Maximum byte length of a canonical `destination` Stellar strkey (`G...` or `C...`).
pub const MAX_DESTINATION_LEN: usize = 56;

/// Maximum byte length of a canonical `destAsset` identifier (`CODE:ISSUER`).
pub const MAX_DEST_ASSET_LEN: usize = 69;

/// Cancellation reason codes carried in a `CancelIntent` message.
pub const CANCEL_REASON_EXPIRED: u8 = 0x00;
pub const CANCEL_REASON_ADMIN: u8 = 0x01;
pub const CANCEL_REASON_INVALID: u8 = 0x02;

/// EVM-only local refund timeout reason code.
pub const CANCEL_REASON_LOCAL_TIMEOUT: u8 = 0xFF;
