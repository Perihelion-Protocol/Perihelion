# Perihelion Documentation

| Document                                                | What it covers                                                  |
| ------------------------------------------------------- | -------------------------------------------------------------- |
| [TECHNICAL-ARCHITECTURE.md](./TECHNICAL-ARCHITECTURE.md) | Full production spec: Soroban + EVM contracts, LayerZero V2, solver economics, threat matrix, testing, rollout |
| [architecture.md](./architecture.md)                    | High-level settlement flow and trust model (orientation)       |
| [intent-spec.md](./intent-spec.md)                      | The signable intent format and EIP-712 encoding                |
| [CONTRIBUTING.md](./CONTRIBUTING.md)                    | How to contribute, and where the work lives                    |
| [SECURITY.md](../SECURITY.md)                           | Responsible disclosure scope, reporting channels, SLAs, and safe harbor |

## Component map

| Component    | Language          | Doc / README                          |
| ------------ | ----------------- | ------------------------------------- |
| `contracts/` | Rust + Solidity   | [contracts/README.md](../contracts/README.md) |
| `sdk/`       | TypeScript        | [sdk/README.md](../sdk/README.md)     |
| `solver/`    | TypeScript        | [solver/README.md](../solver/README.md) |
| `relayer/`   | TypeScript        | [relayer/README.md](../relayer/README.md) |
