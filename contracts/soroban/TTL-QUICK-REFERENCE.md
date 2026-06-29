# TTL Archival Quick Reference

## For Contract Developers

### Storage Tiers

| Entry Type | TTL | Why |
|------------|-----|-----|
| Intent Record | `deadline + 7 days` (max 180 days) | Detailed data, archives after settlement window |
| Settled Marker | `MAX_TTL` (180 days) | Tiny flag, must outlive record for correctness |
| Cancelled Marker | `MAX_TTL` (180 days) | Tiny flag, must outlive record for correctness |
| Nonce Tracking | `MAX_TTL` (180 days) | Critical for replay protection |

### View Functions

```rust
// ❌ WRONG - Don't use get_intent for terminal state
if contract.get_intent(hash).is_none() {
    // Could be wrong! Record might be archived while markers exist
}

// ✅ RIGHT - Use status() for terminal state
match contract.status(hash) {
    Some(IntentStatus::ConfirmationSent) => { /* settled */ },
    Some(IntentStatus::Cancelled) => { /* cancelled */ },
    Some(IntentStatus::Locked) => { /* pending */ },
    None => { /* never existed */ }
}
```

### Testing TTL Behavior

```rust
// Advance time in tests
fn advance_ledger(env: &Env, ledgers: u32) {
    env.ledger().with_mut(|li| {
        li.sequence += ledgers;
        li.timestamp += (ledgers as u64) * 5;
    });
}

// Simulate record archival (advance past deadline + grace)
advance_ledger(&env, 121_500); // > deadline TTL

// Marker should still exist
assert!(contract.is_settled(hash));
```

## For Client Developers

### When to Restore

Before calling these methods on old intents:
- `fill_intent`
- `deliver_intent`
- `cancel_expired_intent`
- `dispatch_confirmation`

### Restore Pattern

```typescript
async function fillOldIntent(intentHash: string) {
    // 1. Check if archived
    const entry = await rpc.getLedgerEntry(
        contractId,
        xdr.LedgerKey.contractData({
            contract: contractId,
            key: scValToNative(xdr.ScVal.scvVec([
                xdr.ScVal.scvSymbol('Intent'),
                xdr.ScVal.scvBytes(Buffer.from(intentHash, 'hex'))
            ])),
            durability: xdr.ContractDataDurability.persistent()
        })
    );
    
    if (!entry.entries || entry.entries.length === 0) {
        // 2. Restore archived entry
        const restoreTx = new TransactionBuilder(account, { fee: BASE_FEE })
            .addOperation(Operation.restoreFootprint({
                footprint: new xdr.LedgerFootprint({
                    readOnly: [],
                    readWrite: [ledgerKeyForIntent(intentHash)]
                })
            }))
            .build();
        
        await rpc.sendTransaction(restoreTx);
        await waitForConfirmation(restoreTx.hash());
    }
    
    // 3. Now fill
    const fillTx = contract.fill_intent({
        solver,
        solver_evm,
        intent_hash: intentHash,
        fill_amount: amount,
        lz_fee: fee
    });
    
    await rpc.sendTransaction(fillTx);
}
```

### Query Terminal State

```typescript
// ✅ Always use status() or markers
const status = await contract.status({ intent_hash: hash });

if (status === IntentStatus.ConfirmationSent) {
    // Intent was filled
} else if (status === IntentStatus.Cancelled) {
    // Intent was cancelled
}

// Or use marker views (work even if record archived)
const isSettled = await contract.is_settled({ intent_hash: hash });
const isCancelled = await contract.is_cancelled({ intent_hash: hash });
```

## For Relayer Developers

### Monitor TTL

```typescript
// Track when intents were registered
const registrationTime = await getIntentRegistrationTime(intentHash);
const deadline = await getIntentDeadline(intentHash);

// Calculate record TTL expiry
const recordTTL = Math.floor((deadline - registrationTime) / 4) + 120_960; // ledgers
const recordExpiry = registrationTime + (recordTTL * 5); // seconds

// If nearing expiry, restore before relay
if (Date.now() / 1000 > recordExpiry - 86400) { // 1 day buffer
    await restoreIntent(intentHash);
}
```

### Relay Pattern (Issue #6)

```typescript
async function relayFillConfirmation(event: FillConfirmedEvent) {
    const intentHash = event.intentHash;
    
    // 1. Check age
    const age = await getIntentAge(intentHash);
    
    if (age > TYPICAL_RECORD_TTL) {
        // 2. Restore if needed
        try {
            await restoreIntentIfArchived(intentHash);
        } catch (e) {
            console.log(`Intent ${intentHash} doesn't exist, skipping`);
            return;
        }
    }
    
    // 3. Relay the confirmation
    await contract.dispatch_confirmation({
        caller: relayerAddress,
        intent_hash: intentHash,
        lz_fee: fee
    });
}
```

## For Operators

### Monitoring

```bash
# Alert on intents nearing TTL expiry
SELECT intent_hash, deadline, registered_at
FROM intents
WHERE NOW() > (registered_at + ttl_for_deadline(deadline) - INTERVAL '7 days')
  AND status NOT IN ('ConfirmationSent', 'Cancelled')
```

### Emergency TTL Extension

If an intent is stuck near expiry:

```rust
// Option 1: Complete the settlement (extends TTL)
contract.fill_intent(...) // or cancel_expired_intent

// Option 2: Manual restore (if archived)
// Submit restore transaction with intent footprint

// Option 3: Accept that record will archive
// Terminal markers will still indicate state
```

### Health Checks

```bash
# Check marker vs record consistency
for intent in stuck_intents:
    record = contract.get_intent(intent)
    status = contract.status(intent)
    
    if record is None and status is not None:
        # Marker outlived record (expected)
        log("Intent {} record archived, marker exists", intent)
    elif record is None and status is None:
        # Intent never existed or fully expired
        log("Intent {} not found", intent)
```

## Common Pitfalls

### ❌ Don't Do This

```rust
// Assuming None means not filled
if get_intent(hash).is_none() {
    // Fill it!
    contract.fill_intent(...) // WRONG: might be already filled, record archived
}
```

### ✅ Do This

```rust
// Check terminal markers first
if contract.is_settled(hash) {
    return Err("Already filled");
}

match contract.status(hash) {
    Some(IntentStatus::Locked) => {
        // Can fill (but restore if old)
    },
    Some(IntentStatus::ConfirmationSent) => {
        return Err("Already confirmed");
    },
    _ => return Err("Cannot fill")
}
```

## References

- Full guide: `TTL-ARCHIVAL-GUIDE.md`
- Tests: `src/ttl_archival.rs`
- Technical architecture: `docs/TECHNICAL-ARCHITECTURE.md`

