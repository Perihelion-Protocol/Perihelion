use soroban_sdk::contracterror;

/// Contract error codes, assigned in HTTP-analogue bands for fast triage:
/// `1xx` lifecycle, `13x` authorization, `14x` intent preconditions,
/// `16x` messaging, `5xx` invariant/internal. Surfaced to clients as
/// `Error(Contract, #code)`.
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum PerihelionError {
    // --- Initialization / lifecycle ---
    /// `initialize` called when already initialized.
    AlreadyInitialized = 100,
    /// Entrypoint called before `initialize`.
    NotInitialized = 101,
    /// State-mutating call while paused.
    ContractPaused = 102,

    // --- Authorization ---
    /// Caller is not the configured endpoint.
    NotEndpoint = 130,
    /// Caller is not the admin.
    NotAdmin = 131,
    /// Intent reserved for a different preferred solver.
    ReservedForSolver = 132,
    /// Caller is not the pending admin nominee (accept_admin guard).
    NotPendingAdmin = 133,
    /// Admin and endpoint addresses must be distinct (initialize guard, issue #18).
    AdminEndpointCollision = 134,

    // --- Intent preconditions ---
    /// No registered intent for the given hash.
    IntentNotFound = 140,
    /// Intent already in a terminal state.
    IntentFinalized = 141,
    /// fill_intent called after the deadline.
    IntentExpired = 142,
    /// cancel_expired_intent called before the deadline.
    DeadlineNotPassed = 143,
    /// Delivered amount below the user's slippage floor.
    InsufficientFillAmount = 144,
    /// Non-positive amount supplied.
    InvalidAmount = 145,
    /// Intent already filled (fill race lost).
    AlreadyFilled = 146,
    /// FillInstruction deadline exceeds MAX_DEADLINE_HORIZON from now.
    DeadlineTooFar = 147,

    // --- Messaging ---
    /// Payload failed structural validation.
    MalformedPayload = 160,
    /// Unknown message type.
    UnknownMessageType = 161,
    /// Inbound nonce at or below the high-water mark (replay).
    StaleNonce = 162,
    /// Sender is not the registered peer for the inbound endpoint id.
    UntrustedPeer = 163,

    // --- Invariant / internal ---
    /// Arithmetic error that prior checks should have made unreachable.
    ArithmeticError = 500,
}
