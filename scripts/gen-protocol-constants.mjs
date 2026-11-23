#!/usr/bin/env node
// SPDX-License-Identifier: MIT

/**
 * Generates cross-chain protocol constants for Solidity, Soroban (Rust), and
 * the TypeScript SDK from the single source of truth:
 *
 *   contracts/shared/protocol-constants.json
 *
 * Outputs:
 *   - contracts/evm/src/ProtocolConstants.sol
 *   - contracts/soroban/settlement/src/constants.rs
 *   - sdk/src/constants.ts
 *
 * Also enforces cross-chain timing and wire-format inequalities so invalid
 * constant combinations fail at codegen / CI check time.
 *
 * Usage:
 *   node scripts/gen-protocol-constants.mjs          # write generated files
 *   node scripts/gen-protocol-constants.mjs --check  # verify no drift & valid wiring
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(__dirname, "..");

export const SOURCE_PATH = resolve(REPO_ROOT, "contracts/shared/protocol-constants.json");
export const SOLIDITY_OUT_PATH = resolve(REPO_ROOT, "contracts/evm/src/ProtocolConstants.sol");
export const RUST_OUT_PATH = resolve(REPO_ROOT, "contracts/soroban/settlement/src/constants.rs");
export const TS_OUT_PATH = resolve(REPO_ROOT, "sdk/src/constants.ts");

const TIMING_KEYS = [
  "MIN_DISPATCH_WINDOW",
  "CROSS_CHAIN_LATENCY_BUDGET",
  "MIN_CONFIRMATION_GRACE",
  "MAX_CONFIRMATION_GRACE",
  "MIN_FILL_HEADROOM_SECS",
  "MAX_DEADLINE_HORIZON",
  "SAFETY_MARGIN",
];

const WIRE_KEYS = [
  "PROTOCOL_VERSION",
  "MSG_FILL_INSTRUCTION",
  "MSG_FILL_CONFIRMED",
  "MSG_CANCEL_INTENT",
  "FILL_INSTRUCTION_LENGTH",
  "FILL_CONFIRMED_LENGTH",
  "CANCEL_INTENT_LENGTH",
  "MAX_DESTINATION_LEN",
  "MAX_DEST_ASSET_LEN",
  "CANCEL_REASON_EXPIRED",
  "CANCEL_REASON_ADMIN",
  "CANCEL_REASON_INVALID",
  "CANCEL_REASON_LOCAL_TIMEOUT",
];

/**
 * Format an integer with underscore thousands separators (e.g. 604800 -> "604_800")
 * for Rust and TypeScript numeric literals. Numbers < 1000 are left without underscores.
 */
function formatUnderscoredInt(n) {
  const s = String(n);
  if (n < 1000) return s;
  return s.replace(/\B(?=(\d{3})+(?!\d))/g, "_");
}

/**
 * Format a byte (0..255) as a 2-digit hex literal (`0x01`, `0xFF`, or `0xff`).
 */
function formatHexByte(n, { uppercase = true } = {}) {
  const hex = n.toString(16).padStart(2, "0");
  return `0x${uppercase ? hex.toUpperCase() : hex.toLowerCase()}`;
}

/**
 * Load and parse `contracts/shared/protocol-constants.json`.
 */
export function loadProtocolConstants(jsonPath = SOURCE_PATH) {
  if (!existsSync(jsonPath)) {
    throw new Error(`Missing protocol constants source file: ${jsonPath}`);
  }
  const raw = readFileSync(jsonPath, "utf8");
  const data = JSON.parse(raw);
  validateProtocolConstants(data);
  return data;
}

/**
 * Validate schema completeness and all cross-chain protocol inequalities.
 * Throws an Error with a descriptive message if any invariant is violated.
 */
