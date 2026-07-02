# Perihelion — root-level task runner
#
# Single entrypoint for the polyglot monorepo.  Every target fans out to the
# correct toolchain so `make <target>` and the CI workflow call identical
# commands.  CI calls the same targets via ci.yml, so local and remote
# behaviour cannot drift.
#
# Toolchain requirements (only the stacks you're working on are needed):
#   Node.js ≥ 20  — TypeScript packages (sdk, solver, relayer, mempool)
#   Rust stable   — Soroban settlement contract
#   Foundry        — EVM escrow contract (forge)
#
# Usage:  make [target]   (default: help)

.PHONY: help \
        build build-ts build-soroban build-evm \
        test  test-ts  test-soroban  test-evm  \
        lint  lint-ts  lint-soroban  lint-evm  \
        fmt   fmt-ts   fmt-soroban   fmt-evm   \
        coverage coverage-ts coverage-evm      \
        gas                                    \
        audit audit-ts audit-evm               \
        clean                                  \
        fuzz fuzz-bounded fuzz-extended fuzz-nightly \
        fuzz-evm fuzz-rust fuzz-cross          \
        clean-corpus

# ─────────────────────────────────────────────────────────────────────────────
# Help
# ─────────────────────────────────────────────────────────────────────────────

help: ## Show available targets
	@echo 'Perihelion task runner — polyglot (TypeScript · Rust/Soroban · Solidity/Foundry)'
	@echo ''
	@echo 'Usage:  make [target]'
	@echo ''
	@echo 'Composite targets (run all stacks):'
	@grep -E '^(build|test|lint|fmt|coverage|gas|audit|clean):' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  %-22s %s\n", $$1, $$2}'
	@echo ''
	@echo 'Per-stack targets:'
	@grep -E '^[a-zA-Z_-]+-[a-zA-Z]+:.*?## ' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  %-22s %s\n", $$1, $$2}'
	@echo ''
	@echo 'Fuzzing targets:'
	@grep -E '^fuzz[a-zA-Z_-]*:.*?## ' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  %-22s %s\n", $$1, $$2}'

# ─────────────────────────────────────────────────────────────────────────────
# BUILD
# ─────────────────────────────────────────────────────────────────────────────

build: build-ts build-soroban build-evm ## Build all stacks

build-ts: ## Build TypeScript packages (sdk, solver, relayer, mempool)
	@echo "▶ build-ts"
	npm run build

build-soroban: ## Build Soroban settlement contract (wasm release)
	@echo "▶ build-soroban"
	cd contracts/soroban && cargo build --target wasm32-unknown-unknown --release

build-evm: ## Build EVM escrow contract (Foundry)
	@echo "▶ build-evm"
	cd contracts/evm && forge build

# ─────────────────────────────────────────────────────────────────────────────
# TEST
# ─────────────────────────────────────────────────────────────────────────────

test: test-ts test-soroban test-evm ## Run all test suites

test-ts: ## Run TypeScript tests (sdk, solver, relayer, mempool)
	@echo "▶ test-ts"
	npm test

test-soroban: ## Run Soroban/Rust unit tests
	@echo "▶ test-soroban"
	cd contracts/soroban && cargo test

test-evm: ## Run EVM Solidity tests (Foundry)
	@echo "▶ test-evm"
	cd contracts/evm && forge test -vvv

# ─────────────────────────────────────────────────────────────────────────────
# LINT
# ─────────────────────────────────────────────────────────────────────────────

lint: lint-ts lint-soroban lint-evm ## Lint all stacks

lint-ts: ## Lint TypeScript packages
	@echo "▶ lint-ts"
	npm run lint --if-present

lint-soroban: ## Clippy lint for Soroban contract
	@echo "▶ lint-soroban"
	cd contracts/soroban && cargo clippy --all-targets -- -D warnings

lint-evm: ## Slither static analysis for EVM contract (requires slither)
	@echo "▶ lint-evm"
	@if command -v slither >/dev/null 2>&1; then \
		cd contracts/evm && slither . --config-file slither.config.json; \
	else \
		echo "slither not found — skipping EVM lint (install: pip install slither-analyzer)"; \
	fi

# ─────────────────────────────────────────────────────────────────────────────
# FORMAT
# ─────────────────────────────────────────────────────────────────────────────

fmt: fmt-ts fmt-soroban fmt-evm ## Auto-format all stacks

fmt-ts: ## Format TypeScript (prettier, if configured)
	@echo "▶ fmt-ts"
	@if npm run fmt --if-present 2>/dev/null; then true; else \
		echo "No fmt script found in root package.json — skipping TypeScript formatting"; \
	fi

