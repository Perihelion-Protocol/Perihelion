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

## Reporting a Vulnerability

**Please do not open a public GitHub issue for security vulnerabilities.**

Instead, report privately via one of:

- **GitHub Security Advisories** — use the
  ["Report a vulnerability"](https://github.com/Perihelion-Protocol/perihelion/security/advisories/new)
  button on the repository's Security tab (preferred).
- **Email** — contact the maintainers at the address listed on the organization
  profile, with subject line `PERIHELION SECURITY`.

When reporting, please include:

1. A description of the vulnerability and the component affected
   (`contracts/soroban`, `contracts/evm`, `sdk`, `solver`, or `relayer`).
2. Steps to reproduce, ideally with a failing test or proof-of-concept.
3. The potential impact and, if known, a suggested mitigation.

## What to Expect

| Stage                  | Target turnaround           |
| ---------------------- | --------------------------- |
| Acknowledgement        | within 3 business days      |
| Initial assessment     | within 7 business days      |
| Fix & coordinated disclosure | severity-dependent    |

We will keep you informed throughout, credit you in the advisory (unless you
prefer to remain anonymous), and coordinate a disclosure timeline with you.

## Scope

In scope:

- The Soroban settlement contract (`contracts/soroban`)
- The EVM escrow contract (`contracts/evm`)
- The SDK, solver, and relayer where a bug could lead to loss of funds,
  unauthorized settlement, or replay

Out of scope (report, but lower priority):

- Issues requiring a compromised LayerZero DVN set (a documented Phase-1/2 trust
  assumption — see the [threat matrix](./docs/TECHNICAL-ARCHITECTURE.md#6-security-model--threat-matrix))
- Denial-of-service that only delays settlement without risking funds
- Findings in third-party dependencies without a Perihelion-specific exploit path

## Safe Harbor

We will not pursue or support legal action against researchers who:

- make a good-faith effort to avoid privacy violations, data destruction, and
  service interruption, and
- report promptly and do not exploit the issue beyond what is necessary to
  demonstrate it.

## Code review for security-sensitive paths

Changes to fund-moving code, wire codecs, EIP-712 hashing, and replay guards
require approval from `@Perihelion-Protocol/security-reviewers` in addition to
the package owner. This is enforced automatically via `.github/CODEOWNERS` and
branch protection. See [CONTRIBUTING.md](./CONTRIBUTING.md#security-review-policy)
for the full list of sensitive paths and the rationale for each.

Thank you for helping keep Perihelion and its users safe.
