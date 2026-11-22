// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title ProtocolConstants
/// @notice Cross-chain timing and wire-format constants shared across Solidity, Soroban, and the SDK.
/// @dev GENERATED FILE — DO NOT EDIT. Derived from contracts/shared/protocol-constants.json
///      by scripts/gen-protocol-constants.mjs. Regenerate with `make protocol-constants`.
library ProtocolConstants {
    // --- Timing & Grace Windows (seconds) ------------------------------------
    uint256 internal constant MIN_DISPATCH_WINDOW = 1800;
    uint256 internal constant CROSS_CHAIN_LATENCY_BUDGET = 1200;
    uint256 internal constant MIN_CONFIRMATION_GRACE = 3000;
    uint256 internal constant MAX_CONFIRMATION_GRACE = 604800;
    uint256 internal constant MIN_FILL_HEADROOM_SECS = 1920;
    uint256 internal constant MAX_DEADLINE_HORIZON = 604800;
    uint256 internal constant SAFETY_MARGIN = 600;

    // --- Wire Format Lengths & Field Bounds (bytes) --------------------------
    uint256 internal constant FILL_INSTRUCTION_LENGTH = 227;
    uint256 internal constant FILL_CONFIRMED_LENGTH = 90;
    uint256 internal constant CANCEL_INTENT_LENGTH = 35;
    uint256 internal constant MAX_DESTINATION_LEN = 56;
    uint256 internal constant MAX_DEST_ASSET_LEN = 69;

    // --- Wire Protocol Version & Message Type Discriminants ------------------
    bytes1 internal constant PROTOCOL_VERSION = 0x01;
    bytes1 internal constant MSG_FILL_INSTRUCTION = 0x01;
    bytes1 internal constant MSG_FILL_CONFIRMED = 0x02;
    bytes1 internal constant MSG_CANCEL_INTENT = 0x03;

    // --- Cancel Reason Codes -------------------------------------------------
    uint8 internal constant CANCEL_REASON_EXPIRED = 0x00;
    uint8 internal constant CANCEL_REASON_ADMIN = 0x01;
    uint8 internal constant CANCEL_REASON_INVALID = 0x02;
    uint8 internal constant CANCEL_REASON_LOCAL_TIMEOUT = 0xFF;
}
