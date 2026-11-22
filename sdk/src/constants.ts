// SPDX-License-Identifier: MIT

/**
 * Cross-chain timing and wire-format constants shared across Solidity, Soroban, and the SDK.
 *
 * GENERATED FILE — DO NOT EDIT. Derived from contracts/shared/protocol-constants.json
 * by scripts/gen-protocol-constants.mjs. Regenerate with `make protocol-constants`.
 */

export const MIN_DISPATCH_WINDOW = 1_800 as const;
export const CROSS_CHAIN_LATENCY_BUDGET = 1_200 as const;
export const MIN_CONFIRMATION_GRACE = 3_000 as const;
export const MAX_CONFIRMATION_GRACE = 604_800 as const;
export const MIN_FILL_HEADROOM_SECS = 1_920 as const;
export const MAX_DEADLINE_HORIZON = 604_800 as const;
export const MAX_DEADLINE_HORIZON_SEC = MAX_DEADLINE_HORIZON;
export const SAFETY_MARGIN = 600 as const;

export const PROTOCOL_VERSION = 0x01 as const;
export const MSG_FILL_INSTRUCTION = 0x01 as const;
export const MSG_FILL_CONFIRMED = 0x02 as const;
export const MSG_CANCEL_INTENT = 0x03 as const;

export const FILL_INSTRUCTION_LENGTH = 227 as const;
export const FILL_CONFIRMED_LENGTH = 90 as const;
export const CANCEL_INTENT_LENGTH = 35 as const;
export const MAX_DESTINATION_LEN = 56 as const;
export const MAX_DEST_ASSET_LEN = 69 as const;

export const CANCEL_REASON_EXPIRED = 0x00 as const;
export const CANCEL_REASON_ADMIN = 0x01 as const;
export const CANCEL_REASON_INVALID = 0x02 as const;
export const CANCEL_REASON_LOCAL_TIMEOUT = 0xff as const;