export function validateProtocolConstants(data) {
  if (!data || typeof data !== "object") {
    throw new Error("protocol-constants.json root must be an object");
  }
  if (!data.timing || typeof data.timing !== "object") {
    throw new Error("protocol-constants.json must contain a 'timing' object");
  }
  if (!data.wire || typeof data.wire !== "object") {
    throw new Error("protocol-constants.json must contain a 'wire' object");
  }

  for (const key of TIMING_KEYS) {
    const val = data.timing[key];
    if (!Number.isSafeInteger(val)) {
      throw new Error(`timing.${key} must be a safe integer (got ${String(val)})`);
    }
  }

  for (const key of WIRE_KEYS) {
    const val = data.wire[key];
    if (!Number.isSafeInteger(val)) {
      throw new Error(`wire.${key} must be a safe integer (got ${String(val)})`);
    }
  }

  const {
    MIN_DISPATCH_WINDOW,
    CROSS_CHAIN_LATENCY_BUDGET,
    MIN_CONFIRMATION_GRACE,
    MAX_CONFIRMATION_GRACE,
    MIN_FILL_HEADROOM_SECS,
    MAX_DEADLINE_HORIZON,
    SAFETY_MARGIN,
  } = data.timing;

  const {
    PROTOCOL_VERSION,
    MSG_FILL_INSTRUCTION,
    MSG_FILL_CONFIRMED,
    MSG_CANCEL_INTENT,
    FILL_INSTRUCTION_LENGTH,
    FILL_CONFIRMED_LENGTH,
    CANCEL_INTENT_LENGTH,
    MAX_DESTINATION_LEN,
    MAX_DEST_ASSET_LEN,
    CANCEL_REASON_EXPIRED,
    CANCEL_REASON_ADMIN,
    CANCEL_REASON_INVALID,
    CANCEL_REASON_LOCAL_TIMEOUT,
  } = data.wire;

  // 1. Positive timing parameters
  if (MIN_DISPATCH_WINDOW <= 0) {
    throw new Error(
      `Invalid timing invariant: MIN_DISPATCH_WINDOW (${MIN_DISPATCH_WINDOW}) must be > 0`,
    );
  }
  if (CROSS_CHAIN_LATENCY_BUDGET <= 0) {
    throw new Error(
      `Invalid timing invariant: CROSS_CHAIN_LATENCY_BUDGET (${CROSS_CHAIN_LATENCY_BUDGET}) must be > 0`,
    );
  }
  if (SAFETY_MARGIN <= 0) {
    throw new Error(`Invalid timing invariant: SAFETY_MARGIN (${SAFETY_MARGIN}) must be > 0`);
  }

  // 2. Cross-chain dispatch cutoff & grace window inequalities
  if (CROSS_CHAIN_LATENCY_BUDGET >= MIN_DISPATCH_WINDOW) {
    throw new Error(
      `Invalid timing invariant: CROSS_CHAIN_LATENCY_BUDGET (${CROSS_CHAIN_LATENCY_BUDGET}) must be < MIN_DISPATCH_WINDOW (${MIN_DISPATCH_WINDOW})`,
    );
  }
  if (MIN_CONFIRMATION_GRACE < MIN_DISPATCH_WINDOW + CROSS_CHAIN_LATENCY_BUDGET) {
    throw new Error(
      `Invalid timing invariant: MIN_CONFIRMATION_GRACE (${MIN_CONFIRMATION_GRACE}) must be >= MIN_DISPATCH_WINDOW (${MIN_DISPATCH_WINDOW}) + CROSS_CHAIN_LATENCY_BUDGET (${CROSS_CHAIN_LATENCY_BUDGET})`,
    );
  }
  if (MAX_CONFIRMATION_GRACE < MIN_CONFIRMATION_GRACE) {
    throw new Error(
      `Invalid timing invariant: MAX_CONFIRMATION_GRACE (${MAX_CONFIRMATION_GRACE}) must be >= MIN_CONFIRMATION_GRACE (${MIN_CONFIRMATION_GRACE})`,
    );
  }

  // 3. Solver headroom & horizon inequalities
  if (MIN_FILL_HEADROOM_SECS <= MIN_DISPATCH_WINDOW) {
    throw new Error(
      `Invalid timing invariant: MIN_FILL_HEADROOM_SECS (${MIN_FILL_HEADROOM_SECS}) must be > MIN_DISPATCH_WINDOW (${MIN_DISPATCH_WINDOW})`,
    );
  }
  if (MAX_DEADLINE_HORIZON <= MIN_FILL_HEADROOM_SECS) {
    throw new Error(
      `Invalid timing invariant: MAX_DEADLINE_HORIZON (${MAX_DEADLINE_HORIZON}) must be > MIN_FILL_HEADROOM_SECS (${MIN_FILL_HEADROOM_SECS})`,
    );
  }
  if (MAX_DEADLINE_HORIZON !== MAX_CONFIRMATION_GRACE) {
    throw new Error(
      `Invalid timing invariant: MAX_DEADLINE_HORIZON (${MAX_DEADLINE_HORIZON}) must equal MAX_CONFIRMATION_GRACE (${MAX_CONFIRMATION_GRACE})`,
    );
  }

  // 4. Destination & asset length bounds
  if (MAX_DESTINATION_LEN !== 56) {
    throw new Error(
      `Invalid wire invariant: MAX_DESTINATION_LEN (${MAX_DESTINATION_LEN}) must equal 56 (canonical Stellar strkey length)`,
    );
  }
  if (MAX_DEST_ASSET_LEN < MAX_DESTINATION_LEN) {
    throw new Error(
      `Invalid wire invariant: MAX_DEST_ASSET_LEN (${MAX_DEST_ASSET_LEN}) must be >= MAX_DESTINATION_LEN (${MAX_DESTINATION_LEN})`,
    );
  }

  // 5. Exact wire message length layout invariants
  const expectedFillInstructionLen =
    1 + 1 + 32 + 4 + MAX_DESTINATION_LEN + MAX_DEST_ASSET_LEN + 16 + 8 + 32 + 8;
  if (FILL_INSTRUCTION_LENGTH !== expectedFillInstructionLen) {
    throw new Error(
      `Invalid wire invariant: FILL_INSTRUCTION_LENGTH (${FILL_INSTRUCTION_LENGTH}) must equal 1+1+32+4+MAX_DESTINATION_LEN+MAX_DEST_ASSET_LEN+16+8+32+8 (${expectedFillInstructionLen})`,
    );
  }
  const expectedFillConfirmedLen = 1 + 1 + 32 + 32 + 16 + 8;
  if (FILL_CONFIRMED_LENGTH !== expectedFillConfirmedLen) {
    throw new Error(
      `Invalid wire invariant: FILL_CONFIRMED_LENGTH (${FILL_CONFIRMED_LENGTH}) must equal 1+1+32+32+16+8 (${expectedFillConfirmedLen})`,
    );
  }
  const expectedCancelIntentLen = 1 + 1 + 32 + 1;
  if (CANCEL_INTENT_LENGTH !== expectedCancelIntentLen) {
    throw new Error(
      `Invalid wire invariant: CANCEL_INTENT_LENGTH (${CANCEL_INTENT_LENGTH}) must equal 1+1+32+1 (${expectedCancelIntentLen})`,
    );
  }

  // 6. Message type & cancel reason byte validity
  if (PROTOCOL_VERSION < 1 || PROTOCOL_VERSION > 255) {
    throw new Error(
      `Invalid wire invariant: PROTOCOL_VERSION (${PROTOCOL_VERSION}) must be in [1, 255]`,
    );
  }
  const msgTypes = [
    ["MSG_FILL_INSTRUCTION", MSG_FILL_INSTRUCTION],
    ["MSG_FILL_CONFIRMED", MSG_FILL_CONFIRMED],
    ["MSG_CANCEL_INTENT", MSG_CANCEL_INTENT],
  ];
  for (const [name, val] of msgTypes) {
    if (val < 1 || val > 255) {
      throw new Error(`Invalid wire invariant: ${name} (${val}) must be in [1, 255]`);
    }
  }
  if (new Set(msgTypes.map(([, val]) => val)).size !== msgTypes.length) {
    throw new Error(
      "Invalid wire invariant: MSG_FILL_INSTRUCTION, MSG_FILL_CONFIRMED, and MSG_CANCEL_INTENT must be pairwise distinct",
    );
  }

  const cancelReasons = [
    ["CANCEL_REASON_EXPIRED", CANCEL_REASON_EXPIRED],
    ["CANCEL_REASON_ADMIN", CANCEL_REASON_ADMIN],
    ["CANCEL_REASON_INVALID", CANCEL_REASON_INVALID],
    ["CANCEL_REASON_LOCAL_TIMEOUT", CANCEL_REASON_LOCAL_TIMEOUT],
  ];
  for (const [name, val] of cancelReasons) {
    if (val < 0 || val > 255) {
      throw new Error(`Invalid wire invariant: ${name} (${val}) must be in [0, 255]`);
    }
  }
  if (new Set(cancelReasons.map(([, val]) => val)).size !== cancelReasons.length) {
    throw new Error("Invalid wire invariant: CANCEL_REASON_* codes must be pairwise distinct");
  }
}

