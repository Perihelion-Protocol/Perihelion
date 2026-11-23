# Dependency Policy

This document records how dependency advisories are triaged for this repository and
the time-boxed exceptions that are currently in place.

## General policy

- `cargo deny check` runs in the `Dependency audit` workflow and must pass on `main`.
- Advisories are resolved by upgrading the affected crate whenever a compatible
  release exists (respecting the workspace `rust-version`).
- When no compatible upgrade exists, an advisory may be ignored **only** with:
  - a written rationale explaining why the affected code is not reachable in
    production (e.g. test-only or host-only code paths),
  - a review/expiry date, and
  - a link to the tracking issue.
- Ignored advisories are re-evaluated on or before their review date; the ignore
  is removed as soon as an upgrade resolves it.

## Current exceptions

All three advisories below are pulled in transitively through `soroban-sdk 22.0.11`
(`soroban-sdk-macros`, `serde_with`, `stellar-xdr`, `soroban-env-common`). They are
tracked in issue #1129.

| Advisory | Crate | Kind | Rationale | Review date |
| --- | --- | --- | --- | --- |
| RUSTSEC-2026-0387 | `curve25519-dalek` (via `soroban-env-common`/`stellar-xdr`) | Vulnerability: timing variability in constant-time operations | The affected constant-time operations are not exercised by the contract's wasm: the contract does not perform curve25519 scalar/point operations, and the dependency is only linked through host/test tooling. No secret-dependent curve25519 computation runs in the deployed contract. | 2026-09-30 |
| RUSTSEC-2024-0388 | `derivative` (via `soroban-sdk-macros`) | Unmaintained | `derivative` is a proc-macro used only at compile time by `soroban-sdk-macros`; it is not present in the compiled wasm artifact and poses no runtime risk. | 2026-09-30 |
| RUSTSEC-2024-0436 | `paste` (via `soroban-sdk-macros`/`serde_with`) | Unmaintained | `paste` is a compile-time macro crate; it is not linked into the deployed wasm and has no runtime exposure. | 2026-09-30 |

Each exception is mirrored by an `ignore` entry in `deny.toml` carrying the same
rationale and review date. When `soroban-sdk` publishes a release that drops these
transitive dependencies, the ignores must be removed and `Cargo.lock` refreshed.
