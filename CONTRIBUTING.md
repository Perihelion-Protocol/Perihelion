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

```bash
# TypeScript workspaces (sdk, solver, relayer)
npm install
npm run build
npm test

# Soroban contracts
( cd contracts/soroban && cargo test )

# EVM contracts
( cd contracts/evm && forge install foundry-rs/forge-std && forge test )
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
