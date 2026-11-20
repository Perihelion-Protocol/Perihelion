# Cross-Chain Clock and Deadline Analysis

**Status:** Reference specification — do not change grace parameters without updating
this document and the corresponding constants in
`contracts/evm/src/PerihelionEscrow.sol` and `contracts/soroban/settlement/src/lib.rs`.
The SDK mirrors of these values live in `sdk/src/intent.ts`.

**Scope:** EVM `block.timestamp`, Stellar `env.ledger().timestamp()`, and SDK
`Date.now()` — three independent clocks that all reason about the same
`intent.deadline` field. This document formally reconciles them, derives the
minimum value for `confirmationGrace` / `MIN_CONFIRMATION_GRACE`, and establishes
solver-side guidance for `isExpired`.

---

## 1. The Three Clocks

The protocol uses a single `deadline` field (Unix seconds, `uint256` on EVM,
`u64` on Soroban) committed into the EIP-712 intent hash. That field is
evaluated against three entirely independent clocks at different points in the
lifecycle.

### 1.1 EVM `block.timestamp`

**Where used:**
- `PerihelionEscrow.lock()` — rejects if `block.timestamp >= intent.deadline`.
- `PerihelionEscrow.cancelExpired()` — rejects if `block.timestamp < l.deadline`
  (i.e., the refund fallback only opens after `deadline + confirmationGrace`).

**Clock properties:**
- Set by the block proposer (miner / PoS validator). The Ethereum Yellow Paper and
  consensus rules require `block.timestamp > parent.timestamp` (strict
  monotonicity per block) and that the timestamp does not exceed the proposer's
  wall-clock time.
- Under EIP-1559 / the Merge, Ethereum mainnet uses 12-second slots. The
  timestamp of a slot is fixed at `genesis_time + slot_number × 12s`, so on
  Ethereum the clock advances in deterministic 12-second steps and validators
  cannot freely choose a value — it is derived from the slot number.
- On non-12s-slot chains (Arbitrum, Base, OP Stack L2s), block production is
  faster and the proposer has more discretion, but the same "no future
  timestamps" rule applies. Practical drift from real time is bounded to roughly
  ±15 s across all supported chains.
