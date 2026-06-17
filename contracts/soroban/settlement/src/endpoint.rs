//! Interface to the LayerZero endpoint contract.
//!
//! This is a minimal, swappable abstraction over the LayerZero V2 endpoint's
//! `send` entrypoint. During the interface+mock phase a mock contract implements
//! this surface (see `test.rs`); the real endpoint (or a thin adapter) implements
//! the same signature once the Soroban LayerZero stack is GA.

use soroban_sdk::{contractclient, Address, BytesN, Env};

use crate::types::MessagingParams;

/// The endpoint surface Perihelion depends on to dispatch outbound messages.
/// `#[contractclient]` generates `EndpointClient` for cross-contract calls.
#[contractclient(name = "EndpointClient")]
pub trait LzEndpoint {
    /// Dispatch a message to `params.dst_eid`/`params.receiver`. `refund_address`
    /// receives any excess native fee; `native_fee` is the fee the caller pays.
    /// Returns the message GUID.
    fn send(
        env: Env,
        params: MessagingParams,
        refund_address: Address,
        native_fee: i128,
    ) -> BytesN<32>;
}
