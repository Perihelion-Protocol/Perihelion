# Migration Guide: Signature Verification Caching

## Overview

This guide helps existing solver operators migrate to the new version with signature verification caching and hash validation.

## Breaking Changes

### Required Environment Variables

Two previously optional environment variables are now **required**:

1. **`PERIHELION_SOURCE_CHAIN_ID`** - EVM chain ID for signature verification
2. **`PERIHELION_ESCROW_ADDRESS`** - PerihelionEscrow contract address

### Why These Are Required

The solver now:
- Independently recomputes intent hashes for validation (requires `sourceChainId` and `escrowAddress` for EIP-712 domain)
- Verifies signatures using the correct domain separator (prevents cross-chain/cross-contract replay)

Previously, the SDK's `PerihelionClient` was instantiated without these parameters, which meant signature verification wasn't possible through the client interface.

## Migration Steps

### 1. Update Environment Variables

Edit your `.env` file and add the required variables:

```bash
# Required (new)
PERIHELION_SOURCE_CHAIN_ID=8453              # Chain ID (8453 = Base, 1 = Ethereum, etc.)
PERIHELION_ESCROW_ADDRESS=0x1234567890...    # Your escrow contract address

# Optional (new)
PERIHELION_VERIFICATION_CACHE_SIZE=10000     # Default: 10,000 entries
```

**Common Chain IDs:**
- Ethereum Mainnet: `1`
- Base: `8453`
- Arbitrum One: `42161`
- Optimism: `10`
- Polygon: `137`

### 2. Rebuild the Solver

```bash
npm run build
```

### 3. Restart Your Solver Node

```bash
npm start
# or
pm2 restart perihelion-solver
# or
systemctl restart perihelion-solver
```

### 4. Verify Operation

Check your logs for successful startup:

```
[info] solver started { solver: '0x...', mempool: 'http://...' }
```

Watch for any new warnings:
- `rejecting intent: mempool hash mismatch` - The mempool returned an incorrect hash
- `rejecting intent with invalid signature` - Signature verification failed (now properly checked)

## New Behavior

### Hash Validation

The solver now validates that the mempool's returned hash matches the independently recomputed hash:

```typescript
const recomputedHash = hashIntent(intent, domain);
if (recomputedHash !== record.hash) {
  // Reject - mempool sent wrong hash
}
```

This catches mempool bugs or malicious behavior early.

### Verification Caching

Signature verification results are cached by intent hash:

- **First encounter**: Verify signature via ECDSA recovery (expensive)
- **Subsequent encounters**: Use cached result (O(1) lookup)
- **Cache full**: Evict oldest entry (LRU)

**Benefits:**
- Reduces CPU usage on reconsidered intents
- Faster poll cycles at high intent volume
- Predictable memory usage (bounded by cache size)

## Configuration Tuning

### Cache Size

The default cache size (10,000 entries) works well for most operators. Consider tuning based on your traffic:

**Low volume** (< 100 intents/hour):
```bash
PERIHELION_VERIFICATION_CACHE_SIZE=1000
```

**Medium volume** (100-1000 intents/hour):
```bash
PERIHELION_VERIFICATION_CACHE_SIZE=10000  # default
```

**High volume** (> 1000 intents/hour):
```bash
PERIHELION_VERIFICATION_CACHE_SIZE=50000
```

**Memory impact**: ~7 bytes per cached entry (66-byte hash + 1-byte boolean + overhead)
- 1,000 entries ≈ 7 KB
- 10,000 entries ≈ 70 KB
- 50,000 entries ≈ 350 KB

### Cache Hit Rate

Expected hit rates after your solver has been running:

- **First hour**: ~0-20% (cache warming up)
- **After 1 hour**: ~60-80% (common intents cached)
- **Steady state**: ~80-95% (for patterns with recurring intents)

## Rollback Plan

If you need to rollback to the previous version:

1. Stop your solver
2. Check out the previous git commit/tag
3. Remove the new environment variables from `.env` (optional)
4. Rebuild: `npm run build`
5. Restart: `npm start`

## Troubleshooting

### Error: "PERIHELION_SOURCE_CHAIN_ID not set"

**Cause**: Missing required environment variable

**Fix**: Add `PERIHELION_SOURCE_CHAIN_ID=<your_chain_id>` to your `.env` file

### Error: "PERIHELION_ESCROW_ADDRESS not set"

**Cause**: Missing required environment variable

**Fix**: Add `PERIHELION_ESCROW_ADDRESS=0x...` to your `.env` file (same address as `PERIHELION_ESCROW_ADDRESS` in executor config)

### Warning: "rejecting intent: mempool hash mismatch"

**Cause**: The mempool returned a hash that doesn't match the recomputed hash

**Actions**:
1. Check mempool health/version
2. Verify your `PERIHELION_SOURCE_CHAIN_ID` and `PERIHELION_ESCROW_ADDRESS` are correct
3. Report to mempool operator if persistent

### Warning: "rejecting intent with invalid signature"

**Cause**: The intent's signature doesn't verify against `intent.user`

**Actions**:
1. This is expected behavior for malicious/malformed intents
2. If all intents are rejected, verify your chain ID and escrow address are correct
3. Check that you're using the same domain parameters as the mempool

### High Memory Usage

**Cause**: Cache size too large for your needs

**Fix**: Reduce `PERIHELION_VERIFICATION_CACHE_SIZE` to 1000 or 5000

### Low Cache Hit Rate

**Symptom**: CPU usage hasn't decreased after migration

**Possible causes**:
1. Very low intent reconsideration rate (cache isn't being leveraged)
2. Cache size too small relative to unique intent volume
3. Most intents are unique (expected behavior)

**Actions**:
1. Monitor logs for repeated intent hashes
2. Increase cache size if you see re-verification of recent intents
3. This is expected if your mempool rarely reconsiders intents

## Performance Monitoring

After migration, monitor these metrics:

### Before Migration
- CPU usage during poll cycles
- Average poll cycle duration
- Number of intents processed per second

### After Migration
- **Expected**: 10-30% reduction in CPU usage (depends on reconsideration rate)
- **Expected**: Faster poll cycles for reconsidered intents
- **New**: Occasional "hash mismatch" warnings (should be rare)

## Support

If you encounter issues not covered in this guide:

1. Check your logs for specific error messages
2. Verify all environment variables are set correctly
3. Confirm your `sourceChainId` matches your escrow deployment
4. Open an issue with logs and configuration (redact private keys!)

## Summary Checklist

- [ ] Add `PERIHELION_SOURCE_CHAIN_ID` to `.env`
- [ ] Add `PERIHELION_ESCROW_ADDRESS` to `.env`
- [ ] (Optional) Add `PERIHELION_VERIFICATION_CACHE_SIZE` to `.env`
- [ ] Run `npm run build`
- [ ] Restart solver node
- [ ] Verify startup logs show no errors
- [ ] Monitor for new warning types
- [ ] Observe CPU usage reduction over time

## Timeline

**Recommended**: Migrate within 1 week of release

**Required**: Migrate before the next breaking release (TBD)

The verification caching is backward compatible in behavior (same fill decisions), but the new security checks (hash validation) may surface mempool issues that were previously undetected.