/**
 * Render `contracts/evm/src/ProtocolConstants.sol`.
 */
export function renderSolidity(data) {
  validateProtocolConstants(data);
  const { timing, wire } = data;
  return `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title ProtocolConstants
/// @notice Cross-chain timing and wire-format constants shared across Solidity, Soroban, and the SDK.
/// @dev GENERATED FILE — DO NOT EDIT. Derived from contracts/shared/protocol-constants.json
///      by scripts/gen-protocol-constants.mjs. Regenerate with \`make protocol-constants\`.
library ProtocolConstants {
    // --- Timing & Grace Windows (seconds) ------------------------------------
    uint256 internal constant MIN_DISPATCH_WINDOW = ${timing.MIN_DISPATCH_WINDOW};
    uint256 internal constant CROSS_CHAIN_LATENCY_BUDGET = ${timing.CROSS_CHAIN_LATENCY_BUDGET};
    uint256 internal constant MIN_CONFIRMATION_GRACE = ${timing.MIN_CONFIRMATION_GRACE};
    uint256 internal constant MAX_CONFIRMATION_GRACE = ${timing.MAX_CONFIRMATION_GRACE};
    uint256 internal constant MIN_FILL_HEADROOM_SECS = ${timing.MIN_FILL_HEADROOM_SECS};
    uint256 internal constant MAX_DEADLINE_HORIZON = ${timing.MAX_DEADLINE_HORIZON};
    uint256 internal constant SAFETY_MARGIN = ${timing.SAFETY_MARGIN};

    // --- Wire Format Lengths & Field Bounds (bytes) --------------------------
    uint256 internal constant FILL_INSTRUCTION_LENGTH = ${wire.FILL_INSTRUCTION_LENGTH};
    uint256 internal constant FILL_CONFIRMED_LENGTH = ${wire.FILL_CONFIRMED_LENGTH};
    uint256 internal constant CANCEL_INTENT_LENGTH = ${wire.CANCEL_INTENT_LENGTH};
    uint256 internal constant MAX_DESTINATION_LEN = ${wire.MAX_DESTINATION_LEN};
    uint256 internal constant MAX_DEST_ASSET_LEN = ${wire.MAX_DEST_ASSET_LEN};

    // --- Wire Protocol Version & Message Type Discriminants ------------------
    bytes1 internal constant PROTOCOL_VERSION = ${formatHexByte(wire.PROTOCOL_VERSION, { uppercase: true })};
    bytes1 internal constant MSG_FILL_INSTRUCTION = ${formatHexByte(wire.MSG_FILL_INSTRUCTION, { uppercase: true })};
    bytes1 internal constant MSG_FILL_CONFIRMED = ${formatHexByte(wire.MSG_FILL_CONFIRMED, { uppercase: true })};
    bytes1 internal constant MSG_CANCEL_INTENT = ${formatHexByte(wire.MSG_CANCEL_INTENT, { uppercase: true })};

    // --- Cancel Reason Codes -------------------------------------------------
    uint8 internal constant CANCEL_REASON_EXPIRED = ${formatHexByte(wire.CANCEL_REASON_EXPIRED, { uppercase: true })};
    uint8 internal constant CANCEL_REASON_ADMIN = ${formatHexByte(wire.CANCEL_REASON_ADMIN, { uppercase: true })};
    uint8 internal constant CANCEL_REASON_INVALID = ${formatHexByte(wire.CANCEL_REASON_INVALID, { uppercase: true })};
    uint8 internal constant CANCEL_REASON_LOCAL_TIMEOUT = ${formatHexByte(wire.CANCEL_REASON_LOCAL_TIMEOUT, { uppercase: true })};
}
`;
}

