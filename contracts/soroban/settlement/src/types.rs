// SPDX-License-Identifier: MIT

use soroban_sdk::{contracttype, Address, Bytes, BytesN};

pub use crate::constants::{
    CANCEL_INTENT_LENGTH, CANCEL_REASON_ADMIN, CANCEL_REASON_EXPIRED, CANCEL_REASON_INVALID,
    FILL_CONFIRMED_LENGTH, FILL_INSTRUCTION_LENGTH, MSG_CANCEL_INTENT, MSG_FILL_CONFIRMED,
    MSG_FILL_INSTRUCTION, PROTOCOL_VERSION,
};

/// Deterministic policy rejection codes emitted in `fill_instruction_rejected`
/// (issues #1063, #1064). These are terminal: the transport nonce is consumed
/// and a `RejectedIntent` tombstone is written so the packet is not retried.
/// Transport/authentication failures (untrusted peer, stale nonce, malformed
/// payload) are NOT represented here and continue to revert.
pub const REJECTION_INVALID_AMOUNT: u32 = 0x00;
pub const REJECTION_DEADLINE_TOO_FAR: u32 = 0x01;
pub const REJECTION_DEADLINE_TOO_SOON: u32 = 0x02;
pub const REJECTION_EXCEEDS_MAX_INTENT_AMOUNT: u32 = 0x03;
pub const REJECTION_UNSUPPORTED_DEST_ASSET: u32 = 0x04;
pub const REJECTION_MISSING_PEER: u32 = 0x05;

/// Deterministic policy rejection classification for inbound FillInstructions.
#[contracttype]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum RejectionCode {
    /// `min_dest_amount` is non-positive or otherwise invalid.
    InvalidAmount = 0,
    /// `deadline` exceeds the maximum allowed horizon.
    DeadlineTooFar = 1,
    /// `deadline` is already past or too close to allow any fill (issue #1064).
    DeadlineTooSoon = 2,
    /// `min_dest_amount` exceeds the configured per-intent cap.
    ExceedsMaxIntentAmount = 3,
    /// `dest_asset` is not an allowlisted / resolvable destination asset.
    UnsupportedDestAsset = 4,
    /// No trusted peer is configured for the source eid.
    MissingPeer = 5,
}

