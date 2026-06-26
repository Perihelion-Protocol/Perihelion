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
    Endpoint,
    Paused,
    /// Trusted remote OApp (the EVM escrow) per source endpoint id.
    Peer(u32),

    // Persistent tier (per-intent lifecycle).
    Intent(BytesN<32>),
    /// Terminal idempotency marker: set iff the intent was settled.
    Settled(BytesN<32>),
    /// Terminal idempotency marker: set iff the intent was cancelled.
    Cancelled(BytesN<32>),
    /// Terminal idempotency marker: set iff the FillConfirmed was dispatched.
    ConfirmationSent(BytesN<32>),
    /// Solver reputation metrics (Phase 3).
    SolverReputation(Address),

    // Persistent tier (transport bookkeeping).
    /// Consumed nonce bitmap for a source endpoint id (unordered delivery).
    /// Tracks which nonces have been processed. The bitmap covers nonces in
    /// the range [base, base + 63] where base is stored separately.
    InboundNonceBitmap(u32),
    /// Base nonce for the bitmap (nonce 0 before first message).
    InboundNonceBase(u32),

    // Persistent tier (solver reputation — PROPOSED Phase 3).
    /// Aggregate reputation metrics for a solver address.
    SolverReputation(Address),
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

/// A registration instruction from the source chain (FillInstruction), decoded
/// at the endpoint/adapter boundary into native Soroban types.
///
/// NOTE: in the interface+mock phase, the LayerZero adapter is responsible for
/// decoding the raw wire bytes into this struct (carrying `recipient`/`dest_asset`
/// as Stellar addresses). The raw inbound byte codec is finalized once the
/// Soroban LayerZero ABI is GA; see the architecture spec §3.3.
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
