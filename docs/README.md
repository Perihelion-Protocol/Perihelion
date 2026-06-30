# Perihelion Documentation

| Document                                                | What it covers                                                  |
| ------------------------------------------------------- | -------------------------------------------------------------- |
| [TECHNICAL-ARCHITECTURE.md](./TECHNICAL-ARCHITECTURE.md) | Full production spec: Soroban + EVM contracts, LayerZero V2, solver economics, threat matrix, testing, rollout |
| [architecture.md](./architecture.md)                    | High-level settlement flow and trust model (orientation)       |
| [intent-spec.md](./intent-spec.md)                      | The signable intent format and EIP-712 encoding                |
| [running-a-solver.md](./running-a-solver.md)            | Solver operator runbook: prerequisites, configuration, monitoring, troubleshooting |
| [relayer-runbook.md](./relayer-runbook.md)              | Relayer operator runbook: key management, configuration, monitoring, crash recovery, reorg handling, incident playbooks |
| [deployment.md](./deployment.md)                        | Production deployment: timelock multisig, admin runbooks, incident response |
| [CONTRIBUTING.md](./CONTRIBUTING.md)                    | How to contribute, and where the work lives                    |

## Component map

| Component    | Language          | Doc / README                          |
| ------------ | ----------------- | ------------------------------------- |
| `contracts/` | Rust + Solidity   | [contracts/README.md](../contracts/README.md) |
| `sdk/`       | TypeScript        | [sdk/README.md](../sdk/README.md)     |
| `solver/`    | TypeScript        | [solver/README.md](../solver/README.md) |
| `relayer/`   | TypeScript        | [relayer/README.md](../relayer/README.md) |
