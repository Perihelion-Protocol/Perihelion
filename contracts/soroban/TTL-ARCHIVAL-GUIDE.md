# TTL Archival and Client Restore Guide

## Overview

Soroban archives persistent storage entries when their Time-To-Live (TTL) expires. This is a rent mechanism that prevents unbounded state growth. For the Perihelion settlement contract, understanding TTL management and archival behavior is critical for correct client implementation.

## Contract TTL Strategy

The Perihelion contract uses a two-tier TTL strategy to ensure terminal state remains queryable even after detailed records archive:

### Intent Records (shorter TTL)
- **Storage Key**: `DataKey::Intent(intent_hash)`
- **TTL**: `ttl_for_deadline(deadline)` = `(deadline - now) / 4s + GRACE_LEDGERS`
  - Converts the intent deadline to ledgers (using minimum 4s close time for safety)
  - Adds `GRACE_LEDGERS` (~7 days) to absorb late confirmations and refunds
  - Clamped to `MAX_TTL` (3,110,400 ledgers ≈ 180 days)
- **Contains**: Full intent details including recipient, amounts, deadline, solver, etc.

### Terminal Markers (longer TTL)
- **Storage Keys**: 
  - `DataKey::Settled(intent_hash)` - written when intent is filled
  - `DataKey::Cancelled(intent_hash)` - written when intent is cancelled
  - `DataKey::ConfirmationSent(intent_hash)` - written when FillConfirmed is dispatched
- **TTL**: `MAX_TTL` (3,110,400 ledgers ≈ 180 days)
- **Contains**: Just a boolean flag indicating terminal state

### Retention Asymmetry (Issue #29)

**By design**, terminal markers outlive intent records:
- After an intent's grace period expires, its full `IntentRecord` may be archived
- The `Settled` or `Cancelled` marker persists longer (MAX_TTL from last touch)
- This allows terminal state queries to succeed even when detailed records are gone

## Client Implementation Requirements

### When to Restore Archived Entries

Clients (solvers, relayers, keepers) interacting with old intents **MUST** restore archived entries before calling state-mutating methods:

```rust
// Pseudocode for client restore workflow
fn fill_old_intent(intent_hash: BytesN<32>) -> Result<()> {
    // 1. Check if entry is archived
    let entry_exists = soroban_rpc.getLedgerEntry(DataKey::Intent(intent_hash))?;
    
    if entry_exists.is_none() {
        // 2. Entry is archived - include in restore footprint
        let restore_footprint = vec![DataKey::Intent(intent_hash)];
        let restore_tx = RestoreTransaction {
            footprint: restore_footprint,
        };
        soroban_rpc.sendTransaction(restore_tx)?;
        
        // Wait for restore to confirm
        wait_for_restore_confirmation()?;
    }
    
    // 3. Now call fill_intent - entry is guaranteed accessible
    perihelion_contract.fill_intent(
        solver,
        solver_evm,
        intent_hash,
        fill_amount,
        lz_fee
    )?;
    
    Ok(())
}
```

### Methods Requiring Restore

These methods read the `IntentRecord` and will fail if it's archived without prior restore:

- **`fill_intent`** - Checks intent status, deadline, preferred solver
- **`deliver_intent`** - Same as fill_intent (separate delivery path)
- **`cancel_expired_intent`** - Reads intent to verify deadline passed and dispatch cancel
- **`dispatch_confirmation`** - Reads intent to get src_eid and solver details

### Methods That Work Without Restore

These methods only consult markers or instance storage and work even if the full record is archived:

- **`is_settled(intent_hash)`** - Reads `DataKey::Settled` marker only
- **`is_cancelled(intent_hash)`** - Reads `DataKey::Cancelled` marker only
- **`status(intent_hash)`** - Checks markers first, falls back to record
  - Returns terminal state from markers even if record is archived
  - May return `None` if neither markers nor record exist
- **`quote_lz_fee`** - Reads instance config only

### View Behavior After Archival

```rust
// After an intent's record archives but before markers expire:

// ✅ Works - reads marker only
let is_done = contract.is_settled(intent_hash); 
// Returns: true (from Settled marker)

// ✅ Works - checks markers first
let state = contract.status(intent_hash);
// Returns: Some(IntentStatus::ConfirmationSent)

// ⚠️ Returns None - record is archived
let record = contract.get_intent(intent_hash);
// Returns: None

// ❌ WRONG: Interpreting None as "not settled"
if record.is_none() {
    // DON'T assume intent was never filled!
    // Check status() or is_settled() instead.
}

// ✅ RIGHT: Use status() or markers for terminal state
match contract.status(intent_hash) {
    Some(IntentStatus::ConfirmationSent) => {
        // Intent was filled and confirmed
    },
    Some(IntentStatus::Cancelled) => {
        // Intent was cancelled
    },
    Some(IntentStatus::Locked) => {
        // Intent is still pending (record exists)
    },
    None => {
        // Intent never existed OR record archived before terminal marker written
        // (The latter should never happen under normal operation)
    }
}
```

