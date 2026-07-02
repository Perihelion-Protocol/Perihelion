# Nonce/Replay Guard Property Tests (closes #103)

## Summary

This PR adds comprehensive property tests for the nonce/replay guard mechanisms on both the Soroban (Rust) and EVM (Solidity) sides, ensuring unordered delivery semantics work correctly across chains.

## Problem

Replay/ordering bugs are security-critical and order-sensitive. The "out-of-order-drop issue" was a recent bug that example-based tests missed. Property tests over random delivery orderings expose these issues systematically.

## Changes

### 1. Soroban Property Tests (`contracts/soroban/settlement/src/fuzz.rs`)

Added `nonce_prop_tests` module with property tests:

- `prop_nonce_duplicates_rejected` — Verifies duplicate nonces are always rejected with StaleNonce
- `prop_nonce_window_ordering` — Verifies out-of-order nonces within the 64-wide window are all accepted
- `prop_nonce_zero_rejected` — Verifies nonce = 0 is always rejected
- `prop_large_nonce_advances_window` — Verifies large nonce gaps advance the window correctly

These tests use proptest to generate random nonce sequences including duplicates and gaps.

### 2. EVM Property Tests (`contracts/evm/test/Fuzz.t.sol`)

Added Foundry fuzz tests for nonce replay guards:

- `testFuzz_NonceZeroRejected` — Verifies nonce = 0 is always rejected
- `testFuzz_NonceReplayRejected` — Verifies replayed nonces are always rejected
- `testFuzz_NonceUnorderedDelivery` — Verifies out-of-order nonces within the bitmap window are all accepted
- `testFuzz_NonceLargeGap` — Verifies large nonce gaps advance the high-water mark appropriately

### 3. Cross-Chain Consistency

Both chains implement the same LayerZero lazy-nonce model:
- EVM: Bitmap-based nonce tracking (256-bit words) supporting unordered delivery
- Soroban: 64-wide sliding window with bitmap

The property tests ensure both sides:
1. Accept each nonce exactly once regardless of delivery order
2. Reject replayed nonces consistently
3. Advance the window appropriately on large gaps

## Acceptance Criteria

- [x] Property tests on both chains assert exactly-once processing and replay rejection over random nonce orderings
- [x] Tests include duplicates and gaps in generated sequences
- [x] Both chains agree on acceptance/rejection semantics for the nonce guard

## Testing

Run the Soroban property tests:
```bash
cd contracts/soroban && cargo test --release nonce_prop
```

Run the EVM fuzz tests:
```bash
cd contracts/evm && forge test --match-test testFuzz_Nonce
```

closes #103