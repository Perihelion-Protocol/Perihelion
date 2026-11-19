# Perihelion Documentation

## Core Specifications

| Document                                                | What it covers                                                  |
| ------------------------------------------------------- | -------------------------------------------------------------- |
| [TECHNICAL-ARCHITECTURE.md](./TECHNICAL-ARCHITECTURE.md) | Full production spec: Soroban + EVM contracts, LayerZero V2, solver economics, threat matrix, testing, rollout |
| [architecture.md](./architecture.md)                    | High-level settlement flow and trust model (orientation)       |
| [intent-spec.md](./intent-spec.md)                      | The signable intent format and EIP-712 encoding                |
| [clock-and-deadline-analysis.md](./clock-and-deadline-analysis.md) | Reconciles the EVM, Stellar and SDK clocks; derives the `confirmationGrace` minimum and the solver time-before-deadline guard |
| [assets.md](./assets.md)                                | Canonical asset decimals, corridor conversion, and max amounts |

## Security, Monitoring & Operations

| Document                                                | What it covers                                                  |
| ------------------------------------------------------- | -------------------------------------------------------------- |
| [../SECURITY.md](../SECURITY.md)                        | Vulnerability disclosure process, scope, response SLAs, safe-harbor |
| [MONITORING.md](./MONITORING.md)                        | On-chain event monitoring, alert definitions, circuit-breaker integration, reference watcher design |
| [RECONCILIATION.md](./RECONCILIATION.md)                | Cross-chain value reconciliation, divergence detection, intent lifecycle matching |
| [ECONOMICS.md](./ECONOMICS.md)                          | Solver fill-race incentives, gas-griefing analysis, PGA risk quantification, allocation mechanism alternatives |
| [running-a-solver.md](./running-a-solver.md)            | Solver operator runbook: prerequisites, configuration, monitoring, troubleshooting |
| [relayer-runbook.md](./relayer-runbook.md)              | Relayer operator runbook: key management, configuration, monitoring, crash recovery, reorg handling, incident playbooks |
| [deployment.md](./deployment.md)                        | Production deployment: timelock multisig, admin runbooks, incident response |

## Contributing

| Document                                                | What it covers                                                  |
| ------------------------------------------------------- | -------------------------------------------------------------- |
| [CONTRIBUTING.md](./CONTRIBUTING.md)                    | How to contribute, and where the work lives                    |

## Component map

| Component    | Language          | Doc / README                          |
| ------------ | ----------------- | ------------------------------------- |
| `contracts/` | Rust + Solidity   | [contracts/README.md](../contracts/README.md) |
| `sdk/`       | TypeScript        | [sdk/README.md](../sdk/README.md)     |
| `solver/`    | TypeScript        | [solver/README.md](../solver/README.md) |
| `relayer/`   | TypeScript        | [relayer/README.md](../relayer/README.md) |
