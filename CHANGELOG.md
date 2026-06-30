# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Monorepo scaffold: Soroban settlement contract, EVM escrow contract,
  TypeScript SDK, reference solver node, and LayerZero relayer.
- Full [Technical Architecture Specification](./docs/TECHNICAL-ARCHITECTURE.md)
  covering storage layout, intent state machine, LayerZero V2 integration,
  EVM escrow spec, solver economics, threat matrix, testing, and phased rollout.
- Intent specification and EIP-712 encoding shared across the SDK and EVM escrow.
- Project governance & community files: `SECURITY.md`, `CODE_OF_CONDUCT.md`,
  `CONTRIBUTING.md`, issue/PR templates, and `CODEOWNERS`.
- Continuous integration: TypeScript build/test matrix and contracts
  (Soroban + EVM) workflows.
- Glossary and FAQ documentation.

### Changed

- Targeted `soroban-sdk` 22 to match the modern `Env::register` contract API.
- Pinned Node global types (`types: ["node"]`) in the shared TS config.

[Unreleased]: https://github.com/Perihelion-Protocol/Perihelion/commits/main
