<div align="center">

# 🌌 Perihelion Protocol

**The shortest path between Stellar and every other chain.**

An open-source, intent-based cross-chain bridge connecting Stellar to
EVM-compatible networks — Ethereum, Base, Arbitrum, and beyond.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![CI](https://github.com/Perihelion-Protocol/Perihelion/actions/workflows/ci.yml/badge.svg)](https://github.com/Perihelion-Protocol/Perihelion/actions/workflows/ci.yml)
[![Status: Early Development](https://img.shields.io/badge/status-early%20development-orange.svg)](#project-status)
[![Soroban](https://img.shields.io/badge/Stellar-Soroban-black.svg)](https://soroban.stellar.org)
[![Solidity](https://img.shields.io/badge/EVM-Solidity-363636.svg)](https://soliditylang.org)
[![TypeScript](https://img.shields.io/badge/SDK-TypeScript-3178c6.svg)](https://www.typescriptlang.org)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](./CONTRIBUTING.md)
[![Code of Conduct](https://img.shields.io/badge/code%20of-conduct-ff69b4.svg)](./CODE_OF_CONDUCT.md)

[Overview](#overview) ·
[Why Perihelion](#why-perihelion) ·
[How It Works](#how-it-works) ·
[Architecture](#architecture) ·
[Getting Started](#getting-started) ·
[Documentation](#documentation) ·
[Contributing](#contributing) ·
[FAQ](./docs/faq.md)

</div>

---

## Table of Contents

- [Overview](#overview)
- [Why Perihelion](#why-perihelion)
  - [The problem](#the-problem)
  - [The solution](#the-solution)
- [Features](#features)
- [How It Works](#how-it-works)
- [Architecture](#architecture)
  - [Settlement flow](#settlement-flow)
  - [The intent hash](#the-intent-hash)
- [Repository Layout](#repository-layout)
- [Tech Stack](#tech-stack)
- [Getting Started](#getting-started)
  - [Prerequisites](#prerequisites)
  - [Install & build](#install--build)
  - [Run the test suites](#run-the-test-suites)
  - [Use the SDK](#use-the-sdk)
- [How Perihelion Compares](#how-perihelion-compares)
- [Documentation](#documentation)
- [Roadmap](#roadmap)
- [Project Status](#project-status)
- [Contributing](#contributing)
- [Trust Assumptions](#trust-assumptions)
- [Security](#security)
- [Community & Support](#community--support)
- [License](#license)
- [Acknowledgements](#acknowledgements)

---

## Overview

Perihelion lets a user declare a simple **intent** — _"I want X amount of asset Y
on Stellar"_ — and a decentralized network of **solvers** competes to fulfill it,
atomically and at the best available rate. No manual bridging steps, no token
wrapping, no fragile multi-transaction dance.

It is built natively on [Soroban](https://soroban.stellar.org), Stellar's smart
contract platform, and is designed for the way Stellar actually works: fast
finality, low fees, and a growing ecosystem of real-world assets that need
seamless liquidity connections to the rest of the blockchain world.

The model is proven on Ethereum — it is the same architecture behind
[UniswapX](https://uniswap.org) and [CoW Protocol](https://cow.fi) — but it has
been largely absent from Stellar. Perihelion brings it to Soroban and uses it to
solve Stellar's single most important growth bottleneck: **inbound liquidity.**

## Why Perihelion

### The problem

Stellar has become critical financial infrastructure — over **\$2B in tokenized
real-world assets**, institutional-grade stablecoins (USDC, EURC, YLDS, MGUSD),
and payment rails used by MoneyGram, Franklin Templeton, and PayPal.

But moving assets _onto_ Stellar from Ethereum, Base, or any other major chain
still requires one of:

- **Centralized exchanges** — custodial, KYC-gated, slow withdrawals.
- **Manual DEX hops** — multiple transactions, MEV exposure, poor rates.
- **Lock-and-mint bridges** — custodial wrapper assets and a long history of
  catastrophic exploits.

Capital that should be flowing into Stellar's DeFi, lending markets, and RWA
platforms sits on other chains because the on-ramp is too hard.

### The solution

Perihelion replaces all of that with a single signed message. The user never
touches a wrapper asset, never executes a multi-step bridge, and never takes
custodial risk. Either they receive at least the amount they asked for on
Stellar, or they are refunded in full on the source chain. There is no state in
which a user loses funds mid-bridge.

## Features

- 🎯 **Intent-based UX** — users sign _what they want_, not _how to get it_.
- ⚡ **Atomic settlement** — fill both legs or refund; no partial states.
- 🤝 **Solver competition** — an open network races to give users the best rate,
  instead of a single privileged operator.
- 🔓 **Permissionless** — anyone can run a solver, a relayer, or a keeper. No
  allowlist gates liveness, and the refund path needs no privileged actor.
- 🛰️ **LayerZero-secured messaging** — verified cross-chain delivery with a
  multi-DVN trust model, plus a roadmap to ZK state proofs (Protocol 24).
- 🪙 **Canonical assets** — users receive real Stellar assets sourced from solver
  liquidity, never a synthetic wrapper.
- 🧱 **Built for contributors** — a clean monorepo with scoped, skill-tagged
  issues for [Drips Wave](https://communityfund.stellar.org) sprint cycles.

## How It Works

Perihelion uses an **intent + solver** architecture:

1. **The user declares an intent.** They sign a structured message off-chain
   specifying the asset and amount to receive on Stellar, the asset and chain to
   spend from, a deadline, and a slippage floor. No transaction, no gas yet.
2. **Solvers compete to fill it.** A decentralized network of solvers monitors
   the intent mempool and races to fill profitable orders. The winner earns the
   spread between what the user offered and what the solver sourced.
3. **Atomic settlement.** The user's funds are locked in the source-chain escrow
   against a cryptographic commitment; the solver fronts liquidity on Stellar;
   the escrow releases the locked funds to the solver once settlement is verified
   over LayerZero. If the deadline passes without a fill, the user is refunded.
4. **Trust-minimized messaging.** Cross-chain messages are carried by
   [LayerZero](https://layerzero.network) with an independent multi-DVN verifier
   set, and — on the roadmap — Stellar's native ZK proof support (Protocol 24)
   for the most sensitive path.

## Architecture

### Settlement flow

```
User Intent (signed off-chain)
        │
        ▼
Intent Mempool (open, permissionless)
        │
        ├──► Solver A evaluates
        ├──► Solver B evaluates
        └──► Solver C evaluates
                    │
                    ▼
        Winning Solver executes
                    │
         ┌──────────┴──────────┐
         ▼                     ▼
Source Chain Escrow     Soroban Settlement
(EVM Contract)          Contract (Stellar)
         │                     │
         └──── LayerZero ──────┘
              Message Relay
                    │
                    ▼
         User receives assets
         on Stellar ✓
```

### The intent hash

A single value — the EIP-712 `intent_hash` — ties every leg together. It is:

- the commitment the EVM escrow locks the user's funds against,
- the identifier carried in every LayerZero message,
- and the key the Soroban settlement contract uses for replay protection.

The hash is computed identically by the SDK (`hashIntent`) and the EVM escrow
(`hashIntent`), so every component keys off one stable identifier. The full
design — storage layout, state machine, message formats, threat model, and
phased rollout — is in the
**[Technical Architecture Specification](./docs/TECHNICAL-ARCHITECTURE.md)**.

## Repository Layout

| Path         | Description                                                         |
| ------------ | ------------------------------------------------------------------- |
| `contracts/` | Soroban (Rust) settlement contract + EVM (Solidity) escrow contract |
| `sdk/`       | TypeScript SDK for intent construction, signing, and submission     |
| `solver/`    | Reference solver node — monitors the mempool and fills intents      |
| `relayer/`   | LayerZero message relayer for the Stellar ↔ EVM path                |
| `docs/`      | Protocol specifications and integration guides                      |

This is an [npm workspaces](https://docs.npmjs.com/cli/using-npm/workspaces)
monorepo for the TypeScript packages (`sdk`, `solver`, `relayer`), a Cargo
workspace for the Soroban contracts, and a Foundry project for the EVM contracts.

## Tech Stack

| Layer                   | Technology                    |
| ----------------------- | ----------------------------- |
| Stellar smart contracts | Rust / Soroban (SDK 22)       |
| EVM contracts           | Solidity 0.8.24 / Foundry     |
| Cross-chain messaging   | LayerZero V2                  |
| ZK verification         | BN254 / Stellar Protocol 24   |
| Oracle pricing          | SEP-40 / RedStone             |
| Solver, SDK, relayer    | TypeScript / Node.js ≥ 20     |
| Intent standard         | EIP-712 style signed messages |

## Getting Started

> **New here?** Jump straight to the **[Integration Quickstart](./docs/quickstart.md)**
> for a copy-pasteable, end-to-end walkthrough: install → build intent → sign →
> submit → track settlement against a local mock mempool.

### Prerequisites

| Tool                                                                 | Used for             | Required version |
| -------------------------------------------------------------------- | -------------------- | ---------------- |
| [Node.js](https://nodejs.org)                                        | SDK, solver, relayer | ≥ 20             |
| [Rust](https://rustup.rs) + `wasm32-unknown-unknown` target          | Soroban contracts    | stable           |
| [Stellar CLI](https://developers.stellar.org/docs/tools/stellar-cli) | Soroban build/deploy | latest           |
| [Foundry](https://book.getfoundry.sh)                                | EVM contracts        | latest           |

> The TypeScript packages build and test with only Node.js installed; the Rust
> and Foundry toolchains are needed solely for the contracts.

### Install & build

```bash
# Clone
git clone https://github.com/Perihelion-Protocol/Perihelion.git
cd Perihelion

# 1. TypeScript workspaces (sdk, solver, relayer)
npm install
npm run build

# 2. Soroban settlement contract
cd contracts/soroban
cargo build --target wasm32-unknown-unknown --release
cd ../..

# 3. EVM escrow contract
cd contracts/evm
forge install foundry-rs/forge-std   # one-time
forge build
cd ../..
```

### Run the test suites

```bash
npm test                               # all TypeScript packages
( cd contracts/soroban && cargo test ) # Soroban unit tests
( cd contracts/evm && forge test )     # EVM unit tests

# Differential fuzzing for wire format codecs
make fuzz-bounded                      # 100 cases (~30s)
make fuzz-extended                     # 10k cases (~5min)
```

### Use the SDK

```ts
import { PerihelionClient, buildIntent } from "@perihelion/sdk";

const client = new PerihelionClient({ mempoolUrl: "https://mempool.perihelion.xyz" });

const intent = buildIntent({
  user: account.address,
  destination: "GUSER...STELLAR",
  sourceChainId: 8453,            // Base
  sourceAsset: "0x833589...",     // USDC on Base
  sourceAmount: "1000000",        // 1 USDC (6 decimals)
  destAsset: "USDC:GA5Z...",      // USDC on Stellar
  minDestAmount: "9900000",       // accept >= 0.99 (7 decimals)
  deadline: Math.floor(Date.now() / 1000) + 600,
});

const signed = await client.signIntent(wallet, intent); // viem WalletClient
const hash = await client.submitIntent(signed);
const result = await client.waitForSettlement(hash);
console.log(result.status); // "settled"
```

See the [`sdk/` README](./sdk/README.md) for the full API.

## How Perihelion Compares

| Property                | Centralized exchange | Lock-and-mint bridge | **Perihelion**            |
| ----------------------- | -------------------- | -------------------- | ------------------------- |
| Custody during transfer | Custodial            | Custodial (wrapper)  | **Non-custodial**         |
| Asset received          | Native               | Synthetic wrapper    | **Canonical Stellar**     |
| Steps for the user      | Many (KYC, withdraw) | Multiple txs         | **One signature**         |
| Worst-case for the user | Frozen funds         | Wrapper depeg / hack | **Refund in full**        |
| Rate discovery          | Order book           | Fixed / oracle       | **Open solver auction**   |
| Operator trust          | Full                 | Bridge multisig      | **DVN set + (ZK roadmap)**|

## Documentation

| Document                                                                | Description                                                                 |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| [Integration Quickstart](./docs/quickstart.md)                          | Copy-pasteable end-to-end walkthrough: install → sign → submit → settle     |
| [Technical Architecture](./docs/TECHNICAL-ARCHITECTURE.md)              | Full production spec: contracts, LayerZero V2, solver economics, security, testing, rollout |
| [Intent Lifecycle Diagram](./docs/TECHNICAL-ARCHITECTURE.md#intent-lifecycle-state-diagram) | Canonical state diagram mapping SDK / EVM / Soroban vocabularies, all transitions and terminal paths |
| [Architecture Overview](./docs/architecture.md)                         | High-level settlement flow and trust model                                  |
| [Intent Specification](./docs/intent-spec.md)                           | The signable intent format and EIP-712 encoding                             |
| [Deployment & Operations](./docs/deployment.md)                         | Production deployment, the timelock-multisig owner + guardian, and admin/incident runbooks |
| [Relayer Runbook](./docs/relayer-runbook.md)                            | Relayer operator guide: key management, configuration, monitoring, crash recovery, reorg handling, and incident playbooks |
| [Solver Runbook](./docs/running-a-solver.md)                            | Solver operator guide: setup, configuration, monitoring, and troubleshooting |
| [Differential Fuzzing](./docs/differential-fuzzing.md)                  | Wire format codec validation harness for detecting encoder/decoder divergence |
| [Coverage Reporting](./docs/coverage.md)                                | How to produce and interpret lcov/Codecov coverage for all three languages  |
| [Glossary](./docs/glossary.md)                                          | Definitions of every protocol term                                          |
| [FAQ](./docs/faq.md)                                                    | Common questions about safety, solvers, and trust                           |
| [Contributing Guide](./CONTRIBUTING.md)                                 | How to contribute and where the work lives                                  |
| Component READMEs                                                       | [contracts](./contracts/README.md) · [sdk](./sdk/README.md) · [solver](./solver/README.md) · [relayer](./relayer/README.md) |

## Roadmap

| Phase       | Focus                                                        | Trust model                              |
| ----------- | ------------------------------------------------------------ | ---------------------------------------- |
| **Phase 1** | Guarded mainnet-beta: one corridor, allowlisted solvers, value caps | DVN set + team multisig (timelocked)     |
| **Phase 2** | Multi-route, permissionless solvers & relayers               | DVN set only (no per-operator trust)     |
| **Phase 3** | ZK state-proof verification (BN254 / Protocol 24), on-chain governance | Proof-system soundness                   |

Each phase has measurable acceptance criteria and an external **audit gate**
before the next begins. See the
[phased rollout](./docs/TECHNICAL-ARCHITECTURE.md#8-phased-rollout) for details.

## Project Status

Perihelion is in **active early development**. Current focus: the Soroban
settlement contract and the intent specification.

> ⚠️ **The interfaces and on-chain formats described here are not yet stable, are
> unaudited, and may change before the first audited release. Do not use in
> production.**

We build in public and welcome contributors at every stage — from architecture
discussions to the first lines of contract code.

## Implementation Status

The following components are currently **mocked, stubbed, or pending** and should
not be assumed to have live, production-ready implementations:

| Component | Status | Details |
| --- | --- | --- |
| **LayerZero Endpoint (Soroban)** | Interface + Mock | `contracts/soroban/settlement/src/endpoint.rs` defines the `LzEndpoint` trait as a minimal, swappable abstraction. During this phase, a mock contract implements this surface; the real endpoint (or a thin adapter) will implement the same signature once the Soroban LayerZero stack is GA. The Soroban side does not yet communicate with a live LayerZero endpoint. |
| **Inbound FillInstruction Codec** | Pending | The codec for deserializing `FillInstruction` messages from LayerZero is a typed stub. Full implementation is deferred pending finalization of the cross-chain message format (see [issue #2](https://github.com/Perihelion-Protocol/Perihelion/issues/2)). |
| **Relayer Watcher & Delivery** | Stubs | The `relayer/` module's message watcher and delivery components are currently stubbed out for local testing. Production relayer implementations are still in development. |
| **Solver Executor** | Unimplemented | The solver executor (`solver/`) is not yet implemented. See [issue #5](https://github.com/Perihelion-Protocol/Perihelion/issues/5). |
| **Value Caps / Circuit Breaker** | Pending | Protocol-wide value caps and circuit-breaker controls are under development (see [issue #145](https://github.com/Perihelion-Protocol/Perihelion/issues/145)). Currently there are no per-intent maximum locks or rolling-window throughput limits. |

This section is maintained as features land. For an exhaustive implementation
roadmap, see the [phased rollout](./docs/TECHNICAL-ARCHITECTURE.md#8-phased-rollout)
section of the Technical Architecture.

## Contributing

Contributions are welcome at every level. The project is structured around
clearly scoped, skill-tagged issues designed for
[Drips Wave](https://communityfund.stellar.org) sprint cycles, across four
tracks: **Rust/Soroban**, **Solidity**, **TypeScript**, and **Documentation**.

1. Read the [Contributing Guide](./CONTRIBUTING.md) and the
   [Code of Conduct](./CODE_OF_CONDUCT.md).
2. Browse the [issue taxonomy](./docs/TECHNICAL-ARCHITECTURE.md#9-contribution-guide-for-drips-wave)
   to find work matched to your skills and a Wave cycle.
3. Open or claim an issue, branch, implement with tests, and open a PR.

All PRs run through CI (`npm test`, `cargo test`, `forge test`) and are reviewed
against the protocol's [design invariants](./docs/TECHNICAL-ARCHITECTURE.md#0-design-invariants-read-first).

## Trust Assumptions

The claims above ("no custodial risk," "never lose funds mid-bridge") describe
the **normal intent flow**: while a lock is in transit, the protocol's
invariants (I1–I5, see [Architecture](#architecture)) guarantee a user is
either settled or refunded. They do not describe the **governance layer**.
Scoped honestly, per role:

| Role | Can do | Cannot do | Bounding mechanism |
|---|---|---|---|
| **Solver / Relayer / Keeper** | Delay or decline to act | Steal funds, forge a fill, censor permanently (anyone can take over) | Permissionless; wire-format and signature checks |
| **LayerZero DVN set** | — | — | Root of message authenticity; a colluding DVN set can forge a fill (see [T16](./docs/threat-model.md#t16--layerzero-endpoint-compromise--malicious-origin-spoofing)) |
| **Guardian (EVM)** | Pause new locks and local refunds, for up to 72h per 144h cycle | Move funds, change config, unpause | Auto-expiry + cooldown ([T11](./docs/threat-model.md#t11--guardian-key-dos-via-repeated-instant-pause)) |
| **EVM timelock owner set** | Rotate the peer, guardian, or grace period; **withdraw *any* token balance the escrow holds via `skim`, with no on-chain bound relating it to locked funds** | Bypass the timelock delay for peer/grace/guardian changes | M-of-N confirmation + public delay for config changes; **`skim` itself has no delay, no cap, and no per-token accounting** ([T17](./docs/threat-model.md#t17--governance-extractable-escrow-balance)) |
| **A single EVM timelock owner** | Cancel any pending operation, including a legitimate unpause or guardian rotation | Execute an operation alone | None at present — this is a liveness single point of failure ([T20](./docs/threat-model.md#t20--governance-liveness)) |
| **Soroban admin** | Rotate the LayerZero endpoint **instantly, with no delay** | — | `propose_peer`/`confirm_peer` have a 1-day delay; `set_endpoint` does not ([T18](./docs/threat-model.md#t18--instant-endpoint-rotation-on-soroban)) |

**The practical implication:** the escrow's custody guarantee is only as strong
as the timelock owner set's honesty, because `skim` is unbounded and the
refund path (`cancelExpired`) is itself pausable. This is the single largest
concentration of risk in the protocol today and is not yet mitigated on-chain
— see [`docs/threat-model.md`](./docs/threat-model.md) §0 and T17–T20 for the
full trust model, likelihood/impact assessment, and tracked mitigation issues.

## Security

Perihelion is unaudited and under active development. If you discover a
vulnerability, **please do not open a public issue** — follow the responsible
disclosure process in [`SECURITY.md`](./SECURITY.md).

## Community & Support

- 🐛 **Bugs & features:** [open an issue](https://github.com/Perihelion-Protocol/Perihelion/issues)
- 💬 **Questions & design discussion:** [GitHub Discussions](https://github.com/Perihelion-Protocol/Perihelion/discussions)
- 📣 **Updates:** watch the repository for releases

## License

Licensed under the [MIT License](./LICENSE).

## Acknowledgements

Built on the shoulders of the [Stellar Development Foundation](https://stellar.org),
[Soroban](https://soroban.stellar.org), and [LayerZero](https://layerzero.network),
and inspired by the intent-based designs pioneered by
[UniswapX](https://uniswap.org) and [CoW Protocol](https://cow.fi).

---

<div align="center">

_Perihelion — named for the point of closest approach between two orbiting
bodies. The shortest, most efficient path between Stellar and the rest of the
blockchain universe._

</div>
