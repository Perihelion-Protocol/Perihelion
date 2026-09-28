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
        build-all-strict test-all-strict       \
        assert-all-toolchains                  \
        test  test-ts  test-soroban  test-evm  \
        test-e2e test-e2e-watch                \
        lint  lint-ts  lint-soroban  lint-evm  \
        fmt   fmt-ts   fmt-soroban   fmt-evm   \
        coverage coverage-ts coverage-soroban coverage-evm \
        gas                                    \
        audit audit-ts audit-evm audit-rust    \
        bytecode-check                         \
        clean                                  \
        fuzz fuzz-bounded fuzz-extended fuzz-nightly \
        fuzz-evm fuzz-rust fuzz-cross          \
        mutation mutation-ts mutation-soroban  \
        clean-corpus                           \
        doctor

# ─────────────────────────────────────────────────────────────────────────────
# Help
# ─────────────────────────────────────────────────────────────────────────────

help: ## Show available targets
	@echo 'Perihelion task runner — polyglot (TypeScript · Rust/Soroban · Solidity/Foundry)'
	@echo ''
	@echo 'Usage:  make [target]'
	@echo ''
	@echo 'Composite targets (run all stacks; gracefully skip missing toolchains):'
	@grep -E '^(build|test|lint|fmt|coverage|gas|audit|clean):' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  %-22s %s\n", $$1, $$2}'
	@echo ''
	@echo 'Strict composite targets (fail fast if any toolchain is missing — for CI):'
	@grep -E '^[a-zA-Z_-]+-all-strict:.*?## ' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  %-22s %s\n", $$1, $$2}'
	@echo ''
	@echo 'Per-stack targets (skip gracefully if their toolchain is missing):'
	@grep -E '^[a-zA-Z_-]+-[a-zA-Z]+:.*?## ' $(MAKEFILE_LIST) | grep -v -- '-all-strict:' | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  %-22s %s\n", $$1, $$2}'
	@echo ''
	@echo 'Fuzzing targets:'
	@grep -E '^fuzz[a-zA-Z_-]*:.*?## ' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  %-22s %s\n", $$1, $$2}'
	@echo ''
	@echo 'Mutation testing (slow — the nightly CI job runs these same targets):'
	@grep -E '^mutation[a-zA-Z_-]*:.*?## ' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  %-22s %s\n", $$1, $$2}'
	@echo ''
	@echo 'Diagnostics:'
	@grep -E '^doctor:.*?## ' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  %-22s %s\n", $$1, $$2}'

# ─────────────────────────────────────────────────────────────────────────────
# STRICT-CI HELPER
# ─────────────────────────────────────────────────────────────────────────────
# assert-all-toolchains is intentionally undocumented (no "## " comment) so it
# stays out of `make help` — it's an internal guard used by *-all-strict only.

assert-all-toolchains:
	@missing=""; \
	command -v npm   >/dev/null 2>&1 || missing="$$missing node/npm"; \
	command -v cargo >/dev/null 2>&1 || missing="$$missing cargo"; \
	command -v forge >/dev/null 2>&1 || missing="$$missing forge"; \
	if [ -n "$$missing" ]; then \
		echo "✖ missing required toolchain(s):$$missing"; \
		echo "  build-all-strict / test-all-strict require Node, Rust/cargo, and"; \
		echo "  Foundry/forge to ALL be installed — this target does not skip."; \
		echo "  Run 'make doctor' for a full report, or use 'make build'/'make test'"; \
		echo "  for the graceful per-stack behaviour instead."; \
		exit 1; \
	fi; \
	echo "✔ all toolchains present (node/npm, cargo, forge)"

# ─────────────────────────────────────────────────────────────────────────────
# BUILD
# ─────────────────────────────────────────────────────────────────────────────

build: build-ts build-soroban build-evm ## Build all stacks (skips a stack if its toolchain is missing)

build-ts: ## Build TypeScript packages (sdk, solver, relayer, mempool)
	@echo "▶ build-ts"
	npm run build

build-soroban: ## Build Soroban settlement contract (wasm release)
	@echo "▶ build-soroban"
	@if command -v cargo >/dev/null 2>&1; then \
		cd contracts/soroban && cargo build --target wasm32-unknown-unknown --release; \
	else \
		echo "⏭ skipping build-soroban — cargo not installed (install: https://rustup.rs)"; \
	fi

build-evm: ## Build EVM escrow contract (Foundry)
	@echo "▶ build-evm"
	@if command -v forge >/dev/null 2>&1; then \
		cd contracts/evm && forge build; \
	else \
		echo "⏭ skipping build-evm — forge not installed (install: https://getfoundry.sh)"; \
	fi

