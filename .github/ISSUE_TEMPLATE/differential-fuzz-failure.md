---
name: Differential Fuzzing Failure
about: Report a codec divergence detected by differential fuzzing
title: '[FUZZ] '
labels: ['bug', 'security', 'wire-format', 'differential-fuzz']
assignees: ''
---

## Summary
<!-- Brief description of the codec divergence -->

## Failing Test
<!-- Which test failed? -->
- [ ] EVM (Foundry)
- [ ] Soroban (Proptest)
- [ ] Cross-validation

**Test name:** `testFuzz_...` or `prop_...`

## Reproduction

### Counterexample
<!-- For Solidity failures, paste the Foundry counterexample -->
```
[FAIL. Reason: ...]
  Counterexample: calldata=0x...
  args=[...]
```

<!-- For Rust failures, attach or paste the proptest regression file -->
```
proptest-regressions/fuzz/<test_name>.txt
```

### Reproduce Locally
```bash
# Solidity
cd contracts/evm
forge test --match-test <test_name> --fuzz-seed <SEED>

# Rust
cd contracts/soroban/settlement
cargo test fuzz -- <test_name> --nocapture
```

### Failing Payload
<!-- If available, attach the hex-encoded payload -->
```
0x...
```

## Analysis

### Expected Behavior
<!-- What should happen? -->

### Actual Behavior
<!-- What actually happened? -->

### Divergence Type
- [ ] Round-trip mismatch (encode → decode != original)
- [ ] Asymmetric rejection (one side accepts, other rejects)
- [ ] Incorrect error (wrong revert reason)
- [ ] Length mismatch
- [ ] Field corruption
- [ ] Other: ___________

## Impact Assessment

### Severity
- [ ] **Critical** — can cause fund loss
- [ ] **High** — breaks cross-chain settlement
- [ ] **Medium** — causes rejection of valid messages
- [ ] **Low** — edge case, unlikely in practice

### Affected Message Types
- [ ] FillConfirmed
- [ ] CancelIntent
- [ ] FillInstruction (future)
- [ ] Other: ___________

### Exploitability
<!-- Can an attacker trigger this? What's the attack scenario? -->

## Root Cause
<!-- If identified, describe the bug -->

**Location:**
- Solidity: `contracts/evm/src/PerihelionEscrow.sol:L???`
- Rust: `contracts/soroban/settlement/src/messages.rs:L???`

**Issue:**
<!-- Explain the discrepancy -->

## Fix

### Proposed Solution
<!-- How should this be fixed? -->

### Regression Test
- [ ] Add failing case to fixed golden vectors (`neg/*.hex`)
- [ ] Commit proptest regression file
- [ ] Add explicit unit test covering this case

## Checklist
- [ ] Reproduced locally
- [ ] Impact assessed
- [ ] Root cause identified
- [ ] Fix implemented
- [ ] Regression test added
- [ ] Both codecs pass differential fuzz after fix
- [ ] Golden vectors updated if needed
