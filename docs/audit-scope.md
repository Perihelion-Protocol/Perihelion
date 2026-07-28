# Audit Scope and Readiness

## Overview

This document pins the exact commit and bytecode in scope for the Perihelion protocol security audit engagement, confirms readiness prerequisites, defines the findings-tracking process, and coordinates the audit timeline.

## Audit Scope

### Commit Hash

**In-scope commit**: TBD (pinned at audit kickoff)

All reviewable artifacts (source code, compiled bytecode, tests, threat model, trust model) are frozen at this commit. No changes to the reviewed code are made until all audit findings are triaged and remediation PRs are prepared.

### Bytecode

**In-scope deployments**:
- EVM escrow contract (`contracts/evm/src/PerihelionEscrow.sol`) compiled with Solidity `^0.8.24`
- Soroban settlement contract (`contracts/soroban/settlement/src/lib.rs`) compiled with stable Rust toolchain (see `rust-toolchain.toml`)
- EVM timelock contract (`contracts/evm/src/PerihelionTimelock.sol`) — the governance path that authorizes every admin action above, including `skim`

**Explicitly in scope: governance-extractable value.** The audit must assess
what the timelock owner set and the Soroban admin key can extract or disrupt,
not just what an external attacker can do. In particular:
- `PerihelionEscrow.skim` — unbounded owner-only withdrawal of any token
  balance the escrow holds, with no on-chain accounting tying it to actual
  surplus (see [`docs/threat-model.md` T17](./threat-model.md#t17--governance-extractable-escrow-balance)).
- The refund path (`cancelExpired` / `cancel_expired_intent`) being pausable
  on both chains, removing the user's exit during a timelocked proposal (see
  [T19](./threat-model.md#t19--refund-denial-via-pause)).
- `PerihelionTimelock.cancel` being callable by any single owner, a
  governance-liveness gap that can suppress a legitimate recovery action (see
  [T20](./threat-model.md#t20--governance-liveness)).
- Soroban `set_endpoint` taking effect with no delay, unlike `set_peer` (see
  [T18](./threat-model.md#t18--instant-endpoint-rotation-on-soroban)).

This is a deliberate scope decision: `docs/threat-model.md` identifies
governance-extractable escrow value as the largest currently unmitigated
concentration of risk in the protocol, and a point-in-time audit is the
appropriate venue to assess it before any of T17–T20's proposed mitigations
land.

**Reproducible build**: Both contracts are built reproducibly using the provided Makefile:
```bash
make build-evm
make build-soroban
```

Bytecode hashes are recorded in the audit engagement document.

## Readiness Prerequisites

### Checklist

- [x] **Reproducible builds**: Both EVM and Soroban contracts build deterministically. CI verifies reproducibility on every commit.
- [x] **NatSpec coverage**: All public and external functions have complete NatSpec documentation. Coverage threshold: 100% of public API.
- [x] **Invariant tests**: Foundry invariant tests exerc protocol invariants (I1-I5 in `docs/TECHNICAL-ARCHITECTURE.md`). Soroban fuzz tests in `contracts/soroban/settlement/src/fuzz.rs`.
- [x] **Conformance tests**: Cross-chain integration tests verify EVM-Soroban wire protocol consistency (tests in `contracts/evm/test/CrossValidate.t.sol`, `contracts/soroban/settlement/src/test.rs`).
- [x] **Fork tests**: EVM contract tested against live-chain forks (Mainnet, Sepolia, etc.) to verify real-world interaction correctness.
- [x] **Threat model**: Finalized in `docs/threat-model.md`. Identifies threat vectors, trust assumptions, and actor roles.
- [x] **Trust model**: Embedded in contract NatSpec and threat model. Documents role separation, admin/guardian/endpoint responsibilities, and the two-step handover pattern.
- [x] **Known issues triaged**: All known issues (GitHub issues labeled `security`, `risk`) have been triaged, prioritized, and assigned to phase or deferred.

### Test Suite

Run full test suite before audit:
```bash
make test              # All tests (EVM + Soroban)
make slither-evm       # Slither static analysis (EVM)
make coverage          # Code coverage report
```

**Minimum coverage threshold**: 85% line coverage on critical paths.

## Findings Tracking and Remediation Process

### 1. Findings Intake

Each audit finding is logged as a GitHub issue in the Perihelion repository:
- **Issue title**: `[AUDIT-<SEVERITY>] <Finding title>`
- **Severity**: CRITICAL, HIGH, MEDIUM, LOW, or INFORMATIONAL
- **Issue body** must include:
  - Finding description and reproduction (if applicable)
  - Affected contract(s) and line numbers
  - Actual vs. expected behavior
  - Suggested remediation (if any)
  - Risk assessment and impact

Example: `[AUDIT-HIGH] Integer overflow in solver reputation calculation`

### 2. Triage and Assessment

**Auditor + Core team meeting**: Within 2 business days of findings delivery:
- Severity agreement (may adjust from auditor's initial assessment)
- Scope confirmation (in-scope or false positive)
- Blocker determination (must fix before launch vs. future work)

**Severity definitions**:
- **CRITICAL**: Allows arbitrary fund loss or protocol halt; must be fixed before any deployment.
- **HIGH**: Significant impact (e.g., unintended refund, improper access control); fix before mainnet launch.
- **MEDIUM**: Moderate risk; should be fixed before launch; acceptable post-launch if mitigated operationally.
- **LOW**: Minor impact; nice-to-have fix; can be deferred to future releases.
- **INFORMATIONAL**: Observations and best-practices; no security impact.

### 3. Remediation

**Per-finding remediation PR**:
- Each finding receives its own remediation PR (or a single PR if findings are tightly coupled).
- PR title: `[AUDIT-<SEVERITY>] <Finding> (#<issue-number>)` to link to the audit issue.
- PR body includes:
  - Link to the audit finding issue
  - Technical description of the fix
  - Test additions covering the fix
  - Any new invariants or guards introduced
- Remediation PRs are reviewed and merged to a dedicated `audit-fixes-<date>` branch before re-verification.

### 4. Re-verification

**After all CRITICAL and HIGH findings are remediated**:
- Auditors re-verify fixes in a follow-up engagement.
- Fix verification focuses on:
  - Does the fix actually address the finding?
  - Are any new vulnerabilities introduced?
  - Are tests sufficient to prevent regression?
- Results are documented in a re-verification memo.

### 5. Sign-off and Publication

- **Final signed report**: Auditor delivers signed/notarized final report including findings, remediations, and verification results.
- **Public disclosure**: Report is published to the Perihelion GitHub and website (date TBD post-audit).
- **Remediation tracking**: Each remediation PR remains linked to the corresponding audit issue for post-mortem transparency.

## Audit Timeline

| Phase | Date | Owner |
|-------|------|-------|
| **Code freeze** | TBD | Core team |
| **Audit kickoff** | TBD | Auditor + Core team |
| **Findings delivery** | TBD + ~4 weeks | Auditor |
| **Triage + remediation planning** | TBD + ~4.5 weeks | Core team |
| **Remediation period** | TBD + ~5-6 weeks | Core team |
| **Fix re-verification** | TBD + ~7 weeks | Auditor |
| **Final report** | TBD + ~7.5 weeks | Auditor |
| **Public disclosure** | TBD + ~8 weeks | Core team |

## Communication

- **Audit working group**: Core team, auditor, optional external advisors. Weekly sync.
- **Updates**: Posted in `#audit` Slack channel and GitHub discussions.
- **Escalations**: Critical issues during remediation escalate directly to core team lead.

## Out of Scope

The following are explicitly out of scope for this audit:

- Smart contracts in `/test` directories (test fixtures only).
- Off-chain relayer/solver/mempool logic (future audit).
- Frontend/SDK (separate engagement).
- Deployment infrastructure and operational runbooks.
- Past commits or legacy code paths.

## References

- Threat model: `docs/threat-model.md`
- Technical architecture: `docs/TECHNICAL-ARCHITECTURE.md`
- Protocol specification: `docs/protocol-spec.md`
- Audit engagement letter: (link TBD)
- Auditor contact: (TBD)
