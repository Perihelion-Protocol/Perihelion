// SPDX-License-Identifier: MIT

use soroban_sdk::{contracttype, Address, Bytes, BytesN};

/// Wire protocol version for all LayerZero payloads.
pub const PROTOCOL_VERSION: u8 = 0x01;

/// Message type discriminants (first byte after the version byte).
pub const MSG_FILL_INSTRUCTION: u8 = 0x01;
pub const MSG_FILL_CONFIRMED: u8 = 0x02;
pub const MSG_CANCEL_INTENT: u8 = 0x03;

/// Cancellation reason codes carried in a CancelIntent message.
pub const CANCEL_REASON_EXPIRED: u8 = 0x00;
pub const CANCEL_REASON_ADMIN: u8 = 0x01;
pub const CANCEL_REASON_INVALID: u8 = 0x02;

/// Persistent/instance storage keys. See the architecture spec §1.1–1.2 for the
/// tier rationale of each.
#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    // Instance tier (config).
    Admin,
    /// Pending admin nominee for the two-step admin handover (issue #17).
    /// Present only while a handover is in progress; cleared on accept or cancel.
    PendingAdmin,
    Endpoint,
    Paused,
    /// Trusted remote OApp (the EVM escrow) per source endpoint id.
    Peer(u32),
    /// Pending peer change proposed by admin, awaiting approval after delay.
    /// Stores (eid, proposed_peer, proposed_at_timestamp). Issue #165.
    PendingPeer(u32),
    /// Timestamp when the current pending peer change was proposed.
    /// Used to enforce the minimum peer-change delay. Issue #165.
    PendingPeerTime(u32),
    /// Per-corridor pause flag. When set for an eid, all inbound and outbound
    /// operations for that corridor are blocked independently of the global flag.
    /// Allows quarantining a single compromised chain without halting others.
    PausedEid(u32),
    /// Native token (SAC) address for the settlement network (Testnet, Futurenet, or Pubnet).
    /// Required to pay keeper rewards. Issue #173.
    NativeToken,
    /// Keeper reward in stroops (Stellar's smallest unit) paid to callers of
    /// `cancel_expired_intent`. Incentivizes timely refund processing (issue #173).
    KeeperReward,
    /// Configurable maximum TTL for TTL extensions (issue #340).
    /// If unset, defaults to MAX_TTL_DEFAULT. Settable by admin.
    MaxTtl,

    // Instance tier (value caps, issue #145).
    /// Maximum amount a single intent can register (0 = unlimited).
    MaxIntentAmount,
    /// Rolling window duration in seconds (0 = disabled).
    RollingWindowDuration,
    /// Maximum aggregate settled amount within rolling window (0 = unlimited).
    RollingWindowCap,
    /// Whether rolling-window cap has been triggered.
    RollingWindowTriggered,
    /// Earliest timestamp to allow resetting the rolling-window cap.
    RollingWindowResetEarliestAt,

    // Persistent tier (rolling-window tracking, issue #145).
    /// Rolling-window bucket: window start timestamp => cumulative settled amount.
    RollingWindowBucket(u64),
    /// Latest memoized window start timestamp (for efficiency).
    LatestWindowStart,

    // Persistent tier (per-intent lifecycle).
    Intent(BytesN<32>),
    /// Terminal idempotency marker: set iff the intent was settled.
    Settled(BytesN<32>),
    /// Terminal idempotency marker: set iff the intent was cancelled.
    Cancelled(BytesN<32>),
    /// Idempotency marker: set once FillConfirmed has been dispatched for this intent.
    ConfirmationSent(BytesN<32>),

    // Persistent tier (transport bookkeeping).
    /// Aggregate reputation metrics for a solver, keyed by solver address.
    SolverReputation(Address),
    /// Unbounded per-(eid, word_index) nonce bitmap for unordered delivery
    /// (issue #285). Mirrors the EVM `_inboundNonceBitmap[srcEid][wordIndex]`
    /// layout exactly.
    ///
    /// A nonce `n` is tracked at:
    ///   word_index = n / 64
    ///   bit_index  = n % 64
    ///
    /// Each storage word covers 64 consecutive nonces. Words are written
    /// lazily on first use and are never discarded, so nonces from any
    /// message-in-flight window are always accepted exactly once regardless
    /// of delivery order.
    ///
    /// This is the per-eid **LayerZero transport nonce** state — distinct from
    /// `Intent.nonce` (a 256-bit random collision-prevention field in the
    /// EIP-712 payload). See `docs/TECHNICAL-ARCHITECTURE.md §11`.
    ///
    /// REPLAY-SAFETY: archival of an `InboundNonceWord` entry re-opens the 64
    /// nonces it covered. TTL is extended to MAX_TTL on every write; see
    /// `accept_nonce` in lib.rs.
    InboundNonceWord(u32, u64),
    /// Consumed nonce bitmap for a source endpoint id (unordered delivery).
    /// **Deprecated** — superseded by `InboundNonceWord(eid, word_index)` (issue #285).
    /// Kept to avoid breaking any archived storage entries; never written by
    /// `accept_nonce` after this change.
    InboundNonceBitmap(u32),
    /// Base nonce for the bitmap window (implicit 0 before first message).
    /// **Deprecated** — superseded by `InboundNonceWord(eid, word_index)` (issue #285).
    /// Kept to avoid breaking any archived storage entries; never written by
    /// `accept_nonce` after this change.
    InboundNonceBase(u32),
}