## Relayer Implementation (Issue #6)

Relayers watching for cross-chain events MUST implement restore-then-act for aged intents:

1. **Monitor TTL**: Track intent deadlines and TTL expiry times
2. **Restore before relay**: If relaying a fill/cancel for an intent near TTL expiry:
   ```
   if (now - intent_registered_time) > TYPICAL_RECORD_TTL:
       restore_intent_entry(intent_hash)
   relay_fill_confirmed(intent_hash, ...)
   ```
3. **Handle restore failures**: If restore fails (entry truly doesn't exist), log and skip

## Testing

The `ttl_archival.t.rs` test module provides comprehensive coverage of TTL boundary behavior:

- **`intent_record_archived_after_ttl_expires`**: Verifies record archival timeline
- **`fill_intent_succeeds_after_manual_restore`**: Tests fill after restore
- **`cancel_expired_intent_succeeds_after_manual_restore`**: Tests cancel after restore  
- **`settled_marker_survives_after_record_archived`**: Validates marker retention asymmetry
- **`cancelled_marker_survives_after_record_archived`**: Same for cancelled intents
- **`fill_rejected_when_settled_marker_exists_but_record_archived`**: Guards against double-fill via markers
- **`cancel_rejected_when_settled_marker_exists_but_record_archived`**: Guards against invalid cancel
- **`status_view_returns_correct_state_when_only_markers_exist`**: View function correctness
- **`marker_record_ttl_asymmetry_allows_terminal_state_query_after_archive`**: Issue #29 behavior
- **`inbound_nonce_archival_resets_replay_protection`**: Nonce TTL edge case

Run tests:
```bash
cd contracts/soroban/settlement
cargo test ttl_archival
```

## Production Recommendations

1. **Monitor contract storage**: Set up alerts for intents approaching TTL expiry
2. **Proactive TTL extension**: For long-running intents, extend TTL before expiry
3. **Client retry logic**: Implement restore + retry on "entry not found" errors
4. **Nonce safety**: Ensure `InboundNonceBase` and `InboundNonceBitmap` never archive
   - These have MAX_TTL and are extended on every message
   - Archival would reset replay protection (security risk)
5. **Use `status()` for terminal state**: Never rely on `get_intent() == None` alone

## Related Issues

- **Issue #6**: Relayer-side restore-then-act for archived entries
- **Issue #29**: Retention asymmetry between markers and records
- **Issue #30**: TTL calculation overflow (fixed via u64 clamping before cast)

## Technical Deep Dive

### Why Markers Outlive Records

The asymmetry is intentional and solves a fundamental tension:

1. **Storage efficiency**: Detailed records (200+ bytes) don't need to live forever
2. **Correctness requirement**: Terminal state (filled/cancelled) must remain queryable indefinitely
3. **Solution**: Small markers (1-byte bool) have MAX_TTL, large records have deadline-bound TTL

This lets the contract "forget" intent details after settlement but remember *that settlement occurred*, preventing double-spend and enabling long-term audits.

### TTL Calculation Safety

```rust
fn ttl_for_deadline(env: &Env, deadline: u64) -> u32 {
    let now = env.ledger().timestamp();
    let secs = deadline.saturating_sub(now);
    
    // Convert seconds to ledgers, add grace, clamp to MAX_TTL
    let ledgers_u64 = (secs / MIN_SECS_PER_LEDGER)
        .saturating_add(GRACE_LEDGERS as u64)
        .min(MAX_TTL as u64);
    
    // Safe cast: value is in [0, MAX_TTL] ⊆ [0, u32::MAX]
    ledgers_u64 as u32
}
```

**Safety invariants:**
- Division by `MIN_SECS_PER_LEDGER` (4s) over-provisions ledgers when actual close time is longer
- Always rounds TTL **up**, never down (safe direction: over-provision > under-provision)
- Clamp in u64 space before cast prevents overflow wraparound

### Marker Semantics

```
┌─────────────────────────────────────────────────────────────┐
│ Intent Lifecycle and Marker Timeline                        │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  Register           Fill             Confirm                 │
│     │                │                  │                     │
│     ▼                ▼                  ▼                     │
│  [Intent]────────>[Intent]──────────>[Intent]                │
│  Locked          +Settled          +ConfirmSent              │
│     │            marker            marker                     │
│     │                │                  │                     │
│     └────────────────┴──────────────────┘                    │
│          Record TTL: deadline + grace                        │
│                                                              │
│     ┌───────────────────────────────────────────────────┐   │
│     │        Marker TTL: MAX_TTL (from last touch)      │   │
│     └───────────────────────────────────────────────────┘   │
│                                                              │
│  After record archives:                                      │
│     - get_intent() → None                                    │
│     - is_settled() → true (from marker)                      │
│     - status() → ConfirmationSent (from marker)              │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

## Contact

For questions or issues related to TTL management:
- Review `docs/TECHNICAL-ARCHITECTURE.md` §5 (Storage and TTL)
- Check existing issues tagged `ttl` or `archival`
- See test coverage in `src/ttl_archival.t.rs`

