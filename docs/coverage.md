# Coverage Reporting

Perihelion generates line/branch coverage for all three language ecosystems and
uploads them to [Codecov](https://codecov.io/gh/Perihelion-Protocol/Perihelion)
with per-package flags. This document explains how to produce and interpret
coverage reports locally, and how the CI pipeline surfaces them on PRs.

## Quick start — local coverage

### TypeScript (sdk, solver, relayer)

All three TypeScript packages use [c8](https://github.com/bcoe/c8) to collect
V8 native coverage and produce an lcov report alongside a text summary.

```bash
# Root — runs coverage for all workspaces and prints a combined text summary
npm run test:coverage

# Single package
npm run test:coverage --workspace=sdk
npm run test:coverage --workspace=solver
npm run test:coverage --workspace=relayer
```

Reports are written to `<package>/coverage/lcov.info`. To browse the HTML
report interactively:

```bash
# After running test:coverage for the sdk package:
cd sdk
npx c8 report --reporter=html --report-dir=coverage/html
open coverage/html/index.html   # macOS; use xdg-open on Linux
```

> **Node.js version note.** c8 wraps the built-in V8 coverage engine and
> requires Node.js ≥ 18. The project's minimum is ≥ 20 (see `.nvmrc`), so no
> extra setup is needed.

### Soroban (Rust)

The Soroban contract uses [cargo-llvm-cov](https://github.com/taiki-e/cargo-llvm-cov),
which instruments Rust code via LLVM source-based coverage. Install it once:

```bash
# Via cargo-binstall (fastest — downloads a pre-built binary):
cargo binstall cargo-llvm-cov

# Or build from source:
cargo install cargo-llvm-cov
```

Then generate coverage from within the Soroban workspace:

```bash
cd contracts/soroban

# Text summary printed to stdout
cargo llvm-cov

# lcov report (same format CI uploads to Codecov)
cargo llvm-cov --lcov --output-path lcov.info

# Self-contained HTML report opened in the default browser
cargo llvm-cov --open

# Exclude test/fuzz helpers (mirrors CI exclusion)
cargo llvm-cov --lcov --output-path lcov.info \
  --ignore-filename-regex '(fuzz|test)\.rs$'
```

The HTML report lands in `contracts/soroban/target/llvm-cov/html/`.

### EVM (Solidity / Foundry)

Foundry has built-in coverage via `forge coverage`, which uses the Solidity
compiler's source-map output:

```bash
cd contracts/evm

# Text summary (per-file line/branch/function counts)
forge coverage

# lcov report written to lcov.info (same format CI uploads to Codecov)
forge coverage --report lcov --lcov-version 1

# Per-function detail
forge coverage --report debug

# Generate a browsable HTML report from the lcov file (requires lcov tools)
genhtml lcov.info --output-directory coverage-html
open coverage-html/index.html
```

> **Note.** `forge coverage` instruments contract bytecode rather than tracing
> LLVM IR, so branch coverage numbers may differ from Solidity's optimizer view.
> Line coverage is reliable; branch coverage is a best-effort approximation.
> For a higher-fidelity branch signal, consult the Slither static analysis job.

---

## CI and Codecov integration

The `.github/workflows/coverage.yml` workflow runs on every push to `main` and
on every PR. It:

1. Runs each toolchain's coverage in parallel (three separate jobs):
   - `ts-coverage (sdk)`, `ts-coverage (solver)`, `ts-coverage (relayer)` —
     using `c8` + Node.js built-in test runner.
   - `soroban-coverage` — using `cargo-llvm-cov`.
   - `evm-coverage` — using `forge coverage`.
2. Uploads each lcov report to Codecov with a dedicated per-package flag:

   | Flag | Package | Path |
   | ---- | ------- | ---- |
   | `ts-sdk` | `@perihelion/sdk` | `sdk/` |
   | `ts-solver` | `@perihelion/solver` | `solver/` |
   | `ts-relayer` | `@perihelion/relayer` | `relayer/` |
   | `soroban` | Soroban settlement contract | `contracts/soroban/` |
   | `evm` | EVM escrow + timelock | `contracts/evm/` |

3. Posts a PR comment showing:
   - **Reach** — overall coverage percentage after the PR.
   - **Diff** — coverage of lines added/changed in the PR (patch coverage).
   - **Flags** — per-package breakdown.
   - **Tree** — file-level coverage heatmap.

### Required secret

Upload requires a `CODECOV_TOKEN` repository secret (Settings → Secrets and
variables → Actions → New repository secret). Obtain the token from
[codecov.io](https://codecov.io) after linking the repository. Without a token,
CI logs a warning but does not fail — coverage is a signal, not a hard gate on
the upload service.

---

## Thresholds and ratcheting

Thresholds are configured in `.codecov.yml`:

| Scope | Target | Threshold | Behaviour |
| ----- | ------ | --------- | --------- |
| **Project** | `auto` (ratchet) | 1% | Coverage can never drop below the current main-branch baseline. Any PR that lowers total coverage by more than 1% fails the `codecov/project` status check. |
| **Patch** | 70% | 5% | New lines introduced on a PR must be ≥ 70% covered. A PR that adds code without tests fails the `codecov/patch` check. |

### Raising a threshold

To lock in a higher floor as coverage improves:

1. Check the current coverage in the Codecov dashboard.
2. Edit `.codecov.yml` and change `target: auto` to a specific percentage (e.g.
   `target: 80%`) under `coverage.status.project.default`.
3. Commit the change on a branch and open a PR. If CI passes with the new floor,
   merge it. The next PR that drops below the floor will fail automatically.

### Per-package thresholds

Per-package thresholds can be added under `coverage.status.project` using the
flag name:

```yaml
coverage:
  status:
    project:
      ts-sdk:
        target: 85%
        flags:
          - ts-sdk
      soroban:
        target: 90%
        flags:
          - soroban
```

---

## Interpreting coverage in a security context

High line coverage is necessary but not sufficient for a bridge protocol.
Pay attention to:

- **Branch coverage on fund-moving paths.** The EVM `lock`, `lzReceive`
  (`_onFillConfirmed` / `_onCancelIntent`), and `cancelExpired` functions have
  multiple branches that guard against reentrancy, stale nonces, and double
  settlement. Every branch must be exercised in tests.
- **Soroban terminal-state transitions.** The `Locked → Filled → ConfirmationSent`
  and `Locked → Cancelled` paths both need explicit test coverage; missing a
  terminal branch means a real user could be left in a stuck state on mainnet.
- **Wire codec round-trips.** The differential fuzzing suite (see
  [`docs/differential-fuzzing.md`](./differential-fuzzing.md)) is the primary
  guard for the `messages.rs` codec, but lcov should show 100% line coverage on
  the encode/decode paths even in unit tests.

Coverage numbers from CI are a floor, not a ceiling. Use the per-file tree view
in the Codecov UI to identify uncovered blocks and file targeted issues.
