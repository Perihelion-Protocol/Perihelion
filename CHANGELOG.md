# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Every package in this monorepo (`@perihelion/sdk`, `@perihelion/relayer`,
`@perihelion/solver`, `@perihelion/mempool`, the Soroban settlement contract)
moves together and is tracked in this one file until they reach 1.0 and can be
versioned independently.

## [Unreleased]

### Added

- Nothing yet — see [CONTRIBUTING.md](./CONTRIBUTING.md#release-process) for
  what belongs here.

## [0.1.0] - 2026-07-28

The first snapshot of the protocol after its initial build-out. This entry
reconstructs ~250 merged pull requests from their conventional-commit titles,
grouped by theme rather than by PR, since the changelog was not maintained
incrementally (#346). Entries reference the originating issue/PR number where
the merge history preserved one.

### Added

- **Soroban settlement contract**: production `fill_intent` /
  `cancel_expired_intent` / `lz_receive` implementation (#1), event emission
  for all lifecycle transitions (#102), a keeper-reward incentive for calling
  `cancel_expired_intent` on an expired intent (#165), and TTL-archival /
  reservation-window handling for the inbound nonce bitmap (#22, #199).
- **EVM escrow**: upgraded to a LayerZero OApp design (#10) with two-step
  ownership handover, guardian pause, and a timelock-multisig owner
  (`PerihelionTimelock`); EIP-5267 domain introspection and reentrancy
  hardening around the guardian-pause path; fuzz and stateful invariant
  suites for the escrow.
- **Cross-chain wire format**: a fixed big-endian layout for
  `FillInstruction` (§3.3), a version-negotiation policy with an
  `UnknownVersion` error (§3.3.1), and a shared conformance-vector file
  asserted identically by the Solidity and TypeScript sides to catch
  encoder/decoder divergence (differential fuzzing, #108).
- **Protocol-wide value cap and circuit breaker** limiting aggregate exposure
  per intent and across the protocol (#145).
- **Peer governance**: a mandatory delay before a new LayerZero peer takes
  effect, closing the immediate-peer-swap trust gap (#165).
- **Solver**: backoff/jitter on poll failures, an inventory provider
  abstraction, Prometheus-style metrics, a profitability/margin model driven
  by data-driven asset decimals (#84–#91, #218, #220), a bounded
  LRU+TTL "seen" set to cap memory on long-running dedup, and a
  signature-verification cache to avoid re-verifying unchanged intents (#216).
- **Relayer**: a file-based checkpoint store so the LayerZero cursor survives
  restarts (#74, #212), reorg detection with a clamp on `confirmedHead`
  (#75, #213), and a dead-letter queue with retry for messages that fail
  delivery instead of silently advancing past them (#73, #76–#79, #211, #215).
- **SDK**: runtime validation of mempool JSON responses at the trust boundary
  (`parseIntentRecord` et al., #72, #210), a single source-of-truth EIP-712
  message builder shared by hashing/signing/verification, typed error classes,
  and request timeouts/retries in `PerihelionClient` (#214).
- **Operational surface**: a structured logger, health/readiness endpoints,
  and an EVM watcher for the relayer/solver processes (#225); `FatalError`
  propagation so an unrecoverable condition exits the process instead of
  spinning, with graceful drain on `stop()` (#92, #244).
- **CI/tooling**: a root-level polyglot task runner (`Makefile`) covering
  build/test/lint/fmt/coverage across all three stacks (#115, #227);
  lcov/codecov coverage reporting (#109, #230); a mutation-testing workflow
  for all three stacks (#106, #231); differential fuzzing between the Soroban
  and EVM wire codecs; Soroban resource-budget regression checks (#245);
  `fmt`/`clippy`/Slither static analysis gates; commit-lint and
  conventional-commit PR-title enforcement; `lefthook` pre-commit hooks; and
  a dependency-audit workflow with an allowlist and policy document.
- **Governance and docs**: `CODEOWNERS` covering every package and
  security-sensitive path (#118, #233); ~15 new documents under `docs/`
  including the threat model (entries T14–T16 for min-dest-amount
  under-delivery, guardian-pause front-running, and LayerZero endpoint
  compromise — issues #155, #159, #161), a key-management and rotation
  policy (#157), incident-response runbooks for the top failure scenarios
  (#163), solver fill-race/PGA economics analysis, an on-chain
  monitoring/alerting design, an audit-scope and findings-tracking process,
  a relayer operator runbook (#238), an integration quickstart
  (install → sign → submit → settle, #131), the full intent lifecycle state
  diagram (#122), a deployment-verification checklist (#143), an asset
  decimals/corridor reference, contract upgrade and migration strategy docs
  (#169), and a keeper-model / refund-recovery reference; `SECURITY.md`
  expanded with a full disclosure process and scope.

### Changed

- Targeted `soroban-sdk` 22 to match the modern `Env::register` contract API.
- Pinned Node global types (`types: ["node"]`) in the shared TS config.
- `Intent.destination` / `Intent.destAsset` are now length-bounded rather than
  arbitrary strings, closing a Stellar-destination truncation bug where a
  56-byte address was silently cut to 32 bytes and could not be reconstructed
  (#204).
- `FillConfirmed`'s informational amount field, pause semantics, and
  `src_eid` enforcement were tightened to be per-endpoint rather than global
  (#189).

### Fixed

- **EVM**: signature malleability, domain replay, and event-observability
  gaps (#191); a reentrancy invariant, status view, LayerZero fee check, and
  a TTL-truncation bug (#29–#32, #192); guardian DoS, EIP-5267, and
  reentrancy/gas issues (#205); timelock `MIN_DELAY`/`MAX_DELAY` floor
  enforcement (#200) and expiry of a ready timelock operation after a grace
  period (#201); four further EVM security/correctness fixes (#37–#40, #190)
  and four EVM correctness/safety issues found in review (#196).
- **Soroban**: init validation, two-step admin handover, event emission, and
  a peer guard (#15–#18, #187); the cancel-reason error taxonomy and a
  reservation window (#21–#22, #188); a conservative TTL divisor and
  `MAX_DEADLINE_HORIZON` guard against unbounded storage extension (#185);
  `env.native_token()` was not part of the `soroban-sdk` 22 `Env` API, which
  broke the keeper-reward payout — fixed to compile against the pinned SDK
  version.
- **Solver**: `evaluate()` now rejects intents targeting a different source
  chain than the one the solver is configured for, and enforces
  `minMarginBps` as a hard gate rather than an advisory signal (#312, #313).
- **Relayer/SDK**: the cursor no longer advances past a message that failed
  delivery (#73, #211); mempool JSON is validated before use instead of
  trusted via an `as` cast (#72, #210).
- **Repo hygiene**: removed `node_modules` and build artifacts that had been
  committed to version control (#111, #236); removed committed PR-summary
  and progress-log scratch files and dead code (`IntentStore.getByStatus`)
  that had no remaining callers.

### Security

- Added the protocol-wide value cap and circuit breaker described under
  Added, specifically to bound worst-case loss from a single compromised or
  misbehaving component (#145).
- Rewrote the inbound nonce/replay guard on the Soroban side and added
  property tests asserting it holds under adversarial reordering (#103,
  #199, #224).
- Added authorization-failure tests for `lz_receive` to confirm a spoofed
  LayerZero message cannot move funds (#104, #226).
- `ci`: added Slither static analysis and Rust `clippy`/`cargo-deny` gates
  specifically to catch the classes of issue found in the EVM/Soroban fixes
  above before merge, not just after.

[Unreleased]: https://github.com/Perihelion-Protocol/Perihelion/compare/main...HEAD
[0.1.0]: https://github.com/Perihelion-Protocol/Perihelion/releases/tag/v0.1.0
