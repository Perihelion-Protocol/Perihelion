# Frequently Asked Questions

### Is Perihelion a lock-and-mint bridge?

No. There is no wrapper asset and no mint. A solver delivers **canonical Stellar
assets** from its own inventory, and is later repaid from the user's locked
source funds. Users receive real assets, not a synthetic IOU.

### What happens if no solver fills my intent?

Your funds remain locked in the source-chain escrow until the deadline. Once the
deadline passes, anyone (including you) can trigger a refund — you get your funds
back in full. You never lose funds by going unfilled.

### What happens if a solver misbehaves?

A solver can only ever deliver **at least** your `minDestAmount` of the **exact**
asset specified in your intent — both are enforced on-chain. A solver that tries
to deliver less, or a different asset, simply has its fill rejected. A solver
that fills an intent it shouldn't be paid for is the solver's own loss, never
yours. See the [threat matrix](./TECHNICAL-ARCHITECTURE.md#6-security-model--threat-matrix).

### Who do I have to trust?

In the current phase: the LayerZero DVN set (multiple independent verifiers must
agree) and the protocol's timelocked admin multisig. You do **not** trust any
single solver or relayer — those roles are permissionless and a faulty one only
delays your settlement, never endangers your funds. The roadmap replaces DVN
trust on the most sensitive path with ZK state proofs (Protocol 24).

**Scoped precisely** — this is what each trusted role can and cannot do:

| Role | What they can do | What bounds it |
|---|---|---|
| DVN set | Attest to source-chain events | Multi-DVN threshold; a colluding set can forge a fill (worst case, see [threat-model.md T16](./threat-model.md#t16--layerzero-endpoint-compromise--malicious-origin-spoofing)) |
| EVM timelock owner set (M-of-N) | Rotate peer/guardian/grace; **withdraw any token balance the escrow holds via `skim`, unbounded by locked-fund accounting** | Config changes go through a public delay; **`skim` does not** ([T17](./threat-model.md#t17--governance-extractable-escrow-balance)) |
| A single timelock owner | Veto (cancel) any pending governance action, including a legitimate unpause | Nothing — a liveness gap, not a fund-safety one ([T20](./threat-model.md#t20--governance-liveness)) |
| Guardian | Pause new locks/refunds for ≤72h per 144h cycle | Auto-expiry + cooldown; cannot move funds |
| Soroban admin | Rotate the LayerZero endpoint with **no delay** (unlike peer rotation, which has one) | Not yet bounded ([T18](./threat-model.md#t18--instant-endpoint-rotation-on-soroban)) |

The "you don't lose funds" guarantee holds for the intent-fill flow itself
(I1–I5). It does not mean the timelock owner set is powerless over custody —
see [`threat-model.md`](./threat-model.md) for the full breakdown, including
why this is currently the largest unmitigated concentration of risk in the
protocol.

### How is this different from UniswapX or CoW Protocol?

The architecture is the same family — signed intents fulfilled by a competing
solver network. Perihelion adapts it for **cross-chain settlement into Stellar**,
using LayerZero for messaging and a Soroban settlement contract built around
Stellar's storage and finality model.

### Which chains and assets are supported?

The target source chains are Ethereum, Base, and Arbitrum, settling into Stellar.
Initial corridors focus on major stablecoins (USDC, EURC). Support expands by
phase — see the [roadmap](./TECHNICAL-ARCHITECTURE.md#8-phased-rollout).

### Can I run a solver?

Yes — that is a core goal. The reference solver lives in
[`solver/`](../solver/README.md). In Phase 1 the solver set is allowlisted while
the protocol is hardened; it becomes fully permissionless in Phase 2. The
[solver economics](./TECHNICAL-ARCHITECTURE.md#5-solver-economics--formal-model)
section covers capital requirements and profitability.

### Can I run a relayer?

Yes. The relayer in [`relayer/`](../relayer/README.md) is permissionless and
runnable by anyone, so the messaging layer has no single point of failure.

### Is it audited? Can I use it in production?

Not yet. Perihelion is in early development and **unaudited**. On-chain formats
may change. Do not use it with funds you are not prepared to lose until the first
audited release. See [`SECURITY.md`](../SECURITY.md).

### How do I integrate Perihelion into my app?

Use the [`@perihelion/sdk`](../sdk/README.md) — the common path is three calls:
build an intent, sign it, submit it, then await settlement.

### Where do I report a bug or a vulnerability?

Non-security bugs: open a GitHub issue. Security vulnerabilities: **do not** open
a public issue — follow [`SECURITY.md`](../SECURITY.md).
