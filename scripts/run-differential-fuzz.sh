#!/usr/bin/env bash
#
# Run differential fuzzing harness for Perihelion wire codecs.
#
# Usage:
#   ./scripts/run-differential-fuzz.sh [bounded|extended|nightly]
#
# Modes:
#   bounded  - 100 cases per codec (default, CI fast path)
#   extended - 10k cases per codec (thorough local validation)
#   nightly  - 100k cases per codec (deep fuzzing, CI nightly)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CORPUS_DIR="$REPO_ROOT/contracts/shared/wire-vectors/fuzz-corpus"

MODE="${1:-bounded}"

case "$MODE" in
  bounded)
    EVM_RUNS=100
    RUST_CASES=100
    ;;
  extended)
    EVM_RUNS=10000
    RUST_CASES=10000
    ;;
  nightly)
    EVM_RUNS=100000
    RUST_CASES=100000
    ;;
  *)
    echo "Error: unknown mode '$MODE'"
    echo "Usage: $0 [bounded|extended|nightly]"
    exit 1
    ;;
esac

echo "========================================="
echo "Differential Fuzzing ($MODE mode)"
echo "========================================="
echo "EVM runs: $EVM_RUNS"
echo "Rust cases: $RUST_CASES"
echo ""

# Create corpus directory
mkdir -p "$CORPUS_DIR"

# Step 1: Run Rust proptest fuzzer
echo "[1/3] Running Soroban proptest fuzzer..."
cd "$REPO_ROOT/contracts/soroban/settlement"
PROPTEST_CASES=$RUST_CASES cargo test fuzz -- --test-threads=1 --nocapture
echo "✓ Soroban fuzzing completed"
echo ""

# Step 2: Run Foundry differential fuzzer
echo "[2/3] Running EVM Foundry differential fuzzer..."
cd "$REPO_ROOT/contracts/evm"
forge test --match-contract DifferentialFuzz --fuzz-runs "$EVM_RUNS" -vv
echo "✓ EVM fuzzing completed"
echo ""

# Step 3: Cross-validate Rust-generated payloads with Solidity decoder
echo "[3/3] Cross-validating Rust corpus with Solidity..."
if [ -n "$(ls -A "$CORPUS_DIR" 2>/dev/null)" ]; then
  forge test --match-test testCrossValidateCorpus -vv
  echo "✓ Cross-validation completed"
else
  echo "⚠ No corpus files generated, skipping cross-validation"
fi
echo ""

echo "========================================="
echo "Differential fuzzing PASSED"
echo "========================================="
echo ""
echo "Next steps:"
echo "  - Review any proptest-regressions/ for Rust failures"
echo "  - Check forge test output for EVM failures"
echo "  - Inspect $CORPUS_DIR for generated payloads"