/**
 * Render `contracts/soroban/settlement/src/constants.rs`.
 */
export function renderRust(data) {
  validateProtocolConstants(data);
  const { timing, wire } = data;
  return `// SPDX-License-Identifier: MIT

//! Cross-chain timing and wire-format constants shared across Solidity, Soroban, and the SDK.
//!
//! GENERATED FILE — DO NOT EDIT. Derived from \`contracts/shared/protocol-constants.json\`
//! by \`scripts/gen-protocol-constants.mjs\`. Regenerate with \`make protocol-constants\`.

/// Minimum time window (seconds) required after \`deliver_intent\` for \`dispatch_confirmation\`.
pub const MIN_DISPATCH_WINDOW: u64 = ${formatUnderscoredInt(timing.MIN_DISPATCH_WINDOW)};

/// Cross-chain latency budget \`L\` (seconds) for LayerZero DVN verification and executor delivery.
pub const CROSS_CHAIN_LATENCY_BUDGET: u64 = ${formatUnderscoredInt(timing.CROSS_CHAIN_LATENCY_BUDGET)};

/// Lower bound on EVM \`confirmationGrace\` (seconds).
pub const MIN_CONFIRMATION_GRACE: u64 = ${formatUnderscoredInt(timing.MIN_CONFIRMATION_GRACE)};

/// Upper bound on EVM \`confirmationGrace\` (seconds).
pub const MAX_CONFIRMATION_GRACE: u64 = ${formatUnderscoredInt(timing.MAX_CONFIRMATION_GRACE)};

/// Minimum fill headroom (seconds) before intent deadline required by off-chain tooling.
pub const MIN_FILL_HEADROOM_SECS: u64 = ${formatUnderscoredInt(timing.MIN_FILL_HEADROOM_SECS)};

/// Maximum deadline horizon (seconds) from current ledger timestamp accepted for \`FillInstruction\`.
pub const MAX_DEADLINE_HORIZON: u64 = ${formatUnderscoredInt(timing.MAX_DEADLINE_HORIZON)};

/// Extra safety margin (seconds) on top of \`MIN_DISPATCH_WINDOW\` for split \`deliver_intent\` path.
pub const SAFETY_MARGIN: u64 = ${formatUnderscoredInt(timing.SAFETY_MARGIN)};

/// Wire protocol version for all LayerZero payloads.
pub const PROTOCOL_VERSION: u8 = ${formatHexByte(wire.PROTOCOL_VERSION, { uppercase: true })};

/// Message type discriminants (first byte after the version byte).
pub const MSG_FILL_INSTRUCTION: u8 = ${formatHexByte(wire.MSG_FILL_INSTRUCTION, { uppercase: true })};
pub const MSG_FILL_CONFIRMED: u8 = ${formatHexByte(wire.MSG_FILL_CONFIRMED, { uppercase: true })};
pub const MSG_CANCEL_INTENT: u8 = ${formatHexByte(wire.MSG_CANCEL_INTENT, { uppercase: true })};

/// Fixed wire length of a \`FillInstruction\` payload.
pub const FILL_INSTRUCTION_LENGTH: u32 = ${wire.FILL_INSTRUCTION_LENGTH};

/// Fixed wire length of \`FillConfirmed\` (version + type + hash + solver + amount + ledger).
pub const FILL_CONFIRMED_LENGTH: u32 = ${wire.FILL_CONFIRMED_LENGTH};

/// Fixed wire length of \`CancelIntent\` (version + type + hash + reason).
pub const CANCEL_INTENT_LENGTH: u32 = ${wire.CANCEL_INTENT_LENGTH};

/// Maximum byte length of a canonical \`destination\` Stellar strkey (\`G...\` or \`C...\`).
pub const MAX_DESTINATION_LEN: usize = ${wire.MAX_DESTINATION_LEN};

/// Maximum byte length of a canonical \`destAsset\` identifier (\`CODE:ISSUER\`).
pub const MAX_DEST_ASSET_LEN: usize = ${wire.MAX_DEST_ASSET_LEN};

/// Cancellation reason codes carried in a \`CancelIntent\` message.
pub const CANCEL_REASON_EXPIRED: u8 = ${formatHexByte(wire.CANCEL_REASON_EXPIRED, { uppercase: true })};
pub const CANCEL_REASON_ADMIN: u8 = ${formatHexByte(wire.CANCEL_REASON_ADMIN, { uppercase: true })};
pub const CANCEL_REASON_INVALID: u8 = ${formatHexByte(wire.CANCEL_REASON_INVALID, { uppercase: true })};

/// EVM-only local refund timeout reason code.
pub const CANCEL_REASON_LOCAL_TIMEOUT: u8 = ${formatHexByte(wire.CANCEL_REASON_LOCAL_TIMEOUT, { uppercase: true })};
`;
}

