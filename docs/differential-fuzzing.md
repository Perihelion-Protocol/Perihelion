# Differential Fuzzing for Wire Format Codecs

## Problem Statement

Hand-written conformance vectors (like `fill_confirmed.hex`) only cover cases someone thought to write. Two independently implemented codecs can share a blind spot that no fixed vector exercises.

A differential fuzzer generates random structured messages, encodes them on one side, decodes on the other, and asserts:
1. **Round-trip equality** — decode(encode(msg)) = msg
2. **Symmetric rejection** — malformed inputs are rejected identically

This approach finds divergences that fixed vectors miss — exactly the class of bug that causes cross-chain fund loss when one side accepts a payload the other encodes differently.

## Architecture

### Components

```
┌─────────────────────────────────────────────────────────────┐
│                   Differential Fuzzing Harness              │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌──────────────────┐           ┌──────────────────┐       │
│  │  Foundry Fuzzer  │           │  Proptest Fuzzer │       │
│  │  (Solidity)      │           │  (Rust)          │       │
│  ├──────────────────┤           ├──────────────────┤       │
│  │ • Generate msg   │           │ • Generate msg   │       │
│  │ • Encode         │           │ • Encode         │       │
│  │ • Decode         │           │ • Decode         │       │
│  │ • Assert ==      │           │ • Assert ==      │       │
│  │ • Mutate & test  │           │ • Export corpus  │       │
│  └────────┬─────────┘           └────────┬─────────┘       │
│           │                              │                 │
│           │                              │                 │
│           │      ┌───────────────────────┘                 │
│           │      │                                         │
│           ▼      ▼                                         │
│  ┌────────────────────────────┐                            │
│  │  Cross-Language Validator  │                            │
│  │  (Solidity reads Rust)     │                            │
│  ├────────────────────────────┤                            │
│  │ • Read fuzz-corpus/*.hex   │                            │
│  │ • Decode with Solidity     │                            │
│  │ • Assert symmetric results │                            │
│  └────────────────────────────┘                            │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### 1. Solidity Fuzzer (`DifferentialFuzz.t.sol`)

Foundry's built-in fuzzer generates random inputs for each test function:

```solidity
function testFuzz_FillConfirmedRoundTrip(
    bytes32 intentHash,
    address solverEvm,
    uint128 amount,
    uint64 ledger
) public view {
    // Encode with Solidity
    bytes memory encoded = abi.encodePacked(
        bytes1(0x01), bytes1(0x02), intentHash,
        bytes32(uint256(uint160(solverEvm))), amount, ledger
    );
    
    // Decode with Solidity
    (bytes32 h2, address s2, uint128 a2, uint64 l2) = 
        harness.decodeFillConfirmed(encoded);
    
    // Assert round-trip
    assertEq(h2, intentHash);
    assertEq(s2, solverEvm);
    assertEq(a2, amount);
    assertEq(l2, ledger);
}
```

**Mutation tests** apply structural transformations and assert rejection:
- Truncate payload (short)
- Append extra bytes (long)
- Modify version byte (bad version)
- Change message type (unknown type)
- Corrupt field constraints (nonzero high bytes, invalid reason codes)

### 2. Rust Fuzzer (`fuzz.rs`)

Proptest generates random structured data using strategies:

```rust
proptest! {
    #[test]
    fn prop_fill_confirmed_round_trip(
        intent_hash in arb_hash(),
        solver_evm in arb_evm_address(),
        fill_amount in arb_amount(),
        fill_ledger in arb_ledger(),
    ) {
        let env = Env::default();
        let encoded = encode_fill_confirmed(
            &env, &intent_hash, &solver_evm, fill_amount, fill_ledger
        );
        
        // Assert layout and decode round-trip
        assert_eq!(encoded.len(), 90);
        // ... decode and assert field equality
    }
}
```

**Corpus export**: Adversarial cases are written to `fuzz-corpus/*.hex`:

```rust
fn export_to_corpus(name: &str, payload: &Bytes) {
    let hex = format!("0x{}", hex::encode(payload));
    fs::write(format!("fuzz-corpus/{}.hex", name), hex)
        .expect("Failed to write corpus");
}
```

### 3. Cross-Language Validator (`CrossValidate.t.sol`)

Reads Rust-generated payloads and decodes them with Solidity:

```solidity
function testCrossValidateCorpus_FillConfirmedNonzeroHigh() public {
    bytes memory payload = vm.parseBytes(
        vm.readFile("../shared/wire-vectors/fuzz-corpus/fill_confirmed_nonzero_high.hex")
    );
    
    // This was valid on Rust side, but MUST reject on Solidity
    vm.expectRevert(PerihelionEscrow.MalformedPayload.selector);
    harness.decodeFillConfirmed(payload);
}
```

## Message Types Covered

### FillConfirmed (90 bytes)

Layout: `version(1) | type(1) | intent_hash(32) | solver_evm(32) | amount(16) | ledger(8)`

**Fuzzing properties:**
- `intent_hash` — full 32-byte entropy
- `solver_evm` — valid EVM address (high 12 bytes = 0)
- `amount` — 0 to max i128 (Stellar stroops range)
- `ledger` — full u32 range

**Mutation tests:**
- Length != 90 → `MalformedPayload`
- Version != 0x01 → `MalformedPayload`
- Type != 0x02 → `UnknownMessageType`
- `solver_evm[0..12]` non-zero → `MalformedPayload`

### CancelIntent (35 bytes)

Layout: `version(1) | type(1) | intent_hash(32) | reason(1)`

**Fuzzing properties:**
- `intent_hash` — full 32-byte entropy
- `reason` — {0x00, 0x01, 0x02} (EXPIRED, ADMIN, INVALID)

**Mutation tests:**
- Length != 35 → `MalformedPayload`
- Version != 0x01 → `MalformedPayload`
- Type != 0x03 → `UnknownMessageType`
- Reason > 0x02 → `MalformedPayload`

## Running the Harness

### Local Quick Check (100 cases, ~30s)
```bash
./scripts/run-differential-fuzz.sh bounded
```

### Thorough Local Run (10k cases, ~5 min)
```bash
./scripts/run-differential-fuzz.sh extended
```

### Deep Fuzzing (100k cases, ~1 hour)
```bash
./scripts/run-differential-fuzz.sh nightly
```

### Individual Components

**Solidity only:**
```bash
cd contracts/evm
forge test --match-contract DifferentialFuzz --fuzz-runs 1000 -vv
```

**Rust only:**
```bash
cd contracts/soroban/settlement
PROPTEST_CASES=1000 cargo test fuzz -- --test-threads=1
```

**Cross-validation:**
```bash
cd contracts/evm
forge test --match-contract CrossValidate -vv
```

## CI Integration

### On Every PR
- Bounded run (100 cases per codec)
- Fast feedback (<2 min total)
- Catches obvious regressions

### Nightly Schedule
- Extended run (10k cases per codec)
- Deep coverage of edge cases
- Results in workflow summary

### Manual Trigger
GitHub Actions → Differential Fuzz → Run workflow
- Toggle "Run extended fuzzing" for 10k cases
- On-demand deep validation

### Failure visibility

A scheduled or manually-triggered run that fails opens a tracking issue
automatically from
[`.github/ISSUE_TEMPLATE/differential-fuzz-failure.md`](../.github/ISSUE_TEMPLATE/differential-fuzz-failure.md)
(the `report` job in `differential-fuzz.yml`). PR runs do not open an issue —
a red PR check is already visible to the author — this is specifically for
the case a scheduled run fails with nobody watching.

## Reproducing Failures

### Solidity Failure

Foundry prints the counterexample:
```
[FAIL. Reason: MalformedPayload]
  testFuzz_FillConfirmedRoundTrip(bytes32,address,uint128,uint64)
  Counterexample: calldata=0x...
  args=[0x1111..., 0xAAAA..., 1000000, 42]
```

Reproduce with the exact seed:
```bash
forge test --match-test testFuzz_FillConfirmedRoundTrip \
    --fuzz-seed <SEED_FROM_LOG>
```

### Rust Failure

Proptest writes a regression file:
```
proptest-regressions/fuzz/prop_fill_confirmed_round_trip.txt
```

Content:
```
cc 123456789abcdef # shrinks to intent_hash = [...], solver_evm = [...]
```

Re-run automatically:
```bash
cargo test fuzz
```

Proptest detects and re-runs regressions. To ignore:
```bash
rm proptest-regressions/fuzz/*.txt
```

### Cross-Validation Failure

Inspect the failing corpus file:
```bash
cat contracts/shared/wire-vectors/fuzz-corpus/fill_confirmed_nonzero_high.hex
```

Decode manually:
```bash
cd contracts/evm
cast abi-decode "decodeFillConfirmed(bytes)" \
    $(cat ../shared/wire-vectors/fuzz-corpus/fill_confirmed_nonzero_high.hex)
```

Run verbose test:
```bash
forge test --match-test testCrossValidateCorpus_FillConfirmedNonzeroHigh -vvvv
```

## Adding New Message Types

When introducing a new wire message (e.g., `RefundRequest`):

### 1. Add Solidity Round-Trip Test
```solidity
function testFuzz_RefundRequestRoundTrip(
    bytes32 intentHash,
    uint256 refundAmount
) public view {
    bytes memory encoded = abi.encodePacked(
        bytes1(0x01), bytes1(0x04), intentHash, uint128(refundAmount)
    );
    (bytes32 h2, uint128 a2) = harness.decodeRefundRequest(encoded);
    assertEq(h2, intentHash);
    assertEq(a2, refundAmount);
}
```

### 2. Add Rust Proptest
```rust
proptest! {
    #[test]
    fn prop_refund_request_round_trip(
        intent_hash in arb_hash(),
        refund_amount in arb_amount(),
    ) {
        let encoded = encode_refund_request(&env, &intent_hash, refund_amount);
        assert_eq!(encoded.len(), 51); // 1+1+32+16+1
        // decode and assert equality
    }
}
```

### 3. Add Mutation Tests
- Length validation
- Version check
- Type check
- Field constraints (e.g., amount range)

### 4. Update CI

No changes needed — new tests are auto-discovered.

## Limitations

- **String fields** not fully fuzzed (Stellar-specific encoding). The
  `recipient`/`dest_asset` fields currently carry a truncated strkey **string**
  that the Soroban decoder reinterprets as raw contract-id **bytes** — a
  real, tracked mismatch (issue #271) that pure encode→decode round-trip
  proptests cannot detect, since both sides "agree" on the wire value while
  both are wrong relative to the sender's actual address. `fuzz.rs` includes
  a specification-derived test that pins this gap explicitly — see
  [`contracts/shared/wire-vectors/DIFFERENTIAL-FUZZING.md`](../contracts/shared/wire-vectors/DIFFERENTIAL-FUZZING.md#specification-derived-vs-implementation-derived-vectors).
- **Nested structures** tested as flat fields
- **Nonce replay** tested separately (transport layer, not codec)
- **Performance**: 100k cases take ~1 hour; not feasible per-commit

## Security Considerations

### What This Catches
✅ Encoder/decoder divergence (field order, byte layout)  
✅ Length mismatch (truncation, padding)  
✅ Type confusion (wrong discriminant, version)  
✅ Field constraint violations (nonzero high bytes, bad reason codes)  
✅ Edge cases in numeric ranges (overflow, underflow)  

### What This Doesn't Catch
❌ Logic bugs (correct codec, wrong business logic)  
❌ Semantic divergence (same bytes, different interpretation)  
❌ Replay attacks (tested separately)  
❌ Cryptographic issues (signature validation, randomness)  

Differential fuzzing is **one layer** of defense. Combine with:
- Fixed golden vectors (`WireFormat.t.sol`)
- Integration tests (`Integration.t.sol`)
- Invariant tests (`Invariant.t.sol`)
- Manual security review

## References

- [Fuzzing Book](https://www.fuzzingbook.org/) — theory and techniques
- [Foundry Fuzzing](https://book.getfoundry.sh/forge/fuzz-testing)
- [Proptest Guide](https://proptest-rs.github.io/proptest/intro.html)
