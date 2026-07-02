# Perihelion Threat Model & Trust Assumptions

This is the **single source of truth** for Perihelion's trust model. It
enumerates every protocol role, what each is trusted for, what each can do if
compromised, and which mechanism bounds the damage. Cross-reference with the
threat matrix (T1–T10) in
[TECHNICAL-ARCHITECTURE.md §6](./TECHNICAL-ARCHITECTURE.md#6-security-model--threat-matrix),
and with [deployment.md](./deployment.md) for operational roles.

---

## 0. Consolidated trust model

| Role | Trusted assumption | Misbehavior if compromised | Worst-case impact | Bounding mechanism |
|---|---|---|---|---|
| **User** | Picks `minDestAmount` and `deadline` correctly, protects their signing key | Poor choice → fill below market or expired; lost key → cannot refund | Grief (user loses opportunity cost, not principal) | I1: always refunded if not filled; I2: single settlement |
| **Solver** | Fronts honest liquidity; does not fill invalid intents | Fills an intent not backed by a lock (unprofitable; no risk to user) | Grief (solver loses gas) | I3: solver fronts liquidity, repaid only against verified lock |
| **Relayer** | Forwards messages promptly; cannot forge | Censors or delays delivery; cannot forge a valid message | Censor/delay (temporary liveness loss for FillInstruction, CancelIntent, FillConfirmed) | Permissionless: anyone can relay; LZ endpoint enforces message authenticity and replay guard |
| **LayerZero endpoint** | Enforces the OApp's DVN/ULN config; calls `lzReceive` only for verified messages | Accepts unverified messages (bypasses DVN set) | **Steal** (forge a FillConfirmed → release solver funds without a Stellar fill) | `msg.sender == address(endpoint)` guard in `lzReceive`; endpoint trust is the strongest assumption |
| **DVN set** (LayerZero verifiers) | ≥ threshold DVNs attest the same source event honestly | A colluding DVN set attests a fake source event | **Steal** (forge a FillConfirmed or CancelIntent) | Multi-DVN with 2 required + 1 optional (≥3 distinct verifiers on common path); OApp admin can rotate set |
| **Stellar validators** | Produce canonical ledger state with economic finality | A cartel finalizes a fraudulent Stellar ledger | **Steal** (forge a fill on Stellar that the Solver never actually funded); destroy the bridge's Stellar-side correctness | Stellar's consensus (Stellar Consensus Protocol); Perihelion inherits Stellar's finality guarantees |
| **Admin / timelock owner set** (EVM) | Only executes governance actions the M-of-N honestly agreed to | Threshold of owners collude to rotate peer, drain escrow | **Steal** (change `stellarPeer` → forge inbound messages, or `setGuardian` + `pause` to censor, or `transferOwnership` to drain) | M-of-N timelock with delay: any config change is public for `delay` seconds before it executes; a single honest owner can `cancel`; GRACE_PERIOD limits stale-op window |
| **Admin** (Soroban) | Configures endpoint, peer, and pause correctly | Sets a malicious endpoint/peer → steals Stellar-side funds | **Steal** (redirect settlement messages) | Single-key admin on Soroban (future: migrate to multisig); bounded by `cancel_expired_intent` liveness |
| **Guardian** (EVM) | Only pauses in genuine emergencies | Pauses repeatedly, denying new locks and refunds | Censor (denial of new locks and local refunds for up to 72 h per 144 h cycle) | Auto-expiry (GUARDIAN_PAUSE_TTL) + cooldown; cannot unpause, move funds, or change config |
| **Executor** (LayerZero delivery) | Delivers committed messages | Drops execution, censors delivery | Censor/delay | Permissionless: anyone can call `lzReceive` for a committed message; executor is replaceable |

### Key explicit assumptions

1. **LayerZero DVN integrity.** The DVN set is the root of cross-chain message
   authenticity. If the configured DVNs collude, they can forge any message.
   Perihelion does not add a second verification layer — it trusts the DVN set
   (see Phase 3 roadmap for ZK proofs to remove this assumption).
2. **Stellar consensus finality.** The Soroban contract trusts Stellar validator
   consensus. A Stellar fork or reorg deeper than the DVN block-confirmation
   count could produce conflicting state. Perihelion relies on Stellar's
   economic finality guarantees (Stellar Consensus Protocol).
3. **EVM chain finality.** The EVM escrow trusts the EVM chain's finality. The
   LayerZero DVN block-confirmation parameter (≥15 blocks on Ethereum) is the
   defense against EVM reorgs.
4. **Deterministic EVM bytecode.** Given the pinned compiler version and
   optimizer settings in `foundry.toml`, the compiled bytecode is deterministic.
   See [deployment.md](./deployment.md#reproducible-builds--explorer-verification)
   and the `reproducible-bytecode.yml` CI job.
5. **EVM-address-based identity.** All EVM role checks (`onlyOwner`,
   `onlyGuardian`, etc.) are address-based. If an address's private key is
   compromised, the associated role is compromised.

### What the protocol guarantees regardless of any single role's compromise

| Guarantee | Rationale |
|-----------|-----------|
| **No user fund loss** (I1) | A user is either settled on Stellar or refunded in full. The terminal-flag guard (`released`/`refunded`) in the escrow ensures at most one terminal action per lock. |
| **Single settlement** (I2) | The `intent_hash` idempotency key on both chains prevents double-fill or double-refund. |
| **Solver fronts liquidity** (I3) | The solver delivers destination assets from its own inventory before being repaid. No unbacked payout. |
| **Permissionless liveness** (I4) | Refund/cancel paths are callable by anyone — users, keepers, or other solvers. No privileged actor can strand funds. |
| **Guardian cannot steal** | `pause()` is the only guardian-callable state change. No funds move, no config changes. |
| **Relayer cannot forge** | The endpoint's `msg.sender` check and `stellarPeer` authentication prevent relayers from injecting unauthenticated messages. |

### Replay and ordering

- **LayerZero transport nonce** prevents the same message from being delivered
  twice at the destination. Nonces are tracked per `(srcEid, sender)` pathway
  with a bitmap supporting unordered delivery.
- **Intent nonce** (256-bit) is an application-level collision-prevention value
  that distinguishes otherwise-identical intents. It is NOT a replay-protection
  nonce — that is the LayerZero transport nonce's job.

---

The remainder of this document captures discrete threat findings with mitigation rationale.
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