/**
 * Render `sdk/src/constants.ts`.
 */
export function renderTypeScript(data) {
  validateProtocolConstants(data);
  const { timing, wire } = data;
  return `// SPDX-License-Identifier: MIT

/**
 * Cross-chain timing and wire-format constants shared across Solidity, Soroban, and the SDK.
 *
 * GENERATED FILE — DO NOT EDIT. Derived from contracts/shared/protocol-constants.json
 * by scripts/gen-protocol-constants.mjs. Regenerate with \`make protocol-constants\`.
 */

export const MIN_DISPATCH_WINDOW = ${formatUnderscoredInt(timing.MIN_DISPATCH_WINDOW)} as const;
export const CROSS_CHAIN_LATENCY_BUDGET = ${formatUnderscoredInt(timing.CROSS_CHAIN_LATENCY_BUDGET)} as const;
export const MIN_CONFIRMATION_GRACE = ${formatUnderscoredInt(timing.MIN_CONFIRMATION_GRACE)} as const;
export const MAX_CONFIRMATION_GRACE = ${formatUnderscoredInt(timing.MAX_CONFIRMATION_GRACE)} as const;
export const MIN_FILL_HEADROOM_SECS = ${formatUnderscoredInt(timing.MIN_FILL_HEADROOM_SECS)} as const;
export const MAX_DEADLINE_HORIZON = ${formatUnderscoredInt(timing.MAX_DEADLINE_HORIZON)} as const;
export const MAX_DEADLINE_HORIZON_SEC = MAX_DEADLINE_HORIZON;
export const SAFETY_MARGIN = ${formatUnderscoredInt(timing.SAFETY_MARGIN)} as const;

export const PROTOCOL_VERSION = ${formatHexByte(wire.PROTOCOL_VERSION, { uppercase: false })} as const;
export const MSG_FILL_INSTRUCTION = ${formatHexByte(wire.MSG_FILL_INSTRUCTION, { uppercase: false })} as const;
export const MSG_FILL_CONFIRMED = ${formatHexByte(wire.MSG_FILL_CONFIRMED, { uppercase: false })} as const;
export const MSG_CANCEL_INTENT = ${formatHexByte(wire.MSG_CANCEL_INTENT, { uppercase: false })} as const;

export const FILL_INSTRUCTION_LENGTH = ${wire.FILL_INSTRUCTION_LENGTH} as const;
export const FILL_CONFIRMED_LENGTH = ${wire.FILL_CONFIRMED_LENGTH} as const;
export const CANCEL_INTENT_LENGTH = ${wire.CANCEL_INTENT_LENGTH} as const;
export const MAX_DESTINATION_LEN = ${wire.MAX_DESTINATION_LEN} as const;
export const MAX_DEST_ASSET_LEN = ${wire.MAX_DEST_ASSET_LEN} as const;

export const CANCEL_REASON_EXPIRED = ${formatHexByte(wire.CANCEL_REASON_EXPIRED, { uppercase: false })} as const;
export const CANCEL_REASON_ADMIN = ${formatHexByte(wire.CANCEL_REASON_ADMIN, { uppercase: false })} as const;
export const CANCEL_REASON_INVALID = ${formatHexByte(wire.CANCEL_REASON_INVALID, { uppercase: false })} as const;
export const CANCEL_REASON_LOCAL_TIMEOUT = ${formatHexByte(wire.CANCEL_REASON_LOCAL_TIMEOUT, { uppercase: false })} as const;
`;
}