/// Lifecycle state of a registered intent.
#[contracttype]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum IntentStatus {
    /// Registered from a FillInstruction; awaiting a solver.
    Locked = 0,
    /// A solver filled on Stellar; FillConfirmed not yet dispatched.
    Filled = 1,
    /// FillConfirmed dispatched to the source chain.
    ConfirmationSent = 2,
    /// Deadline passed without fill; CancelIntent dispatched.
    Cancelled = 3,
}

/// Full lifecycle record for an intent, keyed by its EIP-712 hash.
#[contracttype]
#[derive(Clone)]
pub struct IntentRecord {
    pub intent_hash: BytesN<32>,
    pub src_eid: u32,
    pub recipient: Address,
    pub dest_asset: Address,
    pub min_dest_amount: i128,
    pub deadline: u64,
    pub preferred_solver: Option<Address>,
    /// Unix timestamp at which the preferred-solver reservation lapses.
    /// Zero means the reservation lasts until the deadline.
    pub reservation_expires: u64,
    pub status: IntentStatus,
    pub solver: Option<Address>,
    pub solver_evm: Option<BytesN<32>>,
    pub fill_amount: i128,
    pub fill_ledger: u32,
}

/// PROPOSED Phase 3: Aggregate reputation metrics for a solver.
/// Keyed by solver address in SolverReputation storage.
#[contracttype]
#[derive(Clone)]
pub struct SolverReputationRecord {
    /// Total number of intents filled by this solver.
    pub fill_count: u64,
    /// Number of fills that completed successfully (reached ConfirmationSent).
    pub success_count: u64,
    /// Exponential weighted moving average (EWMA) of fill latency in ledgers.
    /// Computed as: ewma = 0.9 * ewma + 0.1 * latency (legacy smooth factor).
    /// Stored as i128 fixed-point or direct ledger count.
    pub ewma_latency: i128,
}

/// LayerZero message origin (the subset Perihelion authenticates against).
#[contracttype]
#[derive(Clone)]
pub struct Origin {
    pub src_eid: u32,
    pub sender: BytesN<32>,
    pub nonce: u64,
}

/// Stellar recipient type codes used in FillInstruction wire format.
pub const RECIPIENT_TYPE_ACCOUNT: u8 = 0x30; // G... account (0x06 << 3)
pub const RECIPIENT_TYPE_CONTRACT: u8 = 0x10; // C... contract (0x02 << 3)

/// A registration instruction from the source chain (FillInstruction), decoded
/// at the endpoint/adapter boundary into native Soroban types.
///
/// Canonical wire format (227 bytes):
///   version(1) | type(1) | intent_hash(32) | src_eid(4) | recipient(56)
///   | dest_asset(69) | min_dest_amount(16) | deadline(8)
///   | preferred_solver(32) | reservation_window(8)
///
/// `recipient` is a right-zero-padded Stellar strkey. `dest_asset` is the
/// user-signed Stellar asset identifier (`native` or `CODE:ISSUER`), also
/// right-zero-padded to preserve the EVM wire representation. The adapter must
/// resolve that identifier to the configured Soroban token address before
/// constructing an `IntentRecord`; it must not interpret the bytes as a strkey
/// address.
#[contracttype]
#[derive(Clone)]
pub struct FillInstruction {
    pub intent_hash: BytesN<32>,
    pub src_eid: u32,
    pub recipient: Address,
    pub dest_asset: Address,
    pub min_dest_amount: i128,
    pub deadline: u64,
    pub preferred_solver: Option<Address>,
    /// Seconds from registration during which only the preferred solver may fill.
    /// After this window lapses, any solver may fill. Zero means no reservation.
    pub reservation_window: u64,
}

/// A cancellation instruction delivered inbound.
#[contracttype]
#[derive(Clone)]
pub struct CancelInstruction {
    pub intent_hash: BytesN<32>,
    pub reason: u32,
}

/// Tagged inbound message handed to `lz_receive`.
#[contracttype]
#[derive(Clone)]
pub enum LzMessage {
    FillInstruction(FillInstruction),
    Cancel(CancelInstruction),
}

/// Parameters for an outbound LayerZero send. Simplified abstraction over the
/// LayerZero V2 `MessagingParams`; the real endpoint adapter maps this 1:1.
#[contracttype]
#[derive(Clone)]
pub struct MessagingParams {
    pub dst_eid: u32,
    pub receiver: BytesN<32>,
    pub message: Bytes,
}
