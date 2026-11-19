# Perihelion Documentation

This is the single index for everything in `docs/`. Each topic has one
authoritative document; where a summary exists, the index says which one wins.

## Core Specifications

| Document | What it covers |
| -------- | -------------- |
| [TECHNICAL-ARCHITECTURE.md](./TECHNICAL-ARCHITECTURE.md) | **Authoritative** full specification: Soroban and EVM contracts, LayerZero V2, wire format, solver economics, threat matrix, testing, rollout |
| [architecture.md](./architecture.md) | Short orientation to the settlement flow and trust model; defers to TECHNICAL-ARCHITECTURE.md |
| [intent-spec.md](./intent-spec.md) | The signable intent format and EIP-712 encoding |
| [fill-amount-semantics.md](./fill-amount-semantics.md) | How `fill_amount` relates to `min_dest_amount` and the locked source amount (all-or-nothing, surplus) |
| [clock-and-deadline-analysis.md](./clock-and-deadline-analysis.md) | Reconciles the EVM, Stellar and SDK clocks; derives the `confirmationGrace` minimum and the solver time-before-deadline guard |
| [assets.md](./assets.md) | Canonical asset decimals, corridor conversion, and max amounts |
| [formal-specification.md](./formal-specification.md) | Formal specification and invariant verification |
| [EVENT-SHAPES.md](./EVENT-SHAPES.md) | Event payload shapes emitted by the contracts and consumed by watchers |
| [api/mempool-api.yaml](./api/mempool-api.yaml) | OpenAPI specification for the mempool service |
| [glossary.md](./glossary.md) | Definitions of protocol terms |
| [faq.md](./faq.md) | Frequently asked questions |
| [quickstart.md](./quickstart.md) | Integration quickstart for developers |

## Security, Monitoring & Operations

| Document | What it covers |
| -------- | -------------- |
| [../SECURITY.md](../SECURITY.md) | Vulnerability disclosure process, scope, response SLAs, safe-harbor |
| [threat-model.md](./threat-model.md) | Threat model and trust assumptions |
| [keeper-model.md](./keeper-model.md) | Keeper model and refund liveness |
| [key-management.md](./key-management.md) | Key management and rotation procedures |
| [audit-scope.md](./audit-scope.md) | Audit scope and readiness |
| [MONITORING.md](./MONITORING.md) | On-chain event monitoring, alert definitions, circuit-breaker integration, reference watcher design |
| [RECONCILIATION.md](./RECONCILIATION.md) | Cross-chain value reconciliation, divergence detection, intent lifecycle matching |
| [ECONOMICS.md](./ECONOMICS.md) | Solver fill-race incentives, gas-griefing analysis, PGA risk quantification, allocation mechanism alternatives |
| [performance.md](./performance.md) | Performance budgets |
| [running-a-solver.md](./running-a-solver.md) | Solver operator runbook: prerequisites, configuration, monitoring, troubleshooting |
| [relayer-runbook.md](./relayer-runbook.md) | Relayer operator runbook: key management, configuration, monitoring, crash recovery, reorg handling, incident playbooks |
| [deployment.md](./deployment.md) | Production deployment: timelock multisig, admin runbooks, incident response |
| [incident-response.md](./incident-response.md) | Incident response runbooks |
| [upgrade-and-migration.md](./upgrade-and-migration.md) | Contract upgrade and migration runbook |
| [dependency-policy.md](./dependency-policy.md) | Dependency and lockfile policy |
| [DIFFERENTIAL-FUZZING-FIXES.md](./DIFFERENTIAL-FUZZING-FIXES.md) | Fixes made as a result of differential fuzzing of wire-format codecs |

## Testing & Quality

| Document | What it covers |
| -------- | -------------- |
| [e2e-testing.md](./e2e-testing.md) | End-to-end testing strategy |
| [differential-fuzzing.md](./differential-fuzzing.md) | Differential fuzzing for wire-format codecs |
| [mutation-testing.md](./mutation-testing.md) | Mutation testing setup and results |
| [coverage.md](./coverage.md) | Coverage reporting |

## Contributing

| Document | What it covers |
| -------- | -------------- |
| [../CONTRIBUTING.md](../CONTRIBUTING.md) | How to contribute, and where the work lives (the single contributor guide) |

## Component map

| Component | Language | Doc / README |
| --------- | -------- | ------------ |
| `contracts/` | Rust + Solidity | [contracts/README.md](../contracts/README.md) |
| `sdk/` | TypeScript | [sdk/README.md](../sdk/README.md) |
| `solver/` | TypeScript | [solver/README.md](../solver/README.md) |
| `relayer/` | TypeScript | [relayer/README.md](../relayer/README.md) |