/**
 * Verify that all consumer files across Solidity, Soroban, the SDK, the solver,
 * and the relayer reference the generated constants instead of hand-copied literals.
 */
export function checkConsumerWiring(repoRoot = REPO_ROOT) {
  const errors = [];

  // 1. contracts/evm/src/PerihelionEscrow.sol
  const escrowPath = resolve(repoRoot, "contracts/evm/src/PerihelionEscrow.sol");
  const escrowSrc = readFileSync(escrowPath, "utf8");
  if (!escrowSrc.includes('import { ProtocolConstants } from "./ProtocolConstants.sol";')) {
    errors.push(
      'contracts/evm/src/PerihelionEscrow.sol must import ProtocolConstants from "./ProtocolConstants.sol"',
    );
  }
  const escrowConstants = [
    "FILL_INSTRUCTION_LENGTH",
    "FILL_CONFIRMED_LENGTH",
    "CANCEL_INTENT_LENGTH",
    "CANCEL_REASON_EXPIRED",
    "CANCEL_REASON_ADMIN",
    "CANCEL_REASON_INVALID",
    "CANCEL_REASON_LOCAL_TIMEOUT",
    "PROTOCOL_VERSION",
    "MSG_FILL_INSTRUCTION",
    "MSG_FILL_CONFIRMED",
    "MSG_CANCEL_INTENT",
    "MAX_CONFIRMATION_GRACE",
    "CROSS_CHAIN_LATENCY_BUDGET",
    "MIN_CONFIRMATION_GRACE",
    "MAX_DESTINATION_LEN",
    "MAX_DEST_ASSET_LEN",
  ];
  for (const name of escrowConstants) {
    const pattern = new RegExp(`\\bconstant\\s+${name}\\s*=\\s*ProtocolConstants\\.${name}\\s*;`);
    if (!pattern.test(escrowSrc)) {
      errors.push(
        `contracts/evm/src/PerihelionEscrow.sol must define ${name} = ProtocolConstants.${name};`,
      );
    }
  }

  // 2. contracts/soroban/settlement/src/lib.rs
  const libRsPath = resolve(repoRoot, "contracts/soroban/settlement/src/lib.rs");
  const libRsSrc = readFileSync(libRsPath, "utf8");
  if (!libRsSrc.includes("pub mod constants;") || !libRsSrc.includes("pub use constants::*;")) {
    errors.push(
      "contracts/soroban/settlement/src/lib.rs must declare `pub mod constants;` and `pub use constants::*;`",
    );
  }
  for (const name of [
    "MAX_DEADLINE_HORIZON",
    "MIN_DISPATCH_WINDOW",
    "CROSS_CHAIN_LATENCY_BUDGET",
    "SAFETY_MARGIN",
  ]) {
    const dupPattern = new RegExp(`\\bpub\\s+const\\s+${name}\\s*:`);
    if (dupPattern.test(libRsSrc)) {
      errors.push(
        `contracts/soroban/settlement/src/lib.rs must not redefine \`pub const ${name}\`; use crate::constants`,
      );
    }
  }

  // 3. contracts/soroban/settlement/src/types.rs
  const typesRsPath = resolve(repoRoot, "contracts/soroban/settlement/src/types.rs");
  const typesRsSrc = readFileSync(typesRsPath, "utf8");
  if (!typesRsSrc.includes("crate::constants")) {
    errors.push(
      "contracts/soroban/settlement/src/types.rs must re-export wire constants from `crate::constants`",
    );
  }
  for (const name of [
    "PROTOCOL_VERSION",
    "MSG_FILL_INSTRUCTION",
    "MSG_FILL_CONFIRMED",
    "MSG_CANCEL_INTENT",
    "FILL_INSTRUCTION_LENGTH",
    "FILL_CONFIRMED_LENGTH",
    "CANCEL_INTENT_LENGTH",
    "CANCEL_REASON_EXPIRED",
    "CANCEL_REASON_ADMIN",
    "CANCEL_REASON_INVALID",
  ]) {
    const dupPattern = new RegExp(`\\bpub\\s+const\\s+${name}\\s*:`);
    if (dupPattern.test(typesRsSrc)) {
      errors.push(
        `contracts/soroban/settlement/src/types.rs must not redefine \`pub const ${name}\`; re-export from crate::constants`,
      );
    }
  }

  // 4. contracts/soroban/settlement/src/asset.rs
  const assetRsPath = resolve(repoRoot, "contracts/soroban/settlement/src/asset.rs");
  const assetRsSrc = readFileSync(assetRsPath, "utf8");
  if (!assetRsSrc.includes("pub use crate::constants::MAX_DEST_ASSET_LEN;")) {
    errors.push(
      "contracts/soroban/settlement/src/asset.rs must re-export `pub use crate::constants::MAX_DEST_ASSET_LEN;`",
    );
  }
  if (/\bpub\s+const\s+MAX_DEST_ASSET_LEN\s*:/.test(assetRsSrc)) {
    errors.push(
      "contracts/soroban/settlement/src/asset.rs must not redefine `pub const MAX_DEST_ASSET_LEN`",
    );
  }

  // 5. contracts/soroban/settlement/src/messages.rs
  const messagesRsPath = resolve(repoRoot, "contracts/soroban/settlement/src/messages.rs");
  const messagesRsSrc = readFileSync(messagesRsPath, "utf8");
  if (
    !messagesRsSrc.includes("MAX_DESTINATION_LEN") ||
    !messagesRsSrc.includes("MAX_DEST_ASSET_LEN")
  ) {
    errors.push(
      "contracts/soroban/settlement/src/messages.rs must use MAX_DESTINATION_LEN and MAX_DEST_ASSET_LEN from crate::constants",
    );
  }

  // 6. sdk/src/index.ts & sdk/src/intent.ts
  const sdkIndexPath = resolve(repoRoot, "sdk/src/index.ts");
  const sdkIndexSrc = readFileSync(sdkIndexPath, "utf8");
  if (!sdkIndexSrc.includes('export * from "./constants.js";')) {
    errors.push('sdk/src/index.ts must contain `export * from "./constants.js";`');
  }

  const sdkIntentPath = resolve(repoRoot, "sdk/src/intent.ts");
  const sdkIntentSrc = readFileSync(sdkIntentPath, "utf8");
  if (!sdkIntentSrc.includes('"./constants.js"')) {
    errors.push('sdk/src/intent.ts must import constants from "./constants.js"');
  }
  for (const name of [
    "MAX_DESTINATION_LEN",
    "MAX_DEST_ASSET_LEN",
    "MAX_DEADLINE_HORIZON",
    "MAX_DEADLINE_HORIZON_SEC",
    "MIN_FILL_HEADROOM_SECS",
  ]) {
    const dupPattern = new RegExp(`\\bexport\\s+const\\s+${name}\\s*=`);
    if (dupPattern.test(sdkIntentSrc)) {
      errors.push(
        `sdk/src/intent.ts must not redefine \`export const ${name} =\`; import from ./constants.js`,
      );
    }
  }

  // 7. solver/src/executor.ts
  const executorPath = resolve(repoRoot, "solver/src/executor.ts");
  const executorSrc = readFileSync(executorPath, "utf8");
  if (/\bexport\s+const\s+MIN_FILL_HEADROOM_SECS\s*=/.test(executorSrc)) {
    errors.push(
      "solver/src/executor.ts must not redefine `export const MIN_FILL_HEADROOM_SECS =`; import from @perihelion/sdk",
    );
  }
  if (!executorSrc.includes("MIN_FILL_HEADROOM_SECS")) {
    errors.push(
      "solver/src/executor.ts must import and re-export MIN_FILL_HEADROOM_SECS from @perihelion/sdk",
    );
  }

  // 8. relayer/src/types.ts
  const relayerTypesPath = resolve(repoRoot, "relayer/src/types.ts");
  const relayerTypesSrc = readFileSync(relayerTypesPath, "utf8");
  if (!relayerTypesSrc.includes('from "@perihelion/sdk"')) {
    errors.push("relayer/src/types.ts must import wire constants from @perihelion/sdk");
  }
  for (const name of [
    "FILL_INSTRUCTION_LENGTH",
    "FILL_CONFIRMED_LENGTH",
    "CANCEL_INTENT_LENGTH",
    "CANCEL_REASON_EXPIRED",
    "CANCEL_REASON_ADMIN",
    "CANCEL_REASON_INVALID",
  ]) {
    const dupPattern = new RegExp(`\\bexport\\s+const\\s+${name}\\s*=`);
    if (dupPattern.test(relayerTypesSrc)) {
      errors.push(
        `relayer/src/types.ts must not redefine \`export const ${name} =\`; import from @perihelion/sdk`,
      );
    }
  }

  if (errors.length > 0) {
    throw new Error(`Consumer wiring check failed:\n  - ${errors.join("\n  - ")}`);
  }
}