build-all-strict: assert-all-toolchains ## Build all stacks; FAILS if any toolchain is missing (CI use)
	@echo "▶ build-all-strict"
	@$(MAKE) --no-print-directory build-ts build-soroban build-evm
	@echo "✔ build-all-strict complete — node, cargo, and forge were all present"

# ─────────────────────────────────────────────────────────────────────────────
# TEST
# ─────────────────────────────────────────────────────────────────────────────

test: test-ts test-soroban test-evm test-e2e ## Run all test suites (skips a stack if its toolchain is missing)

test-ts: ## Run TypeScript tests (sdk, solver, relayer, mempool)
	@echo "▶ test-ts"
	npm test

test-soroban: ## Run Soroban/Rust unit tests
	@echo "▶ test-soroban"
	@if command -v cargo >/dev/null 2>&1; then \
		cd contracts/soroban && cargo test; \
	else \
		echo "⏭ skipping test-soroban — cargo not installed (install: https://rustup.rs)"; \
	fi

test-evm: ## Run EVM Solidity tests (Foundry)
	@echo "▶ test-evm"
	@if command -v forge >/dev/null 2>&1; then \
		cd contracts/evm && forge test -vvv; \
	else \
		echo "⏭ skipping test-evm — forge not installed (install: https://getfoundry.sh)"; \
	fi

test-all-strict: assert-all-toolchains ## Run all test suites; FAILS if any toolchain is missing (CI use)
	@echo "▶ test-all-strict"
	@$(MAKE) --no-print-directory test-ts test-soroban test-evm test-e2e
	@echo "✔ test-all-strict complete — node, cargo, and forge were all present"

# ─────────────────────────────────────────────────────────────────────────────
# LINT
# ─────────────────────────────────────────────────────────────────────────────

lint: lint-ts lint-soroban lint-evm ## Lint all stacks

lint-ts: ## Lint TypeScript packages
	@echo "▶ lint-ts"
	npm run lint --if-present

lint-soroban: ## Clippy lint for Soroban contract
	@echo "▶ lint-soroban"
	@if command -v cargo >/dev/null 2>&1; then \
		cd contracts/soroban && cargo clippy --all-targets -- -D warnings; \
	else \
		echo "⏭ skipping lint-soroban — cargo not installed (install: https://rustup.rs)"; \
	fi

lint-evm: ## Slither static analysis for EVM contract (requires slither)
	@echo "▶ lint-evm"
	@if command -v slither >/dev/null 2>&1; then \
		cd contracts/evm && slither src/ --config-file slither.config.json; \
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
		echo "⏭ skipping fmt-ts — no fmt script configured (Prettier not yet introduced)"; \
	fi

fmt-soroban: ## Format Rust code (rustfmt)
	@echo "▶ fmt-soroban"
	@if command -v cargo >/dev/null 2>&1; then \
		cd contracts/soroban && cargo fmt --all; \
	else \
		echo "⏭ skipping fmt-soroban — cargo not installed (install: https://rustup.rs)"; \
	fi

fmt-evm: ## Format Solidity code (forge fmt)
	@echo "▶ fmt-evm"
	@if command -v forge >/dev/null 2>&1; then \
		cd contracts/evm && forge fmt; \
	else \
		echo "⏭ skipping fmt-evm — forge not installed (install: https://getfoundry.sh)"; \
	fi

# ─────────────────────────────────────────────────────────────────────────────
# COVERAGE
# ─────────────────────────────────────────────────────────────────────────────

coverage: coverage-ts coverage-soroban coverage-evm ## Run coverage for all stacks

coverage-ts: ## TypeScript test coverage via c8/node --experimental-test-coverage
	@echo "▶ coverage-ts"
	npm run test:coverage

coverage-soroban: ## Soroban/Rust test coverage via cargo-llvm-cov
	@echo "▶ coverage-soroban"
	@if command -v cargo-llvm-cov >/dev/null 2>&1; then \
		cd contracts/soroban && cargo llvm-cov --all-features --workspace --lcov --output-path lcov.info; \
	else \
		echo "⏭ skipping coverage-soroban — cargo-llvm-cov not installed (install: cargo install cargo-llvm-cov)"; \
	fi

coverage-evm: ## EVM Solidity coverage via forge coverage
	@echo "▶ coverage-evm"
	@if command -v forge >/dev/null 2>&1; then \
		cd contracts/evm && forge coverage; \
	else \
		echo "⏭ skipping coverage-evm — forge not installed (install: https://getfoundry.sh)"; \
	fi

