# Authorization Failure Tests - No State Mutation (closes #104)

## Summary

This PR adds comprehensive negative tests for lzReceive authorization failures on both chains, verifying that rejected calls do not mutate any state (nonce, locks, balances, events).

## Problem

lzReceive enforces three critical authorization checks:

1. **Caller is the endpoint** — `NotEndpoint` error
2. **origin.sender is the trusted peer** — `UntrustedPeer` error
3. **Nonce is fresh** — `StaleNonce` error

These are the **trust boundary of the entire inbound path** — they stop forged messages from releasing or refunding funds. Each rejection must not only revert but leave all observable state unchanged. A test that asserts only the revert can miss bugs where a check reverts but earlier code already mutated state.

## Changes

### Soroban (`contracts/soroban/settlement/src/test.rs`)

Added negative tests with state immutability assertions:

- `untrusted_peer_rejected_no_state_change` — Verifies nonce base/bitmap unchanged, no events emitted, no intent registered
- `stale_nonce_rejected_no_state_change` — Verifies nonce state unchanged on replay attempt

Each test captures state before the call, asserts the correct error, then verifies:
- `inboundNonceBase(eid)` and `inboundNonceBitmap(eid)` are unchanged
- No events were emitted during the failed call
- No locks/intents were modified

### EVM (`contracts/evm/test/PerihelionEscrow.t.sol`)

Added negative tests:

- `test_NotEndpoint_NoNonceChange` — Verifies nonce unchanged on endpoint auth failure
- `test_UntrustedPeer_NoNonceChange` — Verifies nonce unchanged on wrong peer failure
- `test_StaleNonce_NoStateChange` — Verifies lock state preserved on replay rejection
- `test_MalformedPayload_NoNonceChange` — Verifies nonce unchanged on malformed payload
- `test_UnknownMessageType_NoNonceChange` — Verifies nonce unchanged on unknown type

## Acceptance Criteria

- [x] Each inbound authorization/validation failure has a test asserting specific error
- [x] Tests verify absence of state mutation (nonce, locks, balances, events)
- [x] Trust boundary is pinned on both chains

## Testing

```bash
# Soroban
cd contracts/soroban && cargo test --release untrusted_peer_rejected_no_state_change stale_nonce_rejected_no_state_change

# EVM
cd contracts/evm && forge test --match-test "NoNonceChange|NoStateChange"
```

closes #104