/**
 * Generate or check all three language constant artifacts.
 */
export function generateOrCheckProtocolConstants({ check = false, repoRoot = REPO_ROOT } = {}) {
  const sourcePath = resolve(repoRoot, "contracts/shared/protocol-constants.json");
  const data = loadProtocolConstants(sourcePath);

  const targets = [
    {
      relPath: "contracts/evm/src/ProtocolConstants.sol",
      absPath: resolve(repoRoot, "contracts/evm/src/ProtocolConstants.sol"),
      content: renderSolidity(data),
    },
    {
      relPath: "contracts/soroban/settlement/src/constants.rs",
      absPath: resolve(repoRoot, "contracts/soroban/settlement/src/constants.rs"),
      content: renderRust(data),
    },
    {
      relPath: "sdk/src/constants.ts",
      absPath: resolve(repoRoot, "sdk/src/constants.ts"),
      content: renderTypeScript(data),
    },
  ];

  if (check) {
    const drifted = [];
    for (const target of targets) {
      if (!existsSync(target.absPath)) {
        drifted.push(`${target.relPath} (missing)`);
        continue;
      }
      const current = readFileSync(target.absPath, "utf8").replace(/\r\n/g, "\n");
      if (current !== target.content) {
        drifted.push(target.relPath);
      }
    }
    if (drifted.length > 0) {
      throw new Error(
        `Generated protocol constants are out of date (${drifted.join(", ")}). Run \`node scripts/gen-protocol-constants.mjs\` (or \`make protocol-constants\`) and commit the result.`,
      );
    }
    checkConsumerWiring(repoRoot);
    return { targets, checked: true };
  }

  for (const target of targets) {
    mkdirSync(dirname(target.absPath), { recursive: true });
    writeFileSync(target.absPath, target.content, "utf8");
  }
  return { targets, checked: false };
}

// Run as CLI when invoked directly
const isMain =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isMain) {
  const check = process.argv.includes("--check");
  try {
    const { targets } = generateOrCheckProtocolConstants({ check });
    if (check) {
      console.log("All generated protocol constants and consumer bindings are up to date.");
    } else {
      for (const target of targets) {
        console.log(`Wrote ${target.relPath}`);
      }
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