fmt-soroban: ## Format Rust code (rustfmt)
	@echo "▶ fmt-soroban"
	cd contracts/soroban && cargo fmt --all

fmt-evm: ## Format Solidity code (forge fmt)
	@echo "▶ fmt-evm"
	cd contracts/evm && forge fmt

# ─────────────────────────────────────────────────────────────────────────────
# COVERAGE
# ─────────────────────────────────────────────────────────────────────────────

coverage: coverage-ts coverage-evm ## Run coverage for all stacks (Rust uses cargo test)

coverage-ts: ## TypeScript test coverage via c8/node --experimental-test-coverage
	@echo "▶ coverage-ts"
	@if npm run coverage --if-present 2>/dev/null; then true; else \
		node --test --experimental-test-coverage --import tsx sdk/test/*.test.ts; \
	fi

coverage-evm: ## EVM Solidity coverage via forge coverage
	@echo "▶ coverage-evm"
	cd contracts/evm && forge coverage

# ─────────────────────────────────────────────────────────────────────────────
# GAS
# ─────────────────────────────────────────────────────────────────────────────

gas: ## Print EVM gas report (forge test --gas-report)
	@echo "▶ gas"
	cd contracts/evm && forge test --gas-report

# ─────────────────────────────────────────────────────────────────────────────
# AUDIT / SECURITY HELPERS
# ─────────────────────────────────────────────────────────────────────────────

audit: audit-ts audit-evm ## Run all security audit helpers

audit-ts: ## npm audit for TypeScript packages
	@echo "▶ audit-ts"
	npm audit

audit-evm: ## Slither + forge build for EVM (full static analysis pass)
	@echo "▶ audit-evm"
	cd contracts/evm && forge build
	@if command -v slither >/dev/null 2>&1; then \
		cd contracts/evm && slither . --config-file slither.config.json; \
	else \
		echo "slither not found — install with: pip install slither-analyzer"; \
	fi

# ─────────────────────────────────────────────────────────────────────────────
# CLEAN
# ─────────────────────────────────────────────────────────────────────────────

clean: ## Remove all build artefacts (dist/, target/, forge cache)
	@echo "▶ clean"
	npm run clean
	cd contracts/soroban && cargo clean
	cd contracts/evm && forge clean

# ─────────────────────────────────────────────────────────────────────────────
# DIFFERENTIAL FUZZING  (preserved from the original Makefile)
# ─────────────────────────────────────────────────────────────────────────────

fuzz: fuzz-bounded ## Run differential fuzzing (default: bounded, 100 cases ~30 s)

fuzz-bounded: ## Run differential fuzzing — bounded mode (100 cases, ~30 s)
	@echo "▶ fuzz-bounded"
	@bash scripts/run-differential-fuzz.sh bounded

fuzz-extended: ## Run differential fuzzing — extended mode (10 k cases, ~5 min)
	@echo "▶ fuzz-extended"
	@bash scripts/run-differential-fuzz.sh extended

fuzz-nightly: ## Run differential fuzzing — nightly mode (100 k cases, ~1 hr)
	@echo "▶ fuzz-nightly"
	@bash scripts/run-differential-fuzz.sh nightly

fuzz-evm: ## Run EVM-only differential fuzzing
	@echo "▶ fuzz-evm"
	cd contracts/evm && forge test --match-contract DifferentialFuzz -vv

fuzz-rust: ## Run Soroban/Rust differential fuzzing (100 proptest cases)
	@echo "▶ fuzz-rust"
	cd contracts/soroban/settlement && PROPTEST_CASES=100 cargo test fuzz -- --test-threads=1

fuzz-cross: ## Run cross-language validation (Soroban corpus → Solidity decoder)
	@echo "▶ fuzz-cross"
	cd contracts/evm && forge test --match-contract CrossValidate -vv

clean-corpus: ## Remove generated fuzz corpus files
	@echo "▶ clean-corpus"
	@rm -f contracts/shared/wire-vectors/fuzz-corpus/*.hex
	@rm -rf contracts/soroban/settlement/proptest-regressions/
	@echo "Corpus cleaned."

test-e2e: ## Run end-to-end integration tests
	@echo "Running end-to-end tests..."
	cd test && npm test

test-e2e-watch: ## Run end-to-end tests in watch mode
	@echo "Running end-to-end tests (watch mode)..."
	cd test && npm run test:watch

.DEFAULT_GOAL := help