# ─────────────────────────────────────────────────────────────────────────────
# GAS
# ─────────────────────────────────────────────────────────────────────────────

gas: ## Print EVM gas report (forge test --gas-report)
	@echo "▶ gas"
	@if command -v forge >/dev/null 2>&1; then \
		cd contracts/evm && forge test --gas-report; \
	else \
		echo "⏭ skipping gas — forge not installed (install: https://getfoundry.sh)"; \
	fi

# ─────────────────────────────────────────────────────────────────────────────
# AUDIT / SECURITY HELPERS
# ─────────────────────────────────────────────────────────────────────────────

audit: audit-ts audit-evm audit-rust ## Run all security audit helpers

audit-ts: ## npm audit for TypeScript packages
	@echo "▶ audit-ts"
	npm audit

bytecode-check: ## Verify the EVM build matches contracts/evm/.pinned-bytecode/ (pass ARGS=--update to re-pin)
	@echo "▶ bytecode-check"
	@if command -v forge >/dev/null 2>&1; then \
		./scripts/check-pinned-bytecode.sh $(ARGS); \
	else \
		echo "⏭ skipping bytecode-check — forge not installed (install: https://getfoundry.sh)"; \
	fi

audit-rust: ## cargo-deny policy check for the Soroban workspace (advisories, licences, bans, sources)
	@echo "▶ audit-rust"
	@if command -v cargo-deny >/dev/null 2>&1; then \
		cargo deny --manifest-path contracts/soroban/Cargo.toml --config deny.toml check advisories licenses bans sources; \
	else \
		echo "⏭ skipping audit-rust — cargo-deny not installed (install: cargo install cargo-deny --locked)"; \
	fi

audit-evm: ## Slither + forge build for EVM (full static analysis pass)
	@echo "▶ audit-evm"
	@if command -v forge >/dev/null 2>&1; then \
		cd contracts/evm && forge build; \
	else \
		echo "⏭ skipping audit-evm build step — forge not installed (install: https://getfoundry.sh)"; \
	fi
	@if command -v slither >/dev/null 2>&1; then \
		cd contracts/evm && slither src/ --config-file slither.config.json; \
	else \
		echo "slither not found — install with: pip install slither-analyzer"; \
	fi

# ─────────────────────────────────────────────────────────────────────────────
# CLEAN
# ─────────────────────────────────────────────────────────────────────────────

clean: ## Remove all build artefacts (dist/, target/, forge cache)
	@echo "▶ clean"
	npm run clean
	@if command -v cargo >/dev/null 2>&1; then \
		cd contracts/soroban && cargo clean; \
	else \
		echo "⏭ skipping cargo clean — cargo not installed (install: https://rustup.rs)"; \
	fi
	@if command -v forge >/dev/null 2>&1; then \
		cd contracts/evm && forge clean; \
	else \
		echo "⏭ skipping forge clean — forge not installed (install: https://getfoundry.sh)"; \
	fi

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
	@if command -v forge >/dev/null 2>&1; then \
		cd contracts/evm && forge test --match-contract DifferentialFuzz -vv; \
	else \
		echo "⏭ skipping fuzz-evm — forge not installed (install: https://getfoundry.sh)"; \
	fi

fuzz-rust: ## Run Soroban/Rust differential fuzzing (100 proptest cases)
	@echo "▶ fuzz-rust"
	@if command -v cargo >/dev/null 2>&1; then \
		cd contracts/soroban/settlement && PROPTEST_CASES=100 cargo test fuzz -- --test-threads=1; \
	else \
		echo "⏭ skipping fuzz-rust — cargo not installed (install: https://rustup.rs)"; \
	fi

fuzz-cross: ## Run cross-language validation (Soroban corpus → Solidity decoder)
	@echo "▶ fuzz-cross"
	@if command -v forge >/dev/null 2>&1; then \
		cd contracts/evm && forge test --match-contract CrossValidate -vv; \
	else \
		echo "⏭ skipping fuzz-cross — forge not installed (install: https://getfoundry.sh)"; \
	fi

