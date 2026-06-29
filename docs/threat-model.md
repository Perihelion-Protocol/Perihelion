# Perihelion EVM Threat Model

This document captures discrete threat findings with mitigation rationale.
The broader threat matrix (T1–T10) lives in
[TECHNICAL-ARCHITECTURE.md §6](./TECHNICAL-ARCHITECTURE.md#6-security-model--threat-matrix).

---

## T11 — Guardian-key DoS via repeated instant pause

### Threat

**Vector:** A leaked guardian key calls `pause()` repeatedly, keeping the
protocol indefinitely halted despite owner attempts to unpause.

**Why it matters:** The guardian is intentionally a hot key — it can call
`pause()` instantly. Unpausing requires the owner (which in production is a
multisig timelock), so unpausing must go through:

```
propose → confirm(s) → wait delay → execute
```

Because pausing is O(1) and unpausing costs the full timelock delay, a
compromised guardian can re-pause the instant each unpause executes. The
result is indefinite denial-of-service against all new `lock()` calls and
local `cancelExpired()` refunds, with zero ongoing cost to the attacker.

**In-flight funds are safe:** `lzReceive` is not gated by `whenNotPaused`, so
a FillConfirmed or CancelIntent message from Stellar still releases or refunds
while the protocol is paused. No locked funds are permanently stranded.

**Scope of damage:** Liveness only — no user funds can be stolen via
`pause()`. But indefinite halt is a material impact: users cannot initiate new
transfers and cannot claim expired-intent refunds via the local fallback.

### Mitigation: auto-expiry + guardian cooldown

Guardian-initiated pauses auto-expire after `GUARDIAN_PAUSE_TTL` (72 hours)
unless the owner ratifies them. After a TTL-expired pause is dismissed, the
guardian is locked out for another `GUARDIAN_PAUSE_TTL` (cooldown).

**Key properties:**

| Property | Behaviour |
|----------|-----------|
| Guardian pause | Sets `guardianPauseExpiry = now + 72h` |
| Owner ratification | Owner calls `setPaused(true)` → converts to indefinite owner pause (clears `guardianPauseExpiry`) |
| Auto-dismiss | Anyone calls `decayGuardianPause()` after `guardianPauseExpiry` → protocol resumes; `guardianPauseCooldownUntil = now + 72h` set |
| Cooldown | Guardian cannot call `pause()` while `block.timestamp < guardianPauseCooldownUntil` |
| Owner unpause | Owner calls `setPaused(false)` → clears expiry AND cooldown (guardian stays operational) |
| Owner pause | Owner calling `pause()` directly sets `guardianPauseExpiry = 0` (no auto-expiry) |

**Worst-case duty cycle with a fully compromised guardian key:** ≤50%.
The guardian can force at most 72 h of downtime per 144 h window (72 h pause
TTL + 72 h cooldown). The community has a 72-hour window per cycle to detect
the leak and rotate the guardian key via the timelock.

### Trade-offs considered

| Approach | Chosen? | Rationale |
|----------|---------|-----------|
| Auto-expiry only (no cooldown) | No | Guardian can re-pause immediately after each expiry, maintaining >50% downtime |
| Cooldown only (no expiry) | No | Guardian can still hold a single pause indefinitely without the TTL forcing dismissal |
| Auto-expiry + cooldown | **Yes** | Each TTL-expired pause opens a fixed window for key rotation before the guardian can act again |
| Fast-path owner unpause bypassing timelock | Deferred | Would require timelock changes and introduces a new privileged path; the 72 h TTL is an acceptable short-term bound |

### Residual risk

**Medium → Low.** A fully compromised guardian key can still inflict up to
72 h of downtime per 144 h cycle — meaningful for a live bridge. The
mitigation narrows the attack to a known, bounded window and provides a
reliable rotation opportunity every cycle.

Operators should treat the `guardianPauseCooldownUntil` state as a canary:
if it is non-zero in production unexpectedly, the guardian key should be
considered compromised and rotated immediately via the timelock.

### Implementation

- `PerihelionEscrow.sol`: `GUARDIAN_PAUSE_TTL`, `guardianPauseExpiry`,
  `guardianPauseCooldownUntil`, `decayGuardianPause()`, updated `pause()` and
  `setPaused()`.
- Tests: `test/PerihelionEscrow.t.sol` — `test_GuardianPause_*` and
  `test_DecayGuardianPause_*` functions.

---

## T12 — Missing EIP-5267 domain introspection

### Threat

**Vector:** Wallets and off-chain tooling cannot query the contract's EIP-712
domain fields; integrators must hard-code `name`, `version`, `chainId`, and
`verifyingContract` or infer them from chain state. Any mismatch produces
signatures the escrow silently rejects with `InvalidSignature`, with no
on-chain indication of why.

**Scope:** Liveness / integration correctness. No funds can be stolen — a bad
domain only causes rejected signatures, not spurious releases.

### Mitigation

`eip712Domain()` (EIP-5267) is implemented and returns the exact fields used
by `hashIntent`. A test pins the reconstructed domain separator against
`DOMAIN_SEPARATOR`, ensuring they can never drift apart silently.

### Residual risk

**Low.** Standard wallets and `ethers.js`/`viem` already support EIP-5267
discovery; the risk collapses to wallets that bypass the standard, which is
an integrator error rather than a protocol vulnerability.

---

## T13 — Reentrancy guard cold-SSTORE overhead

### Threat

**Vector:** Not a safety threat — a gas-efficiency issue. The original
`nonReentrant` modifier used sentinels `0` (unlocked) and `1` (locked),
resetting the slot to `0` after each call. An EVM storage slot transitioning
`0 → non-zero` costs `SSTORE_SET` (20,000 gas, cold); each call to `lock()`,
`lzReceive()`, or `cancelExpired()` paid this penalty.

**Impact:** ~17,100 gas wasted per guarded call (difference between
`SSTORE_SET` = 20,000 and `SSTORE_RESET` = 2,900 for a cold non-zero → non-zero
write). On a busy bridge this compounds to meaningful ETH.

### Mitigation

Sentinels changed to `NOT_ENTERED = 1` and `ENTERED = 2`. The slot is
initialized to `1` in the constructor and never returns to `0`, so every
lock/unlock is a warm `SSTORE_RESET` (2,900 gas) rather than a cold
`SSTORE_SET` (20,000 gas). This is the same pattern used by OpenZeppelin's
`ReentrancyGuard` since v4.

### Residual risk

**None.** The functional behaviour is unchanged; reentrancy still reverts
with `Reentrancy()`. The slot invariant (never 0 post-construction) is
verified in the test suite.
