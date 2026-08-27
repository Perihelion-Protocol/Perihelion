# Contributing to Perihelion

Thanks for your interest in contributing! Perihelion is built in public and
designed to be **Wave-native** — the codebase is organized around clear,
scopeable issues that contributors at every level can meaningfully tackle.

This file is the quick-start. The full contributor playbook — issue taxonomy by
skill and Wave cycle, PR review process, and the path from first-time
contributor to maintainer — lives in
[`docs/CONTRIBUTING.md`](./docs/CONTRIBUTING.md) and
[the architecture spec, §9](./docs/TECHNICAL-ARCHITECTURE.md#9-contribution-guide-for-drips-wave).

## Code of Conduct

By participating, you agree to abide by our
[Code of Conduct](./CODE_OF_CONDUCT.md).

## Ways to contribute

| Track            | Components                       | Example work                                       |
| ---------------- | -------------------------------- | -------------------------------------------------- |
| Rust / Soroban   | `contracts/soroban/`             | Settlement logic, oracle integration, invariants   |
| Solidity         | `contracts/evm/`                 | Escrow flows, LayerZero wiring, gas review         |
| TypeScript       | `sdk/`, `solver/`, `relayer/`    | SDK ergonomics, solver routing, relayer reliability |
| Documentation    | `docs/`, package READMEs         | Integration guides, architecture explainers        |

## Development setup

You only need the toolchain(s) for the stack you're actually touching — see the
root [`Makefile`](./Makefile) preamble. Run `make doctor` at any time to check
which toolchains are installed and whether their versions match what's pinned
(`.nvmrc`, `rust-toolchain.toml`, and the Foundry version pinned in
`.github/workflows/evm.yml`):

```bash
make doctor
```

```bash
# TypeScript workspaces (sdk, solver, relayer)
npm install
make build-ts
make test-ts

# Soroban contracts
make build-soroban
make test-soroban

# EVM contracts
( cd contracts/evm && forge install foundry-rs/forge-std )
make build-evm
make test-evm
```

`make build` / `make test` run all three stacks but **gracefully skip** any
stack whose toolchain isn't installed locally (printing a `⏭ skipping ...`
notice) — a contributor without Rust or Foundry installed can still run
`make build`/`make test` and get useful results for the stack(s) they have.
CI instead uses `make build-ts`/`make test-soroban`/etc. directly inside each
stack's dedicated job (where that job's toolchain is guaranteed to be
installed), or `make build-all-strict` / `make test-all-strict`, which
require **all three** toolchains and fail fast with a clear error if any are
missing — use these if you want a genuinely all-stacks build/test that never
silently skips anything.

### Supported toolchain versions

Every CI job builds with these exact versions and asserts it before doing any
work (`scripts/check-toolchain.sh`). Use the same ones locally, or expect
results that differ from CI for reasons unrelated to your change.

| Toolchain | Version                                            | Pinned in                                        |
| --------- | -------------------------------------------------- | ------------------------------------------------ |
| Rust      | `1.85.0` (target `wasm32-unknown-unknown`)         | [rust-toolchain.toml](./rust-toolchain.toml)      |
| Foundry   | `stable`                                           | `FOUNDRY_VERSION` in each Foundry workflow        |
| Node.js   | see [.nvmrc](./.nvmrc)                             | [.nvmrc](./.nvmrc)                                |

Each version has exactly one source of truth. Rust jobs read the channel out of
`rust-toolchain.toml` instead of repeating it, so bumping that file bumps CI.
Bumping Foundry means changing `FOUNDRY_VERSION` in the workflows that set it
(`evm.yml`, `coverage.yml`, `differential-fuzz.yml`, `mutation-testing.yml`) and
this table.

