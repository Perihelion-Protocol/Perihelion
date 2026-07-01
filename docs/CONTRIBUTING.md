# Contributing to Perihelion

Perihelion is built in public and designed to be **Wave-native** — the codebase
is organized around clear, scopeable issues that contributors at every level can
meaningfully tackle.

## Where the work lives

| Track                     | Components               | Example work                                       |
| ------------------------- | ------------------------ | -------------------------------------------------- |
| Soroban contract dev      | `contracts/soroban/`     | Settlement logic, SEP-40 oracle, security invariants |
| EVM contract dev          | `contracts/evm/`         | Escrow flows, LayerZero OApp wiring, gas review    |
| TypeScript dev            | `sdk/`, `solver/`, `relayer/` | SDK ergonomics, solver routing, relayer reliability |
| Protocol research         | `docs/`                  | Intent format, solver incentives, fee models       |
| Documentation             | `docs/`, package READMEs | Integration guides, architecture explainers        |

## Development setup

```bash
# TypeScript workspaces (sdk, solver, relayer)
npm install
npm run build
npm test

# Soroban contracts
cd contracts/soroban && cargo test

# EVM contracts
cd contracts/evm && forge install foundry-rs/forge-std && forge test
```

## Pre-commit hooks (optional but recommended)

This repo uses [Lefthook](https://github.com/evilmartians/lefthook) to run CI-equivalent
format and lint checks locally before you push. Install with:

```bash
npx lefthook install
```

After install, every `git commit` runs:

- `cargo fmt` and `cargo clippy` on staged Rust changes
- `forge fmt` on staged Solidity changes
- `tsc --noEmit` on staged TypeScript changes
- Guards that reject `node_modules/`, `dist/`, build artifacts, `dbg!()`, and `console.log()`

Bypass with `git commit --no-verify` or `SKIP=<hook-name> git commit`.

## Conventions

- **Keep the intent hash consistent.** Any change to the EIP-712 domain or type
  must land in both `sdk/src/intent.ts` and
  `contracts/evm/src/PerihelionEscrow.sol`, with `docs/intent-spec.md` updated.
- **Match surrounding style.** Each package follows its own idioms; read the
  neighbours before adding code.
- **Tests with behavior changes.** Contracts and TS packages each ship a test
  suite — extend it alongside your change.

## Submitting

1. Open or claim an issue describing the scope.
2. Branch, implement, and add tests.
3. Ensure `npm test`, `cargo test`, and `forge test` pass for affected areas.
4. Open a PR referencing the issue.

Architecture discussions and first-time contributions are equally welcome — see
[architecture.md](./architecture.md) to get oriented.
