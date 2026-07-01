# Event Emission Test Coverage for Soroban Contract (closes #102)

## Summary

This PR adds comprehensive test coverage for Soroban contract event emissions, asserting the exact topics and data payloads for all lifecycle events (registered, filled, cancelled) and admin/config events.

## Problem

Events are the off-chain integration surface for indexers, relayers, and monitoring tooling. Without assertions on event shapes, a refactor could silently change an event's topic or payload structure and break every downstream consumer without any test failing.

## Changes

### 1. Enhanced Event Shape Tests (`contracts/soroban/settlement/src/test.rs`)

Added assertion functions that verify exact event values:

- `assert_registered_event` — verifies topics = ("registered", intent_hash) and data = (src_eid, deadline)
- `assert_filled_event` — verifies topics = ("filled", intent_hash) and data = (solver, dest_asset, fill_amount, src_eid)
- `assert_cancelled_event` — verifies topics = ("cancelled", intent_hash) and data = (src_eid, deadline)
- `assert_cancelled_inbound_event` — verifies topics = ("cancelled_inbound", intent_hash) and data = (src_eid,)
- `assert_confirmation_sent_event` — verifies topics = ("confirmation_sent", intent_hash) and data = (solver,)
- `assert_cancel_ignored_event` — verifies topics = ("cancel_ignored", intent_hash) and data = (status as u32,)

Helper functions `matches_symbol` and `matches_bytes32` support the assertions by providing type-safe ScVal matching.

### 2. Updated Event Shape Documentation (`contracts/soroban/settlement/src/lib.rs`)

Enhanced the event shape specification comment block to include:
- Lifecycle event mapping to EVM equivalents (Locked ↔ registered, Released ↔ filled, Refunded ↔ cancelled)
- Clear documentation of Soroban-only audit events (cancelled_inbound, cancel_ignored)

### 3. Updated Technical Architecture Documentation (`docs/TECHNICAL-ARCHITECTURE.md`)

Extended section 9.3 to include a complete event reference with:
- Lifecycle Events table showing Soroban↔EVM mapping
- Config/Admin Events table
- Audit/Race Condition Events table for `cancelled_inbound` and `cancel_ignored`

## Acceptance Criteria

- [x] Soroban tests assert topics and payloads of all emitted events (registered, filled, cancelled, plus admin/config events)
- [x] Event shapes are documented as an integration contract
- [x] A change to any event payload would fail a test until updated

## Testing

The tests verify:
1. Event topic symbols match expected values
2. Intent hashes are correctly indexed in topics where applicable
3. Data payloads contain the exact expected values (src_eid, deadline, fill_amount, status)

Run tests with:
```bash
cd contracts/soroban && cargo test --release
```

## Related Issues

- #16 — Admin/config events
- #15 — Peer symmetry
- #21 — Cancel error taxonomy

closes #102