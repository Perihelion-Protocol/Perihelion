# Differential Fuzzing Harness

## Overview

The differential fuzzing harness validates that the Solidity and Rust wire-format codecs remain in sync by:

1. **Generating random structured messages** within valid parameter ranges
2. **Round-trip testing** encode → decode equality on each side
3. **Mutation testing** adversarial inputs rejected identically by both
4. **Cross-language validation** Rust-generated payloads validated by Solidity

This catches codec divergence that fixed golden vectors (like `fill_confirmed.hex`) cannot detect — the exact class of bug that causes cross-chain fund loss.

## Architecture

### EVM Side (`contracts/evm/test/DifferentialFuzz.t.sol`)

Foundry fuzz tests that:
- Generate random `FillConfirmed` and `CancelIntent` messages
- Encode them in Solidity and assert decode round-trip equality
- Apply structural mutations (bad version, wrong length, nonzero high bytes, unknown reason codes)
- Assert symmetric rejection with expected error types

### Soroban Side (`contracts/soroban/settlement/src/fuzz.rs`)

Proptest-based fuzzer that:
- Generates random messages with the same distribution as EVM tests
- Validates Rust encode → decode round-trip
- Exports adversarial payloads to `fuzz-corpus/` for cross-validation
- Uses property-based testing for exhaustive coverage

### Cross-Language Validation

The Rust fuzzer exports generated payloads to:
```
contracts/shared/wire-vectors/fuzz-corpus/*.hex
```

The EVM test suite reads these files and validates that the Solidity decoder produces identical results or rejects identically.

## Running Locally

### Quick Run (100 cases, ~30 seconds)
```bash
./scripts/run-differential-fuzz.sh bounded
```

### Thorough Run (10k cases, ~5 minutes)
```bash
./scripts/run-differential-fuzz.sh extended
```

### Deep Fuzzing (100k cases, ~1 hour)
```bash
./scripts/run-differential-fuzz.sh nightly
```

### Manual Runs

**EVM only:**
```bash
cd contracts/evm
forge test --match-contract DifferentialFuzz --fuzz-runs 1000
```

**Soroban only:**
```bash
cd contracts/soroban/settlement
PROPTEST_CASES=1000 cargo test fuzz -- --test-threads=1
```

## CI Integration

### Pull Request Checks
- Bounded run (100 cases) on every PR
- Fast feedback loop (~1 minute total)

### Nightly Runs
- Extended run (10k cases) daily at 2 AM UTC
- Catches rare edge cases missed by bounded runs
- Results posted to workflow summary

### Manual Trigger
From GitHub Actions tab:
1. Select "Differential Fuzz" workflow
2. Click "Run workflow"
3. Toggle "Run extended fuzzing" for 10k cases

## Reproducing Failures

### EVM Failures
Foundry prints the failing seed and inputs:
```
[FAIL. Reason: MalformedPayload]
  Counterexample: calldata=0x... args=[intentHash, solver, amount, ledger]
```

Reproduce:
```bash
forge test --match-test testFuzz_FillConfirmedRoundTrip --fuzz-seed <SEED>
```

### Soroban Failures
Proptest writes regression files to `proptest-regressions/`:
```
contracts/soroban/settlement/proptest-regressions/fuzz/prop_fill_confirmed_round_trip.txt
```

Re-run to reproduce:
```bash
cargo test fuzz -- --test-threads=1
```
Proptest automatically detects and re-runs regressions.

### Cross-Validation Failures
Inspect the corpus file that triggered the failure:
```bash
cat contracts/shared/wire-vectors/fuzz-corpus/fill_confirmed_nonzero_high.hex
```

Decode manually with the harness:
```bash
cd contracts/evm
forge test --match-test testCrossValidateCorpus -vvvv
```

## Adding New Message Types

When adding a new wire message type:

1. **Add EVM test** to `DifferentialFuzz.t.sol`:
   ```solidity
   function testFuzz_NewMessageRoundTrip(
       bytes32 field1,
       uint128 field2
   ) public view {
       bytes memory encoded = abi.encodePacked(
           bytes1(0x01), bytes1(0x04), field1, field2
       );
       (bytes32 f1, uint128 f2) = harness.decodeNewMessage(encoded);
       assertEq(f1, field1);
       assertEq(f2, field2);
   }
   ```

2. **Add Rust proptest** to `fuzz.rs`:
   ```rust
   proptest! {
       #[test]
       fn prop_new_message_round_trip(
           field1 in arb_hash(),
           field2 in arb_amount(),
       ) {
           let encoded = encode_new_message(&env, &field1, field2);
           assert_eq!(encoded.len(), EXPECTED_LEN);
           // decode and assert equality
       }
   }
   ```

3. **Add mutation tests** for each structural invariant (length, version, type, field constraints)

4. **Document** the message layout in this file

## Known Limitations

- **String fields** (`destination`, `destAsset` in `FillInstruction`) are not fully fuzzed due to Stellar-specific encoding constraints
- **Address validation** assumes EVM addresses; Stellar addresses use a different format
- **Replay nonces** are tested separately (transport layer, not wire codec)

## References

- Golden vectors: `contracts/shared/wire-vectors/README.md`
- Fixed conformance tests: `contracts/evm/test/WireFormat.t.sol`
- Wire format spec: `docs/protocol-spec.md` §3.3
- Anti-replay architecture: `docs/TECHNICAL-ARCHITECTURE.md` §11