impl RejectionCode {
    /// Numeric code carried in the `fill_instruction_rejected` event.
    pub fn as_u32(self) -> u32 {
        match self {
            RejectionCode::InvalidAmount => REJECTION_INVALID_AMOUNT,
            RejectionCode::DeadlineTooFar => REJECTION_DEADLINE_TOO_FAR,
            RejectionCode::DeadlineTooSoon => REJECTION_DEADLINE_TOO_SOON,
            RejectionCode::ExceedsMaxIntentAmount => REJECTION_EXCEEDS_MAX_INTENT_AMOUNT,
            RejectionCode::UnsupportedDestAsset => REJECTION_UNSUPPORTED_DEST_ASSET,
            RejectionCode::MissingPeer => REJECTION_MISSING_PEER,
        }
    }
}

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
    /// Hot guardian address permitted to pause the contract (issue #1072).
    /// Mirrors the EVM escrow's `guardian`: it can only pause, never unpause
    /// or change configuration. Settable by admin only.
    Guardian,
    /// Ledger timestamp at which a guardian-initiated pause auto-expires
    /// (issue #1072). Zero when the pause was not initiated by the guardian
    /// (or when the contract is unpaused). Enforced on every state-changing
    /// entry point so a compromised guardian cannot halt the contract
    /// indefinitely.
    GuardianPauseExpiry,
    /// Ledger timestamp of the last guardian-initiated pause (issue #1072).
    /// Used to enforce the cooldown between consecutive guardian pauses,
    /// matching the EVM escrow semantics.
    GuardianLastPauseAt,
    /// Trusted remote OApp (the EVM escrow) per source endpoint id.
    Peer(u32),
    /// Pending peer change proposed by admin, awaiting approval after delay.
    /// Stores (eid, proposed_peer, proposed_at_timestamp). Issue #165.
    PendingPeer(u32),
    /// Timestamp when the current pending peer change was proposed.
    /// Used to enforce the minimum peer-change delay. Issue #165.
    PendingPeerTime(u32),
    /// Configurable delay (in seconds) for the current pending peer change.
    /// Validated to be between MIN_PEER_CHANGE_DELAY and MAX_PEER_CHANGE_DELAY. Issue #715.
    PendingPeerDelay(u32),
    /// Per-corridor pause flag. When set for an eid, all inbound and outbound
    /// operations for that corridor are blocked independently of the global flag.
    /// Allows quarantining a single compromised chain without halting others.
    ///
    /// Persistent tier (issue #1074): kept out of instance storage so the
    /// instance entry stays fixed-size. The key is removed on unpause rather
    /// than written as `false`, and its TTL is extended on every write.
    PausedEid(u32),
    /// Native token (SAC) address for the settlement network (Testnet, Futurenet, or Pubnet).
    /// Required to pay keeper rewards. Issue #173.
    NativeToken,
    /// Keeper reward in stroops (Stellar's smallest unit) paid to callers of
    /// `cancel_expired_intent`. Incentivizes timely refund processing (issue #173).
    KeeperReward,
    /// Keeper reward in stroops paid to callers of `dispatch_confirmation`.
    /// Incentivizes third-party dispatch of stalled FillConfirmed messages,
    /// closing the window where a solver has paid out on Stellar but the
    /// source-chain escrow has not yet been notified. Independent of
    /// `KeeperReward` so the two incentives can be tuned separately.
    DispatchKeeperReward,
    /// Configurable maximum TTL for TTL extensions (issue #340).
    /// If unset, defaults to MAX_TTL_DEFAULT. Settable by admin.
    MaxTtl,
    /// Admin-configured Type-3 LayerZero executor options blob for outbound
    /// messages to a destination eid (issue #1065). Used verbatim for both
    /// `quote_lz_fee` and `dispatch` so quotes match sends. When unset, a
    /// default executor `lzReceive` gas limit is encoded.
    EnforcedOptions(u32),

    // Instance tier (value caps, issue #145).
    /// Maximum amount a single intent can register per asset (0 = unlimited).
    MaxIntentAmount(Address),
    /// Rolling window duration in seconds per asset (0 = disabled).
    RollingWindowDuration(Address),
    /// Maximum aggregate settled amount within rolling window per asset (0 = unlimited).
    RollingWindowCap(Address),
    /// Whether rolling-window cap has been triggered per asset.
    RollingWindowTriggered(Address),
    /// Earliest timestamp to allow resetting the rolling-window cap per asset.
    RollingWindowResetEarliestAt(Address),

    // Instance tier (rolling-window accumulator, issue #145). Only the current
    // window's bucket is kept (#905).
    /// Rolling-window bucket: (asset, window start timestamp) => cumulative settled amount.
    RollingWindowBucket(Address, u64),
    /// Latest memoized window start timestamp per asset (for efficiency).
    LatestWindowStart(Address),

    // Persistent tier (destination assets, issue #1074).
    /// Contract-native (SEP-41) token allowed as a `C...` `dest_asset`. Present
    /// (as `true`) iff the admin allowlisted it. `native` and `CODE:ISSUER`
    /// identifiers resolve without an entry; see `asset.rs`.
    ///
    /// Persistent tier (issue #1074): the allowlist is unbounded, so keeping
    /// it in instance storage would grow the entry read on every invocation.
    /// Entries are written with TTL management and removed on de-allowlisting.
    AllowedDestToken(Address),

    // Persistent tier (per-intent lifecycle).
    Intent(BytesN<32>),
    /// Terminal idempotency marker: set iff the intent was settled.
    Settled(BytesN<32>),
    /// Terminal idempotency marker: set iff the intent was cancelled.
    Cancelled(BytesN<32>),
    /// Terminal rejection tombstone (issues #1063, #1064): set iff an inbound
    /// FillInstruction was deterministically rejected by policy. Consumes the
    /// transport nonce and prevents re-registration; a CancelIntent may then be
    /// dispatched. Value is the `RejectionCode` that caused the rejection.
    RejectedIntent(BytesN<32>),
    /// Idempotency marker: set once FillConfirmed has been dispatched for this intent.
    ConfirmationSent(BytesN<32>),

    // Persistent tier (transport bookkeeping).
    /// Aggregate reputation metrics for a solver, keyed by solver address.
    SolverReputation(Address),
    /// Unbounded per-(eid, word_index) nonce bitmap for unordered delivery
    /// (issue #285). Soroban stores each bitmap word as a `u64`; this is
    /// semantically equivalent to the EVM bitmap but uses 64-bit storage words
    /// rather than the EVM's 256-bit `uint256` words.
    ///
    /// A nonce `n` is tracked at:
    ///   word_index = n / 64
    ///   bit_index  = n % 64
    ///
    /// Each Soroban storage word covers 64 consecutive nonces. The equivalent
    /// EVM word uses `wordIndex = nonce / 256` and `bitIndex = nonce % 256`.
    /// Words are written lazily on first use and are never discarded, so nonces
    /// from any message-in-flight window are accepted exactly once regardless
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
    /// Per-eid nonce pruning floor (issue #718): every nonce `n <`
    /// `InboundNonceFloor(eid)` is permanently rejected as already consumed.
    /// The floor is the first nonce not covered by the fully-consumed words
    /// pruned so far; it is not a claim that all higher nonces are consumed.
    /// `prune_nonce_words` advances it only after verifying every bit in each
    /// deleted 64-nonce word is set. Archiving/deleting bitmap words below the
    /// floor therefore cannot reopen a replay; nonces at or above the floor
    /// continue to use their bitmap word (or its implicit zero state).
    InboundNonceFloor(u32),
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

    // Instance tier (delayed endpoint rotation, issue #500).
    /// Pending endpoint address proposed by admin, awaiting confirmation
    /// after the minimum delay. Mirrors `PendingPeer` for the analogous
    /// two-step peer-change flow.
    PendingEndpoint,
    /// Timestamp when the current pending endpoint change was proposed.
    /// Used to enforce `MIN_PEER_CHANGE_DELAY` / `PEER_CHANGE_GRACE`.
    PendingEndpointTime,
    /// Configurable delay (in seconds) for the current pending endpoint change.
    /// Validated to be between MIN_PEER_CHANGE_DELAY and MAX_PEER_CHANGE_DELAY.
    /// Mirrors `PendingPeerDelay` for the analogous two-step endpoint flow.
    PendingEndpointDelay,
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
    /// Ledger sequence at which the intent was registered (the start event for
    /// the solver fill-latency metric). Reputation latency is measured as
    /// `fill_ledger - registered_ledger`, i.e. the number of ledgers between
    /// registration and fill, independent of when the solver was dispatched.
    pub registered_ledger: u32,
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
    /// Number of latency samples folded into `ewma_latency`. Zero means the
    /// EWMA is uninitialised (no sentinel value is stored in `ewma_latency`),
    /// so a genuine zero-latency fill is still recorded correctly.
    pub samples: u64,
    /// Exponential weighted moving average (EWMA) of fill latency in ledgers.
    /// Latency is measured from the documented start event — the ledger at
    /// which the intent was registered (`IntentRecord::registered_ledger`) —
    /// to the ledger at which it was filled (`IntentRecord::fill_ledger`).
    /// Computed as: ewma = 0.9 * ewma + 0.1 * latency (legacy smooth factor).
    /// Only meaningful when `samples > 0`; the first sample initialises it.
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
/// Wire format (227 bytes):
///   version(1) | type(1) | intent_hash(32) | src_eid(4) | recipient(56)
///   | dest_asset(69) | min_dest_amount(16) | deadline(8) | preferred_solver(32)
///   | reservation_window(8)
///
/// `recipient` contains the full Stellar strkey text (56 bytes), while `dest_asset`
/// contains its canonical text form (up to 69 bytes). Both are decoded into Soroban
/// `Address` objects at the adapter boundary. The body carries no source eid: the
/// routing eid is the authenticated LayerZero origin (#1051).
#[contracttype]
#[derive(Clone)]
pub struct FillInstruction {
    pub intent_hash: BytesN<32>,
    pub recipient: Address,
    pub dest_asset: Address,
    pub min_dest_amount: i128,
    pub deadline: u64,
    pub preferred_solver: Option<Address>,
    /// EVM solver identity that locked the source escrow. Raw canonical
    /// FillInstructions always carry this value; typed test messages may omit it.
    pub locked_solver: Option<BytesN<32>>,
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

/// Parameters for an outbound LayerZero V2 send. The endpoint adapter maps
/// these fields to the official `MessagingParams`; the fee remains an explicit
/// repository-level argument because Soroban does not expose an EVM-style
/// `msg.value` call surface.
#[contracttype]
#[derive(Clone)]
pub struct MessagingParams {
    pub dst_eid: u32,
    pub receiver: BytesN<32>,
    pub message: Bytes,
    pub options: Bytes,
    pub pay_in_lz_token: bool,
}