**Foundry version pinning policy:** The nightly version is pinned to ensure all
CI jobs use the same toolchain, so coverage, mutation testing, and bytecode
builds are reproducible and not affected by toolchain regressions. To advance
the version, pick a newer nightly from [foundry releases](https://github.com/foundry-rs/foundry/releases),
update the `FOUNDRY_VERSION` env var in all four workflow files, verify
locally that the build still passes, and include the pinned SHA in your PR
description so reviewers can track the justification for the bump.

Verify locally with:

```bash
./scripts/check-toolchain.sh all
```

## Pre-commit hooks (optional but recommended)

Perihelion uses [Lefthook](https://github.com/evilmartians/lefthook) to run the same
format and lint checks that CI enforces — but locally, before you push.

```bash
# Install hooks (one-time)
npx lefthook install
```

After installation, every `git commit` automatically:

| Check | What it does |
|---|---|
| `cargo fmt` | Formats staged Rust files (`contracts/soroban/`) |
| `cargo clippy` | Lints staged Rust files (`-D warnings`) |
| `forge fmt` | Formats staged Solidity files (`contracts/evm/`) |
| `tsc --noEmit` | Type-checks staged TypeScript files |
| Build artifact guard | Rejects commits containing `node_modules/`, `dist/`, `target/`, `out/` |
| Debug logging guard | Rejects commits containing `dbg!()` or `console.log()` |

Pass `--no-verify` or set the `SKIP` env var to bypass selectively:

```bash
git commit --no-verify -m "wip"
SKIP=cargo-clippy git commit -m "wip"
SKIP=cargo-clippy,forge-fmt git commit -m "wip"
```

## Workflow

1. **Find or open an issue.** Comment to claim it so we avoid duplicate work.
2. **Branch** from `main` using a descriptive name, e.g.
   `feat/soroban-fill-intent` or `fix/escrow-refund-race`.
3. **Implement with tests.** Every behavior change ships with tests in the
   relevant suite (`node:test`, `cargo test`, or Foundry).
4. **Keep docs in sync.** If you change an interface or on-chain format, update
   the spec in the same PR.
5. **Open a PR** referencing the issue and filling out the PR template.

## Commit & PR conventions

- Write clear, imperative commit subjects (`Add cancel_expired_intent`, not
  `added stuff`). [Conventional Commits](https://www.conventionalcommits.org)
  prefixes (`feat:`, `fix:`, `docs:`, `chore:`, `test:`, `ci:`, `refactor:`,
  `style:`, `perf:`) are **required** and enforced by CI. Allowed scopes:

  | Scope      | Applies to                                    |
  |------------|-----------------------------------------------|
  | `evm`      | `contracts/evm/` (Solidity)                   |
  | `soroban`  | `contracts/soroban/` (Rust)                   |
  | `sdk`      | `sdk/`                                         |
  | `relayer`  | `relayer/`                                     |
  | `solver`   | `solver/`                                      |
  | `mempool`  | `mempool/`                                     |
  | `docs`     | `docs/` and package READMEs                   |
  | `ci`       | `.github/workflows/` and CI config            |

  Examples: `feat(evm): add measured-delta accounting`, `ci: add concurrency
  groups`, `docs(sdk): fix typos in JSDoc`.

- Keep PRs focused — one logical change per PR is easier to review and merge.
- PR titles must also follow conventional commits (also enforced by CI).
- Ensure CI is green: `npm test`, `cargo test`, `forge test`, and lints.
- **Invariants first.** Reviewers check every contract PR against the protocol's
  [design invariants](./docs/TECHNICAL-ARCHITECTURE.md#0-design-invariants-read-first);
  a change that could violate I1–I5 is blocked regardless of test status.

## Release process

- **Every PR that changes behavior updates [CHANGELOG.md](./CHANGELOG.md).**
  Add an entry under the `## [Unreleased]` heading, in the `Added` /
  `Changed` / `Fixed` / `Security` section that matches the change (create
  the section if it's the first entry of that kind since the last release).
  A one-line, user-facing summary is enough — link the issue/PR number if
  one exists.
- The `Changelog Check` CI job (`.github/workflows/changelog-check.yml`)
  enforces this: a PR whose title has a `feat:` or `fix:` conventional-commit
  prefix must touch `CHANGELOG.md`, or carry the `no-changelog` label if the
  change has no user-visible effect (a pure refactor, internal tooling, a
  test-only change). Apply the label yourself if you have permission, or ask
  a maintainer to apply it during review.
- **Cutting a release:**
  1. Rename `## [Unreleased]` to `## [x.y.z] - YYYY-MM-DD` (semantic
     versioning: patch for fixes only, minor for new backward-compatible
     functionality, major for breaking changes) and start a fresh empty
     `## [Unreleased]` above it.
  2. Bump the `version` field in every workspace `package.json` (root,
     `sdk/`, `relayer/`, `solver/`, `mempool/`, `test/`) and in
     `contracts/soroban/Cargo.toml`'s `[workspace.package]` to the same
     `x.y.z`, then run `npm install` and `cargo update -p perihelion-settlement
     --precise x.y.z` so the lockfiles stay consistent.
  3. Open a PR with just the version bump and changelog rename; once merged,
     tag the resulting commit `vx.y.z` and push the tag.
  - This monorepo does not yet use per-package independent versioning or
    changeset/release-please automation — all packages move together until
    a package reaches 1.0 and needs its own release cadence.

### Keeping the Implementation Status table honest

The README's [Implementation Status](./README.md#implementation-status) table is
what a reader (and a security reviewer) uses to decide what is real. A PR that
changes whether a component is a stub, partially implemented, or complete must
update the corresponding row in the same PR.

Two rules the table has to keep:

- Every row describes the code at `HEAD`, in both directions. Overstating a stub
  misleads users; understating a real implementation means reviewers skip code
  that is live.
- Rows link only to **open** issues. If a closed issue is still the best
  reference, annotate it: `#5 (closed, superseded by #328)`. The
  `status-table-links` job in `.github/workflows/docs.yml` fails on an
  unannotated closed link.

Check it locally with:

```bash
node scripts/check-status-links.mjs
```

## Definition of Done

An issue is closed when the behaviour it describes is in the code and enforced,
not when an artefact related to it exists. A config file, a snapshot, or a
baseline JSON that no job reads is worse than nothing: it reads as a guarantee
and provides none.

Before closing an issue, all three must hold:

1. **Implemented.** The described behaviour is in the code at `HEAD`, not in a
   placeholder, a `TODO`, or a method that throws `not implemented`.
2. **Asserted.** A test fails if the behaviour regresses.
3. **Gating, for CI and tooling issues.** The check fails on a deliberately
   broken input, and that negative case runs in CI. Adding a config file or a
   baseline is not enough; a job has to read it and fail.

The closing PR states which of the three it satisfies, and closes the issue with
`Closes #N` in its description rather than the issue being closed by hand. That
keeps a diff attached to every closure, so a later reader can check the claim
instead of trusting it.

### Negative tests for CI gates

Every gating check gets a companion case proving it gates, checked in next to
the check itself:

| Gate | Proof it gates |
| ---- | -------------- |
| `scripts/check-status-links.mjs` | `.github/fixtures/status-table-closed-issue.md` links a closed issue; the `status-table-links` job asserts the checker exits non-zero on it. |
| `scripts/check-toolchain.sh` | Fails when `rustc` or `forge` is not the pinned version; every Rust and Foundry job runs it before building. |

When you add a gate, add its negative case in the same PR. A gate that has never
been observed to fail is an assumption, not a guarantee.

### Tracking gaps that are already in the code

`.github/workflows/stub-audit.yml` runs weekly and lists every `TODO`,
`Placeholder`, `not implemented`, and `stub` marker under the source directories
in its job summary. Treat that list as the authoritative gap list: it is derived
from the code, so closing an issue cannot hide an entry. Run the same scan
locally with:

```bash
grep -rInE 'TODO|FIXME|[Pp]laceholder|[Nn]ot implemented|\bstubs?\b' sdk/src solver/src relayer/src mempool/src
```

## Merge criteria

- All CI checks pass.
- Required approvals (≥1 for small docs/config; ≥2 for contract logic, one from
  the relevant chain track).
- No unresolved review threads.
- For `contracts/` changes: a note on resource/fee impact and whether an audit
  gate applies before mainnet.

## Branch protection on `main`

`main` is protected by three required status checks. These must be configured in
**Settings → Branches → Branch protection rules** (or Rulesets) for `main`:

| Required check name | Source workflow | Blocks merge when… |
|---|---|---|
| `Required check` (CI / `ci.yml`) | `.github/workflows/ci.yml` | `npm run build` or `npm test` fails |
| `Required check` (EVM / `evm.yml`) | `.github/workflows/evm.yml` | `forge build`, `forge test`, Slither, or NatSpec check fails |
| `Required check` (Soroban / `soroban.yml`) | `.github/workflows/soroban.yml` | `cargo build`, `cargo test`, or `cargo clippy` fails |

Additional required settings:

- **Require branches to be up to date before merging** — enabled, so a stale
  branch cannot bypass a check that passed on an older base commit.
- **Do not allow bypassing the above settings** — admin bypass **must be
  disabled**. An admin merge that skips required checks is how the refund-helper
  regression reached `main`.
- **Require review from Code Owners** — enabled for the security-sensitive paths
  listed in the Security review policy below.

> How the gate works: each workflow contains a terminal `check` job
> (`needs: [<real-jobs>]`, `if: always()`) that asserts every upstream job
> either passed or was skipped. Branch protection requires only those `check`
> jobs, not the individual matrix jobs. This means a docs-only PR gets a green
> gate without running the full build suite, while any build/test failure blocks
> the merge.

## Reporting bugs & security issues

- **Non-security bugs:** open an issue using the Bug Report template.
- **Security vulnerabilities:** do **not** open a public issue — follow
  [`SECURITY.md`](./SECURITY.md).

## Security review policy

Changes to the following paths carry heightened risk and require at least one
approval from **`@Perihelion-Protocol/security-reviewers`** in addition to the
normal package-owner review. This is enforced via CODEOWNERS and branch
protection (`Require review from Code Owners` must be enabled in Settings →
Branches → Protection rules for `main`).

| Path | Why it is sensitive |
| ---- | ------------------- |
| `contracts/soroban/settlement/src/messages.rs` | Cross-chain wire codec — must stay byte-identical to the EVM side (Invariant I5). |
| `contracts/soroban/settlement/src/lib.rs` | Core fund-movement logic: `fill_intent`, `cancel_expired_intent`, `lz_receive`, nonce/replay guard. |
| `contracts/soroban/settlement/src/types.rs` | `IntentStatus` enum and `DataKey` variants — shared taxonomy with EVM. |
| `contracts/evm/src/PerihelionEscrow.sol` | EVM fund-moving paths: `lock`, `lzReceive`, `cancelExpired`, EIP-712 hash, reentrancy guard. |
| `contracts/evm/src/PerihelionTimelock.sol` | Admin timelock — governs all privileged upgrades and config changes. |
| `contracts/shared/` | Shared wire-format test vectors used by differential fuzzing. |
| `sdk/src/intent.ts` | `hashIntent` / `INTENT_TYPEHASH` — must be byte-identical to EVM (Invariant I5). |
| `sdk/src/types.ts` | `IntentStatus` lifecycle vocabulary. |
| `sdk/src/validate.ts` | Pre-signature intent validation (`minDestAmount`, `deadline`, destination shape) — the last check before a user signs. |
| `.github/workflows/` | A weakened or bypassed required check has the same blast radius as a contract bug — see the admin-bypass note above. |

If you are unsure whether your change touches a security-sensitive path, err on
the side of requesting a security reviewer in your PR.

Each fund-moving PR should also answer, in its description: **does this change
fund movement, authorisation, the wire format, or a CI gate? If yes, which
invariant in [`docs/formal-specification.md`](./docs/formal-specification.md)
does it touch, and which test asserts it?** The PR template prompts for this
directly.

Thank you for helping build the shortest path between Stellar and every other
chain. 🌌

## NatSpec Policy

All `public` and `external` functions, events, and errors in the EVM contracts
(`PerihelionEscrow`, `PerihelionTimelock`, and any interfaces) **must** carry
complete NatSpec:

- `@notice` — a one-sentence description of what the function does.
- `@param <name>` — for every parameter.
- `@return` — for every return value (named or positional).

CI enforces this via the `natspec` job in `.github/workflows/evm.yml`, which
runs `forge build` and fails on any NatSpec warnings. A PR introducing a
`public`/`external` function without complete NatSpec will fail CI.

To check locally:

```bash
cd contracts/evm
forge build 2>&1 | grep -E 'Warning.*@(param|return|notice)'
# Generate browseable docs:
forge doc --out /tmp/natspec-out
```

Generated documentation is uploaded as the `natspec-docs` artifact on every CI run.

## License headers

All Solidity contracts (`contracts/evm/**/*.sol`) start with
`// SPDX-License-Identifier: MIT` as their first line. The same convention
applies to every other source file in the repo:

- **TypeScript** — every `.ts` file under `sdk/`, `relayer/`, `solver/`,
  `mempool/` (both `src/` and `test/`), and the root `test/` e2e suite must
  start with:

  ```ts
  // SPDX-License-Identifier: MIT
  ```

  If the file has a shebang (`#!/usr/bin/env node`), the SPDX line goes
  immediately after it, followed by a blank line before the rest of the file.
  Otherwise it is line 1, followed by a blank line (even before a leading
  JSDoc block or `import`).

- **Rust** — every `.rs` file under `contracts/soroban/**/src` must start
  with the same `// SPDX-License-Identifier: MIT` line, above `#![no_std]`,
  `#![cfg(test)]`, or any other content.

New source files must include the header. CI enforces this on every PR via
`scripts/check-spdx-headers.sh` (wired into the `typescript` job in
`ci.yml` and the `soroban` job in `soroban.yml`), which checks every file
tracked by git and fails the build if any TypeScript or Rust source file is
missing the header. Run it locally with:

```bash
./scripts/check-spdx-headers.sh
```

## Checking docs locally

Two lightweight CI checks run on every PR that touches docs or templates:

**YAML template validation** (requires Python + pyyaml):

```bash
pip install pyyaml
python3 -c "
import yaml, sys
from pathlib import Path
for p in Path('.github/ISSUE_TEMPLATE').glob('*.yml'):
    yaml.safe_load(p.read_text())
    print(f'OK: {p}')
"
```

**Markdown link check** (requires Node.js):

```bash
npm install -g markdown-link-check@3
find . -name '*.md' -not -path './node_modules/*' -not -path './.git/*' | \
  xargs -I{} markdown-link-check {} --config .mlc-config.json
```

Create `.mlc-config.json` at the repo root (or use the one generated by CI):

```json
{
  "ignorePatterns": [
    { "pattern": "^https?://" },
    { "pattern": "^mailto:" }
  ]
}
```
