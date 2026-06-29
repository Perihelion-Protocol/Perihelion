.PHONY: help fuzz fuzz-bounded fuzz-extended fuzz-nightly fuzz-evm fuzz-rust fuzz-cross clean-corpus test

help: ## Show this help message
	@echo 'Usage: make [target]'
	@echo ''
	@echo 'Available targets:'
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  %-20s %s\n", $$1, $$2}'

fuzz: fuzz-bounded ## Run differential fuzzing (default: bounded mode)

fuzz-bounded: ## Run differential fuzzing with 100 cases (~30s)
	@echo "Running bounded differential fuzzing (100 cases)..."
	@bash scripts/run-differential-fuzz.sh bounded

fuzz-extended: ## Run differential fuzzing with 10k cases (~5min)
	@echo "Running extended differential fuzzing (10k cases)..."
	@bash scripts/run-differential-fuzz.sh extended

fuzz-nightly: ## Run differential fuzzing with 100k cases (~1hr)
	@echo "Running nightly differential fuzzing (100k cases)..."
	@bash scripts/run-differential-fuzz.sh nightly

fuzz-evm: ## Run only EVM differential fuzzing
	@echo "Running EVM differential fuzzing..."
	cd contracts/evm && forge test --match-contract DifferentialFuzz -vv

fuzz-rust: ## Run only Rust differential fuzzing
	@echo "Running Rust differential fuzzing..."
	cd contracts/soroban/settlement && PROPTEST_CASES=100 cargo test fuzz -- --test-threads=1

fuzz-cross: ## Run cross-language validation
	@echo "Running cross-language validation..."
	cd contracts/evm && forge test --match-contract CrossValidate -vv

clean-corpus: ## Remove generated fuzz corpus files
	@echo "Cleaning fuzz corpus..."
	@rm -f contracts/shared/wire-vectors/fuzz-corpus/*.hex
	@rm -rf contracts/soroban/settlement/proptest-regressions/
	@echo "Corpus cleaned."

test: ## Run all tests including differential fuzzing
	@echo "Running all tests..."
	cd contracts/evm && forge test
	cd contracts/soroban/settlement && cargo test

.DEFAULT_GOAL := help
