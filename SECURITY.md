# Security Policy

Perihelion Protocol moves user funds across chains. We take security seriously
and welcome responsible disclosure from the community.

> ⚠️ **Perihelion is unaudited and under active development.** Do not use it with
> mainnet funds you are not prepared to lose until the first audited release.

## Supported Versions

The protocol has not yet reached a stable release. Until `v1.0.0`, only the
`main` branch is supported, and on-chain formats may change between commits.

| Version | Supported          |
| ------- | ------------------ |
| `main`  | ✅ (pre-release)   |
| tagged  | — (none yet)       |

## In-Scope Components & Versions

**High Priority (Loss of Funds / Fund Flow / Protocol Integrity):**

- **Soroban Settlement Contract** (`contracts/soroban/`)
  - Intent lifecycle management (`fill_intent`, `cancel_expired_intent`)
  - Amount validation and asset delivery
  - Cross-chain message handling and sequencing
  - All versions on `main`

- **EVM Escrow Contract** (`contracts/evm/`)
  - Lock/release/refund fund movement
  - Intent verification and signature validation
  - LayerZero message reception and processing
  - All versions on `main`

- **SDK** (`sdk/`)
  - Intent hashing and EIP-712 serialization (cryptographic core)
  - Intent signing and validation
  - Message deserialization affecting settlement
  - All versions on `main`

- **Solver & Relayer** (`solver/`, `relayer/`)
  - Transaction construction and ordering bugs affecting fund safety
  - Intent lifecycle state machine bugs
  - Cross-chain message delivery failures
  - All versions on `main`

- **Integration points:**
  - LayerZero V2 message flow and composability
  - Bridge state consistency across chains
  - Event emission and monitoring signals

**Out of Scope (report, but lower priority):**

- Issues requiring a compromised LayerZero DVN set (a documented Phase-1/2 trust
  assumption — see the [threat matrix](./docs/TECHNICAL-ARCHITECTURE.md#6-security-model--threat-matrix))
- Denial-of-service that only delays settlement without risking funds
- Findings in third-party dependencies without a Perihelion-specific exploit path
- Gas optimization opportunities (unless they introduce safety regressions)

## Reporting a Vulnerability

**Please do not open a public GitHub issue for security vulnerabilities.**

Instead, report privately via one of:

- **GitHub Security Advisories** (**Preferred**)
  - Use the ["Report a vulnerability"](https://github.com/Perihelion-Protocol/Perihelion/security/advisories/new)
  button on the repository's Security tab
  - Ensures end-to-end encrypted communication and creates a coordinated disclosure record
  - **This channel is actively monitored and will receive fastest response**

- **Email**
  - **Primary contact:** security@perihelion-protocol.org
  - **Subject line:** `PERIHELION SECURITY`
  - **PGP key** available upon request (include your preferred contact method)
  - **This email address is actively monitored by the security team**

When reporting, please include:

1. A description of the vulnerability and the component affected
   (`contracts/soroban`, `contracts/evm`, `sdk`, `solver`, or `relayer`).
2. Steps to reproduce, ideally with a failing test or proof-of-concept.
3. The potential impact and severity assessment (if known).
4. A suggested mitigation (if available).

## Response Timeline & Disclosure Process

We are committed to responsible disclosure and transparency. All vulnerability
reports will receive coordinated handling:

### Triage & Response SLAs

| Stage                        | Target turnaround           | Notes |
| ---------------------------- | --------------------------- | ----- |
| **Initial acknowledgement**  | within 1 business day       | Confirms receipt and assigns ticket |
| **Severity assessment**      | within 3 business days      | Communicates impact rating and next steps |
| **Fix development**          | severity-dependent (see below) | Updates provided weekly minimum |
| **Patch testing & validation** | before public disclosure  | Includes all supported versions |

### Disclosure Timeline by Severity

| Severity | Fix deadline | Disclosure deadline | Embargo period | Researcher credit |
| -------- | ------------ | ------------------- | -------------- | --------- |
| **Critical** (active exploitation / fund loss vector) | 7 days | 14 days from acknowledgement | 14 days max | ✓ (unless declined) |
| **High** (significant fund risk or bypass) | 14 days | 30 days from acknowledgement | 30 days max | ✓ (unless declined) |
| **Medium** (limited exploitation or workaround exists) | 30 days | 60 days from acknowledgement | 60 days max | ✓ (unless declined) |
| **Low** (theoretical or requires multiple conditions) | 90 days | 90 days from acknowledgement | flexible | ✓ (unless declined) |

We will keep you informed throughout, credit you in the advisory (unless you
prefer to remain anonymous), and coordinate a disclosure timeline with you.

**Expedited disclosure:** If you believe a vulnerability is already publicly
known or being actively exploited, contact us immediately so we can accelerate
the process.

## Safe Harbor

We will not pursue or support legal action against researchers who:

- make a good-faith effort to avoid privacy violations, data destruction, and
  service interruption,
- report security vulnerabilities promptly and do not exploit the issue beyond
  what is necessary to demonstrate it,
- follow this disclosure policy and give us reasonable time to fix issues before
  public disclosure, and
- do not access systems or data beyond what is necessary to demonstrate the
  vulnerability.

Responsible researchers are protected under this policy even if their testing
inadvertently violates terms of service or access policies, provided they act
in good faith to minimize harm.

## Code review for security-sensitive paths

Changes to fund-moving code, wire codecs, EIP-712 hashing, replay guards, the
SDK's intent hashing and validation, and CI workflows require approval from
`@Perihelion-Protocol/maintainers`. `.github/CODEOWNERS` assigns that team as the
owner of every path in the repository, and it is enforced by branch protection
only when **Require review from Code Owners** is enabled for `main`. No separate
security-reviewers group is currently assigned. See
[CONTRIBUTING.md](./CONTRIBUTING.md#security-review-policy) for the full list of
sensitive paths and the rationale for each.

## Key Management & Operational Security

Perihelion's production deployment requires careful management of privileged keys
(governance multisig, guardian, relayer, solver) and operational procedures
(incident response, key rotation, monitoring).

See [docs/key-management.md](./docs/key-management.md) for the comprehensive
key-management and rotation policy, including:
- Generation, storage, and access control for each key role
- Operational use procedures and monitoring
- Planned and emergency rotation playbooks
- Compromise-response procedures and time budgets
- Incident response and rotation drills

Thank you for helping keep Perihelion and its users safe.