- **Monotonicity:** strictly monotone per block (each block's timestamp >
  previous block's timestamp). A timestamp never moves backward between
  consecutive blocks.
- **Backward-movement tolerance:** not applicable in normal operation. A chain
  reorganisation can expose a shorter chain whose tip timestamp is lower than the
  replaced tip, but the Soroban side never sees EVM timestamps directly — only
  the `deadline` field signed into the intent by the user.

### 1.2 Stellar `env.ledger().timestamp()`

**Where used:**
- `deliver_intent` / `fill_intent` — rejects if `env.ledger().timestamp() >= rec.deadline`.
- `cancel_expired_intent` — rejects if `env.ledger().timestamp() < rec.deadline`.
- `on_fill_instruction` — rejects if `fi.deadline > env.ledger().timestamp() + MAX_DEADLINE_HORIZON`.
- `ttl_for_deadline` — computes TTL as `(deadline - now) / MIN_SECS_PER_LEDGER + GRACE_LEDGERS`.

**Clock properties:**
- Set by the Stellar Consensus Protocol (SCP). Each ledger close time is
  negotiated as the median of the UTC timestamps reported by the quorum set
  validators. The Stellar protocol enforces `close_time >= prev_close_time + 1`
  (strictly monotone per ledger), and in practice the close time tracks real UTC
  to within approximately ±1 s because all well-behaved validators use NTP.
- **Monotonicity:** strictly monotone per ledger. `env.ledger().timestamp()` can
  never decrease within a running chain — each new ledger has a timestamp at
  least 1 second greater than the previous. There is no analog of an EVM reorg
  that could expose a lower timestamp.
- **Backward-movement tolerance:** none required. The monotonicity is a
  consensus invariant, not just a convention.

### 1.3 SDK client wall clock (`Date.now()`)

**Where used:**
- `validateIntent()` — rejects if `deadline <= Date.now() / 1000`. Prevents
  submitting an already-expired intent.
- `isExpired(intent, now, clockSkew)` — solver / client check before attempting
  a fill.
- `isRefundable(record, confirmationGraceMs)` — checks `Date.now() / 1000 >=
  record.deadline + confirmationGrace` before suggesting the user call
  `cancelExpired`.

**Clock properties:**
- Pure client wall clock. May drift from chain time by ±30 s in a typical Node.js
  environment and up to ±60 s on a poorly-synchronised machine. It has no
  consensus backing and is the least authoritative of the three clocks.
- **Monotonicity:** not guaranteed. `Date.now()` can move backward if the
  system clock is stepped by NTP or if the process is migrated across hosts.
  Client code must not rely on it being monotone.
- **Backward-movement tolerance:** the SDK's `isExpired` and `isRefundable` use
  an absolute comparison, so a brief backward step simply makes the result more
  conservative (the intent appears less expired than it is). This is the safe
  direction for both checks.

---

## 2. The Skew Between EVM and Stellar Clocks

The `deadline` value the user signs is a UTC Unix timestamp. Both chains
evaluate it, but against independent clocks that may diverge.

### 2.1 Estimating the worst-case skew Δ

| Source | Bound |
|--------|-------|
| EVM `block.timestamp` drift from UTC | ±15 s (practical on Ethereum 12-slot; ±30 s conservative for fast L2s) |
| Stellar `env.ledger().timestamp()` drift from UTC | ±1 s (NTP-disciplined SCP validators) |
| Combined worst-case skew Δ\_skew | ±31 s (Ethereum), ±31 s (fast L2 with 30 s EVM drift + 1 s Stellar) |

Taking a conservative design bound: **Δ\_skew\_worst = 60 s**. This gives 2×
headroom over the 31 s technically measurable worst case, accounting for
occasional validator drift, measurement uncertainty, and any future chains with
less-constrained block times.

### 2.2 What skew means for a near-deadline intent

Consider an intent with deadline `D` that is locked on EVM very close to its
expiry (EVM clock reads `D − ε`). The `FillInstruction` message then travels via
LayerZero to Soroban. By the time it arrives and the solver can call
`fill_intent`, the Stellar clock reads:

```
T_stellar = T_evm_at_lock + T_relay + Δ_skew
           ≈ (D − ε)        +  T_relay  +  Δ_skew
```

For the fill to succeed, `T_stellar < D` is required:

```
(D − ε) + T_relay + Δ_skew  <  D
                 T_relay + Δ_skew  <  ε
```

This means a solver **must not lock** an intent unless there are at least
`T_relay + Δ_skew_worst` seconds remaining before the deadline. If `ε < T_relay
+ Δ_skew_worst`, the FillInstruction will arrive on Soroban after the Stellar
clock has already passed `D`, and `fill_intent` will revert with `IntentExpired`
— even though the solver held a perfectly valid lock on EVM. The solver's locked
funds are protected (they recover via `cancelExpired` after the grace window), but
the solver has wasted gas and locking time with no possibility of earning a fill.

This is a **solver-side liveness constraint**, not a protocol safety property —
no user funds are at risk. `confirmationGrace` does not protect against this
scenario: it governs when the EVM local-refund path opens, not when Soroban
rejects a fill.

---

## 3. The Latency Budget

The full sequence of events from lock to EVM release is:

```
[EVM lock]
    │  T_relay: LayerZero DVN attestation + executor delivery
    ▼
[Soroban FillInstruction received → fill_intent called]
    │  T_soroban_confirm: Soroban ledger close (~5 s) + confirmation buffer
    ▼
[FillConfirmed dispatched via LayerZero]
    │  T_relay_return: LayerZero return trip
    ▼
[EVM lzReceive → escrow releases funds to solver]
```

For the `confirmationGrace` constraint the relevant leg is the **outbound
FillConfirmed return trip**: if the solver fills on Soroban right at `deadline`,
the FillConfirmed must still arrive on EVM before `cancelExpired` becomes
callable at `deadline + confirmationGrace`. So:

```
confirmationGrace  >  T_relay_p99  +  T_soroban_confirm  +  Δ_skew_worst
```

### 3.1 Component values

| Component | Value | Source |
|-----------|-------|--------|
| `T_relay_p99` | 600 s (10 min) | `./MONITORING.md` — SLA baseline is 10 min; alert triggers at 20 min P95 |
| `T_soroban_confirm` | 30 s | `./ECONOMICS.md` — "5–30 seconds per transaction + 30 second confirmation" |
| `Δ_skew_worst` | 60 s | §2.1 above |
| **Required minimum** | **690 s ≈ 11.5 min** | Sum of the above |

### 3.2 The dispatch cutoff and the latency budget `L`

The Soroban settlement contract does not allow a fill arbitrarily close to the
deadline. `fill_intent` rejects when `now + MIN_DISPATCH_WINDOW > deadline`, so
the latest instant at which a fill can be dispatched is:

```
dispatch cutoff  =  deadline − MIN_DISPATCH_WINDOW
```

A FillConfirmed dispatched at that cutoff still has to traverse the outbound
LayerZero leg (DVN verification + executor delivery) and the Soroban
confirmation buffer before it lands on EVM. If the EVM refund path opens at
`deadline + MIN_CONFIRMATION_GRACE` and the return trip takes up to `L`
seconds, the message can arrive *after* `cancelExpired` has already refunded the
user — the solver delivered on Soroban, the escrow refunded the user, and the
solver loses principal.

To close that race the protocol reserves an explicit **cross-chain latency
budget `L`** between the dispatch cutoff and the EVM refund opening:

```
MIN_CONFIRMATION_GRACE  ≥  MIN_DISPATCH_WINDOW  +  L
```

Equivalently, the effective dispatch cutoff relative to the EVM grace is:

```
dispatch cutoff  =  deadline + MIN_CONFIRMATION_GRACE − L − MIN_DISPATCH_WINDOW
```

which must be `≤ deadline` for the margin to be non-negative. The margin
`MIN_CONFIRMATION_GRACE − MIN_DISPATCH_WINDOW` is the slack available for the
return trip; it must be at least `L`.

`L` is defined as `CROSS_CHAIN_LATENCY_BUDGET` and is sized against the
LayerZero DVN and executor SLAs:

| Component of `L` | Value | Source |
|------------------|-------|--------|
| LayerZero DVN verification + executor delivery (P99) | 600 s (10 min) | `./MONITORING.md` — baseline SLA 10 min |
| Soroban confirmation buffer | 30 s | `./ECONOMICS.md` — 30 s confirmation |
| Clock skew `Δ_skew_worst` | 60 s | §2.1 above |
| Safety headroom (retries, congestion) | 510 s | 2× the relay SLA minus the above |
| **`CROSS_CHAIN_LATENCY_BUDGET` (`L`)** | **1 200 s (20 min)** | Sum of the above |

The 20-minute budget is deliberately larger than the 690 s hard minimum derived
in §3.1: it covers the P95 alert threshold (20 min) from `./MONITORING.md`
rather than only the 10-minute baseline SLA, so a message that trips the
monitoring alert still lands before the refund path opens.

### 3.3 Current parameter values vs. the bound

| Parameter | Current value | Required minimum | Status |
|-----------|---------------|-----------------|--------|
| `MIN_DISPATCH_WINDOW` (`lib.rs`) | 1 800 s (30 min) | — | Dispatch cutoff anchor |
| `MIN_CONFIRMATION_GRACE` (`PerihelionEscrow.sol`) | 1 800 s (30 min) | `MIN_DISPATCH_WINDOW + L` = 3 000 s | ⚠️ **INSUFFICIENT** — margin is 0 s, not `L` |
| Default `confirmationGrace` | 7 200 s (2 h) | `MIN_DISPATCH_WINDOW + L` = 3 000 s | ✅ SUFFICIENT — 4 200 s margin over `L` |
| `MAX_CONFIRMATION_GRACE` | 604 800 s (7 days) | — | ✅ (upper bound, not a safety floor) |

With the current constants the margin
`MIN_CONFIRMATION_GRACE − MIN_DISPATCH_WINDOW` is **0 s**, so a FillConfirmed
dispatched at `deadline + 1 799 s` on Stellar has no budget for DVN verification
and executor delivery before `cancelExpired` opens at `deadline + 1 800 s`. The
fix is to raise `MIN_CONFIRMATION_GRACE` to `MIN_DISPATCH_WINDOW + L`
(3 000 s), or to shorten the dispatch window by `L` so the cutoff is
`deadline − MIN_DISPATCH_WINDOW` with `MIN_CONFIRMATION_GRACE ≥
MIN_DISPATCH_WINDOW + L` still holding. Either way the inequality above must
hold with a strictly positive margin of at least `L`.

### 3.4 Enforcement: cross-language constant test

The inequality is encoded in a shared constant test that reads both
`contracts/evm/src/PerihelionEscrow.sol` and
`contracts/soroban/settlement/src/lib.rs` and asserts:

```
MIN_CONFIRMATION_GRACE  ≥  MIN_DISPATCH_WINDOW  +  CROSS_CHAIN_LATENCY_BUDGET
```

The test fails if either constant changes without the other, so the two windows
cannot drift apart silently. Any change to `MIN_DISPATCH_WINDOW`,
`MIN_CONFIRMATION_GRACE`, or `CROSS_CHAIN_LATENCY_BUDGET` must be made together
and must update this document.

### 3.3 `GRACE_LEDGERS` is a TTL parameter, not a safety parameter

`GRACE_LEDGERS = 120_960` (Soroban, `lib.rs`) translates to approximately 7 days
at the nominal 5 s/ledger close rate. It is used exclusively in
`ttl_for_deadline` to over-provision the storage TTL of an intent record so that
a late FillConfirmed still has a live record to confirm against. It has no
connection to the `confirmationGrace` safety constraint. Changing `GRACE_LEDGERS`
affects how long an intent's on-chain storage entry lives after its deadline; it
does not affect when any fill or cancel is accepted or rejected.

---

## 4. Monotonicity and Backward-Movement Handling

### 4.1 EVM

Ethereum's block timestamp is strictly monotone per block: `block.timestamp >
parent.timestamp` is a consensus rule. Backward movement can only appear in
the application's view during a chain reorganisation, where the canonical tip
switches to a fork with a different tip timestamp. Because all EVM deadline
checks use `block.timestamp` directly (not a stored previous value), a reorg
that replaces the current tip with one having a lower timestamp simply re-opens a
window that had just closed. This is safe: the deadline check in `lock()` and
`cancelExpired()` re-evaluates from the current block's timestamp on every call,
so no persistent corrupted state can result from a reorg affecting the timestamp.

### 4.2 Soroban

Stellar ledger timestamps are strictly monotone per ledger by consensus rule.
There is no analog of a Soroban "reorg" that would present a lower timestamp to
a running contract. The contract takes no special action for backward movement
because the Stellar protocol guarantees it cannot occur.

### 4.3 SDK client clock

`Date.now()` is not guaranteed monotone. The SDK's `isExpired` and
`isRefundable` are both pure comparisons — they re-evaluate on every call with no
cached previous value, so a step backward in the client clock produces a
conservative result (the intent looks less expired) rather than any corrupted
state. This is the safe direction for both the solver (avoid filling an intent
the chain will reject as expired) and the user (avoid suggesting a refund that
the contract will reject as premature).

---

## 5. Solver-Side Constraint: Minimum Time-Before-Deadline

From §2.2, a solver should refuse to lock an intent unless the remaining time
before the deadline exceeds the round-trip messaging latency plus the clock-skew
budget:

```
ε_min  =  T_relay_p99  +  Δ_skew_worst
       =  600 s        +  60 s
       =  660 s  ≈  11 minutes
```

A solver that observes `intent.deadline - chain_now < 660 s` should **skip the
intent** — locking it will consume EVM gas and lock user funds, but the
FillInstruction will arrive on Soroban after the Stellar clock has passed the
deadline, making the fill impossible without any possibility of recovery.

The 660 s figure bounds the relay leg only. The Soroban settlement contract
enforces a stricter guard on dispatch: `fill_intent` rejects when
`now + MIN_DISPATCH_WINDOW > deadline`, with `MIN_DISPATCH_WINDOW = 1 800 s`
(`contracts/soroban/settlement/src/lib.rs`). A solver must therefore also refuse
any intent with less than 1 800 s remaining, and the SDK exports
`MIN_FILL_HEADROOM_SECS = 1 920 s` (1 800 s window + 120 s margin) for this
purpose. Whichever constraint is larger governs the solver's lock decision; in
practice that is the dispatch window.

This constraint is enforced off-chain (in the solver's evaluation logic) rather
than in the EVM contract. The EVM escrow deliberately allows locking right up to
`deadline - 1` because it cannot know about relay latency or Stellar's clock; the
safety of the fill path is the solver's responsibility.

### 5.1 Relationship to `isExpired` clock skew

`isExpired(intent, now, clockSkew)` in `sdk/src/intent.ts` implements this guard
via the `clockSkew` parameter. With a **positive** `clockSkew`, the function
behaves as if the clock is `clockSkew` seconds slower — it declares an intent
expired only once `now > deadline + clockSkew`, providing a buffer.

To satisfy the constraint above, a solver using its own wall clock as `now`
should set:

```
clockSkew  ≥  ε_min  =  660 s  (≈ 11 minutes)
```

The JSDoc for `isExpired` previously suggested `+30` as the recommended solver
value. That value (30 s) is less than `Δ_skew_worst` alone (60 s) and far less
than the full `ε_min` (660 s). The correct recommendation, derived here, is
**+660 s** for solver fill-path guards. See the updated JSDoc on `isExpired` for
the corrected guidance.

If a solver uses a chain-sourced timestamp for `now` (e.g. the latest EVM block
timestamp or the Soroban ledger timestamp) rather than its wall clock, the
`clockSkew` still needs to account for `T_relay_p99` because the relay latency is
independent of clock accuracy. In that case the appropriate value is still 660 s
(relay latency dominates; the chain-clock component collapses to near zero).

---

## 6. SDK `isRefundable` and the Client-Clock Tolerance

`PerihelionClient.isRefundable(record, confirmationGraceMs)` declares an intent
refundable when:

```
Date.now() / 1000  ≥  record.deadline + confirmationGrace
```

The client wall clock may drift up to ±60 s from the EVM `block.timestamp`.
Because `confirmationGrace` is at least 1 800 s (30 min) and the clock drift is
at most 60 s, the worst-case client-clock error is less than 4% of the grace
window. This is acceptable: a user who calls `isRefundable` 60 s too early will
find the contract rejects `cancelExpired` with `DeadlineNotPassed`; no funds are
at risk. For higher confidence, callers can pass a chain-sourced timestamp as a
substitute for `Date.now()` if their environment supports it.

The `confirmationGraceMs` parameter has no default; callers must pass the live
value read from the contract (`confirmationGrace()`, in seconds, converted to
milliseconds). The contract's initial value is 2 h, but if the deployed contract
has been reconfigured via `setConfirmationGrace`, the caller is responsible for
passing the current value. A mismatch results only in a
premature or delayed refund suggestion, not fund loss.

---

## 7. Summary of Findings

| Finding | Verdict |
|---------|---------|
| `MIN_CONFIRMATION_GRACE` (1 800 s) vs. required minimum (690 s) | ✅ Sufficient — 2.6× headroom |
| `MIN_CONFIRMATION_GRACE` (1 800 s) vs. `MIN_DISPATCH_WINDOW + L` (3 000 s) | ⚠️ **Insufficient** — margin is 0 s; see §3.2–§3.4 |
| Default `confirmationGrace` (7 200 s) vs. required minimum (690 s) | ✅ Sufficient — 10× headroom |
| Default `confirmationGrace` (7 200 s) vs. `MIN_DISPATCH_WINDOW + L` (3 000 s) | ✅ Sufficient — 4 200 s margin over `L` |
| `GRACE_LEDGERS` (TTL parameter only) — no safety bound required | ✅ Not applicable |
| SDK `isExpired` JSDoc recommendation (+30 s) vs. derived ε\_min (660 s) | ⚠️ **Under-specified** — see §5.1 and the updated JSDoc; no contract change needed |
| `isRefundable` client-clock tolerance (±60 s vs. 1 800 s grace) | ✅ Acceptable |
| EVM block.timestamp monotonicity and reorg handling | ✅ Safe by design |
| Stellar ledger timestamp monotonicity | ✅ Guaranteed by SCP consensus |
| SDK wall-clock backward-movement handling | ✅ Conservative by design |

**Contract changes are required.** The default `confirmationGrace` satisfies the
derived bounds, but `MIN_CONFIRMATION_GRACE` (1 800 s) equals
`MIN_DISPATCH_WINDOW` (1 800 s), leaving a zero-second margin for the outbound
LayerZero return trip. The inequality
`MIN_CONFIRMATION_GRACE ≥ MIN_DISPATCH_WINDOW + CROSS_CHAIN_LATENCY_BUDGET`
(§3.2) must hold with `L = 1 200 s`, and the cross-language constant test
(§3.4) enforces it. The corrected `isExpired` JSDoc (in `sdk/src/intent.ts`)
cites this document and gives the solver-path recommendation of +660 s rather
than +30 s.

---

## 8. Consistency Check Against Existing Latency References

The latency figures used in §3.1 are drawn from existing protocol documentation
and are listed here for cross-reference.

| Reference | Cited value | Used as |
|-----------|-------------|---------|
| `./MONITORING.md` — Alert M1 | "Baseline SLA: 10 minutes for inter-chain messages" | `T_relay_p99 = 600 s` |
| `./MONITORING.md` — Alert M1 | "Alert threshold: > 20 minutes (P95)" | Upper bound; `T_relay_p99` is conservative |
| `./ECONOMICS.md` | "Settlement latency: 5–30 seconds per transaction + 30 second confirmation" | `T_soroban_confirm = 30 s` |
| `./TECHNICAL-ARCHITECTURE.md` §4.3 | "confirmationGrace window must exceed worst-case cross-chain latency (LayerZero relay + Stellar finality)" | Formal derivation of what that bound is |
| `./deployment.md` | "confirmationGrace: A few hours; must exceed worst-case LayerZero delivery time" | Qualitative; now quantified above |
| `./incident-response.md` | "Intent unresolved for > 2 × confirmationGrace → P1" | Alert calibration consistent with 2 h default |
| `./MONITORING.md` | "MessageUndelivered: not relayed within 12 hours → P1" | Consistent: 12 h >> 2 h confirmationGrace |

No inconsistencies were found. The monitoring alert thresholds and the grace
parameters are calibrated to the same underlying latency model.
