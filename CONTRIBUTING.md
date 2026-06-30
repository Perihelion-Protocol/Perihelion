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

If you are unsure whether your change touches a security-sensitive path, err on
the side of requesting a security reviewer in your PR.

Thank you for helping build the shortest path between Stellar and every other
chain. 🌌