clean-corpus: ## Remove generated fuzz corpus files
	@echo "▶ clean-corpus"
	@rm -f contracts/shared/wire-vectors/fuzz-corpus/*.hex
	@rm -rf contracts/soroban/settlement/proptest-regressions/
	@echo "Corpus cleaned."

test-e2e: ## Run end-to-end integration tests
	@echo "▶ test-e2e"
	cd test && npm test

test-e2e-watch: ## Run end-to-end tests in watch mode
	@echo "▶ test-e2e-watch"
	cd test && npm run test:watch

# ─────────────────────────────────────────────────────────────────────────────
# DOCTOR
# ─────────────────────────────────────────────────────────────────────────────

doctor: ## Report installed toolchain versions vs their pinned versions
	@echo "════════════════════════════════════════════════════════════"
	@echo " Perihelion toolchain doctor"
	@echo "════════════════════════════════════════════════════════════"
	@echo ""
	@echo "Node.js ────────────────────────────────────────────────────"
	@if command -v node >/dev/null 2>&1; then \
		echo "  installed : $$(node --version)"; \
	else \
		echo "  installed : ✖ not found  (install: https://nodejs.org, or use nvm/fnm)"; \
	fi
	@if [ -f .nvmrc ]; then \
		echo "  pinned    : $$(cat .nvmrc)  (.nvmrc)"; \
	else \
		echo "  pinned    : — no .nvmrc found"; \
	fi
	@echo ""
	@echo "Rust / cargo ───────────────────────────────────────────────"
	@if command -v cargo >/dev/null 2>&1; then \
		echo "  installed : $$(cargo --version)"; \
	else \
		echo "  installed : ✖ not found  (install: https://rustup.rs)"; \
	fi
	@if [ -f rust-toolchain.toml ]; then \
		pinned=$$(grep -m1 '^channel' rust-toolchain.toml | sed -E 's/.*"([^"]*)".*/\1/'); \
		echo "  pinned    : $$pinned  (rust-toolchain.toml)"; \
		if command -v cargo >/dev/null 2>&1; then \
			installed_ver=$$(cargo --version | awk '{print $$2}'); \
			if [ "$$installed_ver" = "$$pinned" ]; then \
				echo "  status    : ✔ matches pin"; \
			else \
				echo "  status    : ⚠ mismatch — installed $$installed_ver, pinned $$pinned"; \
			fi; \
		fi; \
	else \
		echo "  pinned    : — no rust-toolchain.toml found"; \
	fi
	@echo ""
	@echo "Foundry / forge ────────────────────────────────────────────"
	@if command -v forge >/dev/null 2>&1; then \
		echo "  installed : $$(forge --version | head -1)"; \
	else \
		echo "  installed : ✖ not found  (install: https://getfoundry.sh)"; \
	fi
	@pinned_forge=$$(grep -h 'version:' .github/workflows/evm.yml 2>/dev/null | head -1 | sed -E 's/.*version:[[:space:]]*//'); \
	if [ -n "$$pinned_forge" ]; then \
		echo "  pinned    : $$pinned_forge  (.github/workflows/evm.yml)"; \
	else \
		echo "  pinned    : — no pin found (checked contracts/evm/foundry.toml and .github/workflows/evm.yml)"; \
	fi
	@echo ""
	@echo "════════════════════════════════════════════════════════════"

# ─────────────────────────────────────────────────────────────────────────────

.DEFAULT_GOAL := help

# ─────────────────────────────────────────────────────────────────────────────
# MUTATION TESTING
# ─────────────────────────────────────────────────────────────────────────────
# Configuration is committed (stryker*.config.mjs, .cargo-mutants.toml) and
# .github/workflows/mutation-testing.yml invokes the same commands, so local
# and nightly runs exercise identical settings. Both targets fail when the
# score drops below the recorded baseline. See docs/mutation-testing.md.

mutation: mutation-ts mutation-soroban ## Run all mutation testing (TypeScript + Soroban)

mutation-ts: ## Run Stryker on the SDK, relayer and solver (fails below thresholds.break)
	@echo "▶ mutation-ts"
	@status=0; \
	npx stryker run stryker.sdk.config.mjs || status=1; \
	npx stryker run stryker.services.config.mjs || status=1; \
	exit $$status

mutation-soroban: ## Run cargo-mutants on the settlement contract (fails below baseline)
	@echo "▶ mutation-soroban"
	@if command -v cargo-mutants >/dev/null 2>&1; then \
		cd contracts/soroban/settlement && cargo mutants --timeout 120 --output . ; \
		rc=$$?; if [ $$rc -ne 0 ] && [ $$rc -ne 2 ] && [ $$rc -ne 3 ]; then exit $$rc; fi; \
		cd - >/dev/null && node scripts/check-cargo-mutants-score.mjs contracts/soroban/settlement/mutants.out; \
	else \
		echo "⏭ skipping mutation-soroban — cargo-mutants not installed (cargo install cargo-mutants --locked)"; \
	fi
