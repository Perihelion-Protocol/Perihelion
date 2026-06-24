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
  button on the repository's Security tab (preferred and monitored).
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
Please give us a reasonable remediation window before public disclosure. If you
believe a vulnerability is being actively exploited, say so in the first line of
the report so we can prioritize incident response.

## Scope

In scope:

| Area | In-scope assets |
| --- | --- |
| Soroban settlement | `contracts/soroban/settlement`, including intent registration, fill, cancel/refund, LayerZero receive/send hooks, replay protection, and storage TTL choices |
| EVM escrow | `contracts/evm/src/PerihelionEscrow.sol`, `contracts/evm/src/PerihelionTimelock.sol`, and LayerZero interface glue |
| Shared wire format | `contracts/shared/wire-vectors/`, `docs/intent-spec.md`, and cross-chain payload encoding/decoding |
| SDK | `sdk/`, where a bug could create invalid signatures, unstable intent hashes, or unsafe client defaults |
| Solver | `solver/`, where a bug could cause unsafe quote construction, incorrect inventory assumptions, or incorrect fill behavior |
| Relayer | `relayer/`, where a bug could replay, drop, or misroute settlement messages |
| Deployment and audit docs | `docs/deployment.md`, `docs/TECHNICAL-ARCHITECTURE.md`, and component READMEs that define production security assumptions |

### Supported deployments and versions

Perihelion has not reached a stable mainnet release. Until `v1.0.0`, supported
security scope is the latest `main` branch, local/test deployments derived from
this repository, and any public testnet or campaign deployment explicitly linked
by maintainers. Production contract addresses should be recorded in
`docs/deployment.md` or release notes before they are treated as in-scope
mainnet assets.

Out of scope (report, but lower priority):

- Issues requiring a compromised LayerZero DVN set (a documented Phase-1/2 trust
  assumption — see the [threat matrix](./docs/TECHNICAL-ARCHITECTURE.md#6-security-model--threat-matrix))
- Denial-of-service that only delays settlement without risking funds
- Findings in third-party dependencies without a Perihelion-specific exploit path
- Social engineering, phishing, spam, or physical attacks
- Vulnerabilities in third-party wallets, RPC providers, bridges, block explorers,
  or infrastructure that Perihelion does not operate
- Self-hosted forks, modified deployments, or private integrations unless they
  demonstrate a bug in this repository's default code
- Scanner-only or documentation-only issues that do not affect security outcomes

## Safe Harbor

We will not pursue or support legal action against researchers who:

- test only against accounts, deployments, or local environments they control,
  unless maintainers explicitly authorize another target;
- make a good-faith effort to avoid privacy violations, data destruction,
  service interruption, and unauthorized fund movement;
- stop testing and report promptly if they encounter sensitive data, private
  keys, credentials, or exploitable access;
- do not exploit the issue beyond what is necessary to demonstrate impact; and
- coordinate disclosure until a fix, mitigation, or accepted-risk decision is
  available.

## Rewards and bounty expectations

This policy defines how to report security vulnerabilities. It does not by
itself create a paid bounty. Any reward depends on the active campaign, issue, or
maintainer confirmation covering the report. Reward decisions may consider
severity, exploitability, novelty, report quality, reproducibility, and whether
the issue affects an in-scope deployment.

Thank you for helping keep Perihelion and its users safe.
