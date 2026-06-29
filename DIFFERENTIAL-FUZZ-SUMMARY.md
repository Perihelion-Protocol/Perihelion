# Differential Fuzzing Implementation Summary

## What Was Built

A comprehensive differential fuzzing harness that validates the Solidity and Rust wire-format codecs remain synchronized across all cross-chain messages.

## Key Components

### 1. EVM Differential Fuzzer (`contracts/evm/test/DifferentialFuzz.t.sol`)
- **Purpose**: Foundry fuzz tests that generate random messages and validate Solidity encoder/decoder
- **Coverage**: FillConfirmed (90 bytes) and CancelIntent (35 bytes)
- **Tests**:
  - Round-trip equality for valid messages
  - Rejection of truncated/extended payloads
  - Validation of field constraints (nonzero high bytes, invalid reason codes)
  - Version and type discriminant checking
- **Runs**: 100 cases (bounded), 10k cases (extended), 100k cases (nightly)

### 2. Rust Proptest Fuzzer (`contracts/soroban/settlement/src/fuzz.rs`)
- **Purpose**: Property-based testing for Rust encoder with corpus export
- **Features**:
  - Same input distribution as EVM fuzzer
  - Generates adversarial payloads for cross-validation
  - Exports to `fuzz-corpus/*.hex` for Solidity to consume
  - Automatic regression tracking via proptest
- **Coverage**: Identical to EVM side for symmetry

### 3. Cross-Language Validator (`contracts/evm/test/CrossValidate.t.sol`)
- **Purpose**: Validates that Rust-generated payloads are handled identically by Solidity
- **How**: Reads hex files from `fuzz-corpus/`, decodes with Solidity, asserts expected results
- **Detects**: Cases where Rust accepts but Solidity rejects (or vice versa)

### 4. CI Integration (`.github/workflows/differential-fuzz.yml`)
- **On Every PR**: Bounded run (100 cases, ~1 min)
- **Nightly**: Extended run (10k cases, ~10 min)
- **Manual Trigger**: Configurable via GitHub Actions UI
- **Artifacts**: Uploads corpus files and failure logs

### 5. Local Runner (`scripts/run-differential-fuzz.sh`)
- **Modes**: bounded (100), extended (10k), nightly (100k)
- **Workflow**: Rust → EVM → Cross-validation in sequence
- **Output**: Summary of validated/rejected payloads

### 6. Documentation
- `docs/differential-fuzzing.md` — Architecture, usage, reproducing failures
- `contracts/shared/wire-vectors/DIFFERENTIAL-FUZZING.md` — Quick reference
- `contracts/shared/wire-vectors/fuzz-corpus/README.md` — Corpus management
- GitHub issue template for tracking failures
- Makefile targets for common workflows

## How to Use

### Quick Local Test
```bash
make fuzz-bounded
# or
./scripts/run-differential-fuzz.sh bounded
```

### Thorough Validation
```bash
make fuzz-extended
```

### Individual Components
```bash
# EVM only
cd contracts/evm
forge test --match-contract DifferentialFuzz --fuzz-runs 1000

# Rust only
cd contracts/soroban/settlement
PROPTEST_CASES=1000 cargo test fuzz -- --test-threads=1

# Cross-validation
cd contracts/evm
forge test --match-contract CrossValidate
```

## What This Catches

✅ **Encoder/decoder divergence** — field order, byte layout mismatches  
✅ **Length errors** — truncation, padding issues  
✅ **Type confusion** — wrong message discriminants  
✅ **Field constraint violations** — nonzero high bytes, invalid reason codes  
✅ **Edge cases in numeric ranges** — overflow, underflow, boundary conditions  

## Integration with Existing Tests

This harness **complements** rather than replaces:
- `WireFormat.t.sol` — Fixed golden vectors remain the canonical reference
- `Fuzz.t.sol` — Stateless property tests for value handling
- `Invariant.t.sol` — Conservation of funds and state machine correctness

The differential fuzzer is specifically for **cross-codec validation** — ensuring Rust and Solidity never drift apart.

## CI Expectations

### Every PR
- Differential fuzz runs automatically
- 100 cases per codec (~1 min total)
- Fails PR if divergence detected

### Nightly
- Extended 10k case run
- Deeper edge case coverage
- Results posted to workflow summary

### On Failure
- Proptest writes regression files to `proptest-regressions/`
- Foundry prints counterexample with seed
- Corpus files uploaded as artifacts
- GitHub issue template guides investigation

## Acceptance Criteria (Met)

✅ Differential fuzzer exercises both codecs on shared random inputs  
✅ Round-trip equality validated for all valid message types  
✅ Symmetric rejection of malformed inputs (length, version, type, fields)  
✅ CI integration with bounded (PR) and extended (nightly) runs  
✅ Documentation for architecture, usage, and reproducing failures  
✅ Cross-language validation via shared corpus  

## Next Steps

### For Contributors
1. When adding a new message type, add fuzz tests to both sides
2. Mutation tests for each structural invariant
3. Update `CrossValidate.t.sol` to handle new corpus files

### For Maintainers
1. Review corpus files in `fuzz-corpus/` periodically
2. Commit interesting edge cases discovered during fuzzing
3. Increase nightly runs to 100k cases as codebase stabilizes

### Future Enhancements
- [ ] Structured fuzzing for `FillInstruction` (158 bytes, string fields)
- [ ] Integration with external fuzz platforms (Echidna, Medusa)
- [ ] Differential gas metering (compare EVM vs estimated Soroban costs)
- [ ] Mutation-based fuzzing (e.g., Radamsa, AFL)

## Files Created

```
.github/
  ISSUE_TEMPLATE/differential-fuzz-failure.md
  workflows/differential-fuzz.yml
contracts/
  evm/test/
    DifferentialFuzz.t.sol
    CrossValidate.t.sol
  shared/wire-vectors/
    DIFFERENTIAL-FUZZING.md
    fuzz-corpus/README.md
  soroban/settlement/
    src/fuzz.rs
    Cargo.toml (updated: added proptest)
docs/
  differential-fuzzing.md
scripts/
  run-differential-fuzz.sh
Makefile
README.md (updated)
```

## Verification

To verify the implementation:

```bash
# 1. Run local bounded test
make fuzz-bounded

# 2. Check that corpus files are generated
ls -la contracts/shared/wire-vectors/fuzz-corpus/

# 3. Verify CI workflow syntax
gh workflow view differential-fuzz.yml

# 4. Run cross-validation
cd contracts/evm
forge test --match-contract CrossValidate -vv
```

## Impact

This implementation provides **systematic protection** against the most dangerous class of cross-chain bridge bugs: codec divergence. By continuously validating that Rust and Solidity handle the same inputs identically, it prevents scenarios where:

- One side accepts a payload the other rejects (causing stuck funds)
- Field corruption goes undetected (leading to wrong addresses/amounts)
- Edge cases slip through fixed test vectors (asymmetric behavior under load)

The harness is **production-ready** and integrated into CI, providing ongoing validation as the protocol evolves.
