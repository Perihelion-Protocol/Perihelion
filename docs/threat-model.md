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
| **Admin / timelock owner set** (EVM) | Only executes governance actions the M-of-N honestly agreed to | Threshold of owners collude to rotate peer, or call `skim` to drain any token balance the escrow holds | **Steal, unbounded** — `skim` has no on-chain accounting tying it to actual surplus, so it is not limited to the drain scenarios above ([T17](#t17--governance-extractable-escrow-balance)) | M-of-N timelock with delay: any config change (including a `skim` proposal) is public for `delay` seconds before it executes — **but this is a detection window, not a prevention**: a single owner can also unilaterally `cancel` a *legitimate recovery* action ([T20](#t20--governance-liveness)), and the refund path is itself pausable during the delay ([T19](#t19--refund-denial-via-pause)) |
| **Admin** (Soroban) | Configures endpoint, peer, and pause correctly | Sets a malicious endpoint/peer → steals Stellar-side funds | **Steal** (redirect settlement messages) | `set_peer` requires a 1-day propose/confirm delay; **`set_endpoint` does not — it takes effect instantly** ([T18](#t18--instant-endpoint-rotation-on-soroban)). Single-key admin on Soroban (future: migrate to multisig); refund liveness (`cancel_expired_intent`) is itself pausable ([T19](#t19--refund-denial-via-pause)) |
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

---

## T14 — User under-delivery via low `minDestAmount` floor

### Threat

**Vector:** A user signs an intent with a `minDestAmount` that is economically
unsound (e.g., set by a buggy SDK, front-end, or malicious wallet), and a
solver legally fills it by delivering exactly `minDestAmount` while taking a
large spread. The protocol guarantees the user receives ≥ `minDestAmount`, but
does not prevent the gap between what the user locked (`sourceAmount`) and what
they receive (`minDestAmount`) from being unreasonably large.

**Example:** User locks 1,000 USDC on Ethereum (aiming for ~1,000 USDC on Stellar)
but a buggy front-end sets `minDestAmount = 100 USDC` (1% of the locked amount). A
solver legally fills the intent, delivering 100 USDC and keeping 900 USDC as
spread. The user has no on-chain recourse — they accepted those terms when they
signed `minDestAmount = 100`.

**Why it matters:** The protocol's sole on-chain protection against this is
`minDestAmount`. Off-chain, it is the user's sole responsibility to set an
economically sane floor. But the responsibility boundary is unclear:
- A buggy SDK can set a default floor that is too low
- A malicious or buggy front-end can override the floor with a low value
- Wallet integrations that construct intents may not validate the floor

The threat model does not currently address this, leaving an implicit
responsibility-assignment gap.

### Mitigation: Documented invariant + off-chain + optional on-chain bounds

**The value-delivery invariant** (formally documented):
- The protocol guarantees: `filled_amount ≥ minDestAmount` (always true)
- The protocol does NOT guarantee: `filled_amount ≈ fair_market_rate(sourceAmount)`
- Floor-setting is the user's sole responsibility
- The spread (sourceAmount → minDestAmount gap) is the solver's compensation
  and is entirely determined by the user's choice of `minDestAmount`

**Off-chain protections** (SDK, front-end, wallet layer):
1. **SDK validation** (issue #8): Before signing, validate that `minDestAmount`
   is economically sane:
   - Estimate a fair market-rate destination amount from the source amount
     (using an oracle or reference price)
   - Reject if `minDestAmount < fair_rate * slippage_tolerance` (e.g.,
     `slippage_tolerance = 0.95` means ≥95% of fair value)
   - Emit a warning if the spread exceeds a configurable threshold
   - Document the assumption that the user has access to an accurate price feed

2. **Front-end guidance**: Display the estimated fair value and the chosen
   `minDestAmount` side-by-side; highlight when the gap is large (e.g., >2%)

3. **Wallet best practices**: Wallets should either use the SDK's validated
   intent builder or implement equivalent price validation before signing

**On-chain bounds** (optional, requires architecture decisions):
- A reference-price sanity check (requires an oracle or inclusion of a signed
  price feed in the intent)
- Rejected as a hard requirement in Phase 1 because it introduces a new
  trusted source (the oracle); Phase 2 may add this as an optional parameter

### Trade-offs considered

| Approach | Chosen? | Rationale |
|----------|---------|-----------|
| Hard on-chain floor bound (oracle-based) | No / Phase 2 | Requires a trusted oracle; adds protocol complexity; Phase 2 roadmap includes optional ZK pricing proofs |
| Soft SDK validation + warnings | **Yes** | Catches the most common case (buggy SDK); places the burden on the party best positioned to validate (off-chain integrators); lowers the barrier to Phase 1 launch |
| Front-end UX (side-by-side display) | **Yes** | Helps power users spot bad floors; cannot prevent a determined user from accepting them, but makes the choice explicit |
| Threat-model documentation | **Yes** | Clarifies the responsibility boundary and the protocol's guarantee (≥ floor, not ≈ fair value) so integrators know what they must implement |

### Residual risk

**Medium → Low.** Off-chain integrators (SDKs, front-ends, wallets) bear the
responsibility to validate floors. This is acceptable given:
- The SDK will implement automated validation (issue #8)
- Front-end UX makes the choice explicit
- The protocol's guarantee is precise and documented
- Users who choose a low floor despite warnings lose opportunity cost, not
  principal (all funds are locked and refundable if not claimed)

Residual exposure comes from:
1. Integrators that skip validation (risk: user under-delivery)
2. A compromised or malicious front-end that forces a low floor (risk: same,
   but intentional)
3. Oracles that become stale or compromised (risk if Phase 2 adds oracle-based
   bounds, mitigated by treating the oracle as a circuit-breaker with wide
   tolerance)

**Operational note for teams deploying a front-end:** The front-end should
always query an oracle or reference price before rendering an intent signature
prompt. If no price is available, block the user from proceeding. Document this
as a required integration step.

### Implementation notes

- **SDK** (issue #8): `buildIntent` validates `minDestAmount` against a
  reference price before returning the intent object
- **Threat model:** This section documents the invariant and the responsibility
  boundary
- **Docs:** `intent-spec.md` already documents `minDestAmount` semantics;
  reference this section for the threat context
- **Testing:** SDK tests verify that validation rejects floors below the
  threshold and accepts fair-value floors

---

## T15 — Front-running of pause bypass & telegraphed timelock actions

### Threat

**Vector 1: Pause does not stop releases**

The guardian `pause()` halts new `lock()` calls and local `cancelExpired()` refunds,
but **does not gate `lzReceive`** (LayerZero inbound settlement). This is intentional:
in-flight FillConfirmed/CancelIntent messages should complete even while the protocol
is paused, so users' funds are not stranded mid-transfer.

However, an attacker mid-exploit who has a malicious or forged FillConfirmed queued
in the LayerZero message pool can still drain the escrow via the inbound path even
after the guardian pauses. The pause stops the *source* side (no new locks), but not
the *destination* side (releases still happen).

**Timeline of concern:**

```
T=0:  Attacker detects vulnerability in solver or contract
T=1:  Attacker crafts a malicious FillConfirmed or forges one (requires DVN compromise)
T=2:  Attacker queues the message in LayerZero (pending delivery)
T=3:  Guardian detects the exploit and calls pause()
      → new locks are blocked
      → but the queued FillConfirmed still releases funds when lzReceive executes
T=4:  Attacker calls lzReceive() to trigger delivery and drain the escrow
      → release succeeds, funds exit the bridge
```

**Worst case:** If a DVN is compromised or LayerZero is exploited, an attacker can
forge a FillConfirmed, queue it before any detection, and execute it even after
pause. The pause window gives the team no ability to stop that specific drain.

**Vector 2: Telegraphed timelock actions**

Every timelocked admin action (peer rotation, grace change, guardian swap, unpause)
is public the moment it is proposed. The message is on-chain for the delay window
(typically 48 hours), and an attacker can:

1. **Front-run the action:** Observe the proposal, craft a transaction that exploits
   the new configuration, and submit it the instant the action executes (same block
   or next block)
2. **Front-run the action's impact:** If peer rotation is proposed, an attacker can
   front-run by executing a malicious fill with the old peer, locking in a bad state
   before the peer changes
3. **React to the proposal:** Knowing a guardian rotation is coming, an attacker with
   a leaked guardian key can exhaust the remaining guardian pause window before being
   rotated out

**Scope of exposure:** The protocol guarantees that users get ≥`minDestAmount` and
that funds are refundable if not claimed. These guarantees are not broken by
front-running. But liveness and efficiency are affected:
- A paused-while-draining scenario could strand in-flight funds temporarily
- A rotated-peer front-run could cause failed settlement if the new peer is unknown
  to the attacker
- A rotated-guardian front-run exhaust could deny emergency pause capability

### Analysis & Stance

**Pause excludes releases: Design decision rationale**

The protocol intentionally does not gate `lzReceive` by pause because:
1. **Funds safety:** In-flight transfers must complete; users' funds must never be
   stranded waiting for the protocol to unpause
2. **Liveness:** Pausing is meant to halt *new* activity, not destroy *in-progress*
   activity
3. **Recovery from non-exploit issues:** If a pause is triggered by, e.g., a relayer
   DoS or temporary LayerZero issue (not an active drain), unpausing and completing
   in-flight settlement is the fast path to recovery

**Trade-off accepted:** An exploit that has a queued malicious FillConfirmed could
drain even while paused. This is a known risk because:
- The DVN set is a strong trust assumption; a DVN compromise is a worse scenario
  than any single message drain
- If the DVN is compromised, no amount of pause logic can stop the drain; the only
  defense is architecture (peer verification, value caps, secondary checks), not gates
- The pause is meant to buy time for investigation, not to provide cryptographic
  protection against a compromised DVN

**Emergency release-halt control: Deferred to Phase 2**

An alternative design would add a separate emergency-control to halt *all* releases
(including in-flight), accepting that some in-flight transfers would be stranded.
This control is deferred because:
- It introduces a second pause state (global pause vs. message-halt pause)
- It increases operational complexity (when to use which pause?)
- The current pause + DDL circuit breaker (if implemented) provides adequate
  protection: a single drain is capped, and the pause buys time

This will be reconsidered in Phase 2 if incident data suggests a need.

**Telegraphed timelock actions: Accepted architectural constraint**

Timelock delay is intentionally public:
1. **Governance principle:** Users (and external auditors) can see every admin
   action and object before it takes effect; no surprises
2. **Dispute window:** If a proposal is contentious, the window is wide enough for
   governance coordination
3. **On-chain transparency:** Public proposals are part of the design, not a flaw

**Mitigation against front-running of specific actions:**

| Action | Front-run vector | Mitigation |
|--------|-----------------|-----------|
| **Peer rotation** | Attacker uses old peer to fill before new peer takes effect | Peer change is backward-compatible (escrow accepts fills from both old and new peer during a grace window if implemented) |
| **Grace period change** | Attacker changes timing constraints during delay window | Grace period is monotonic (only increases or decreases by small amounts); window is public so governance can adjust |
| **Guardian rotation** | Attacker with old key exhausts the pause window before rotation | Guardian auto-expiry + cooldown (T11) limits duty cycle to ≤50%; rotation completes in ~50 hours |
| **Unpause** | Attacker monitors unpause proposal and crafts an exploit at execution | Unpause itself does not change peer/endpoint/guardian; the attacker's window is the time it takes their transaction to execute (1 block), and settlement guards (nonce, intent hash) prevent replay of old fills |

**Residual exposure: Peer rotation race condition**

If the EVM peer is rotated and the Soroban peer is not rotated simultaneously, there
is a brief window where the two chains trust different counterparties. An attacker
could:
1. Observe the EVM peer rotation proposal
2. Front-run by sending a FillConfirmed from Soroban (with the old EVM peer)
3. Execute the EVM peer rotation
4. Call lzReceive on EVM (which now rejects because the sender is the old peer)
5. Exploit the mismatch

**Mitigation for this race:**
- Peer rotation should be coordinated: both chains rotate their peer in the same
  governance window (on EVM: propose peer + Soroban admin calls set_peer in parallel)
- The window for exploitation is ≤48 hours (EVM delay); it is closed by executing
  a matching rotation on Soroban within that window
- Document in the deployment runbook that peer rotations must be synchronized

### Trade-offs considered

| Approach | Chosen? | Rationale |
|----------|---------|-----------|
| Private/commit-reveal for timelock actions | No | Breaks governance transparency; added complexity; still vulnerable to post-reveal execution front-running |
| Two-phase pause (halt-new + halt-release emergency mode) | No / Phase 2 | Deferred; current design provides liveness for in-flight transfers, which is acceptable given DVN trust assumption |
| Immediate unpause without timelock (override path) | No | Breaks governance principle; a single compromised owner could unpause unilaterally |
| Grace period for peer transitions (dual acceptance) | Phase 2 | Planned; allows old peer to fill into new peer until grace expires, reducing race-condition window |

### Residual risk

**Medium → Low.** Front-running of telegraphed actions is accepted architectural
constraint:

1. **Governance transparency is non-negotiable:** Hidden or delayed proposals break
   the social contract with users and auditors
2. **Peer rotation race condition:** Synchronized rotations close the window; future
   grace periods narrow it further
3. **Pause-excludes-releases:** Acceptable given DVN trust assumption; Phase 2 will
   reconsider if needed

**Operational mitigations:**
- Coordinate peer rotations across chains within the timelock delay window
- Monitor pending timelock operations in real time and escalate unexpected proposals
- Use the guardian-pause routine drill (§9 in key-management.md) to ensure incident
  response is practiced
- If an exploit is suspected during a timelock action's delay, operators can `cancel()`
  the action (1-of-N owner, no supermajority needed) and re-propose with fixes

### Implementation notes

- **No code changes:** This is architectural analysis, not code
- **Threat model:** This section documents the stance on pause-excludes-releases
  and telegraphed-timelock front-running
- **Runbook:** Add peer-rotation synchronization guidance to deployment.md (Phase 2)
- **Drill:** Quarterly rotation drill (key-management.md §9) includes a simulated
  front-running scenario to test response time

---

## T16 — LayerZero endpoint compromise & malicious origin spoofing

### Threat

**Vector:** The LayerZero endpoint is the **root of trust for message authenticity**
on both chains. It is the sole caller of `lzReceive` (EVM) and `lz_receive` (Soroban),
and it authenticates the message origin:

```solidity
// EVM: PerihelionEscrow.sol
require(msg.sender == address(endpoint), "EndpointOnly");
require(origin.sender == stellarPeer, "PeerOnly");
```

```rust
// Soroban: settlement.rs
require!(msg.sender == endpoint, Unauthorized);
require!(origin.sender == peer, Unauthorized);
```

If the endpoint is compromised (or exploited by a critical bug), it could:
1. Deliver a forged `origin` (claiming a FillConfirmed is from the trusted peer when it is not)
2. Deliver a message with a spoofed `origin.sender` field
3. Replay an old message with a new nonce
4. Deliver multiple copies of the same message

Any of these could bypass the `stellarPeer` / `peer` check and enable an arbitrary
release of escrow funds or refund of Soroban intents.

**Worst-case impact (endpoint fully compromised):**
- An attacker forges a FillConfirmed for any intent, releasing the escrow funds to
  the attacker-controlled Stellar account
- An attacker forges a CancelIntent for any intent, refunding the user but cashing
  out the solver's collateral
- Full drain of the bridge escrow, limited only by the solvers' outstanding fills

**Scope of exposure:** The endpoint compromise is the **most severe threat** to the
bridge because it bypasses all on-chain verification. The escrow and settlement
contracts can do nothing to detect a forged message if the endpoint lies about its
source.

### Architectural root-of-trust assumption

**Explicit assumption:** Perihelion places absolute trust in the LayerZero endpoint
to:
1. Enforce its configured DVN/ULN set (at least threshold DVNs must attest)
2. Return the true `origin.sender` (the contract that sent the message on the
   source chain)
3. Reject replays via the transport nonce
4. Never deliver a message twice with the same nonce

**Why this assumption is necessary:**
- There is no secondary verification layer in Phase 1 (see roadmap below)
- Cryptographic verification of the message itself (e.g., a signature on the
  payload) would require the endpoint to also return the signature, which it does
  not currently do
- Trusting the endpoint is the standard bridge architecture; other bridges
  (Wormhole, Axelar, Hyperlane) make equivalent assumptions about their message
  layers

**Trust surface:** The endpoint is a smart contract controlled by LayerZero
governance. Its bytecode and configuration (DVN set, ULN) are publicly verifiable
on-chain, but the team must trust:
- LayerZero's governance process
- LayerZero's security practices and incident response
- The DVN set's individual security (each DVN runs an oracle/validator network)

### Defense-in-depth controls

**1. Value caps & circuit breaker**

Limit the loss if the endpoint is compromised:

- **Per-operation cap:** No single FillConfirmed can release more than a
  configurable cap (e.g., $10M USD equivalent); larger intents are split across
  multiple operations or require special approval
- **Daily cap:** Total releases per day are capped; once exceeded, all releases
  pause until reset
- **Trigger:** If the cap is hit, the guardian can pause to halt further damage
  while an incident is investigated

**Status:** Under evaluation for Phase 2. Phase 1 has no built-in cap; the
bridge's safety relies on monitoring (below).

**2. Monitoring & early detection**

Detect a compromise via anomalous release patterns:

- **Watch for:** Releases that do not correspond to known intents (on-chain
  history of `lock()` events)
- **Alert on:** Releases with mismatched destination or amount (bridge monitor
  compares on-chain `FillConfirmed` events against the Soroban ledger state)
- **Escalate:** If a release does not match any known intent, pause immediately
  and investigate

**Status:** This is an operational responsibility. The relayer and bridge
monitoring systems should log every message and alert on mismatches.

**3. Independent verification (Phase 2+)**

Add a secondary trust path that does not depend on the endpoint:

- **Option A: ZK proof of message delivery**
  - Soroban sends a cryptographic proof of the fill (e.g., a Stellar ledger-entry
    proof) to EVM
  - EVM verifies the proof without trusting the endpoint
  - Solves the problem but requires significant infrastructure
  - Planned for Phase 2 roadmap

- **Option B: Threshold signature from multiple endpoints**
  - Use more than one message layer (e.g., LayerZero + Wormhole)
  - Require agreement from both before releasing
  - Adds operational overhead and latency
  - Acceptable for Phase 2 if needed

- **Option C: Delayed release with escrow hold**
  - On receipt of FillConfirmed, do not release immediately
  - Hold for a delay window (e.g., 12 hours) while monitoring systems verify
  - Release only if no contradictory information appears
  - Trades off latency for additional verification time

**Status:** All options are deferred to Phase 2. Phase 1 operates with endpoint
as the sole verifier.

**4. Permissionless refund fallback**

Even if the endpoint is compromised and funds are incorrectly released:

- **Deadline expiry:** If the user's intent deadline passes without a valid
  FillConfirmed being received on Soroban, the user can always call
  `cancel_expired_intent()` to refund their collateral
- **Permissionless:** Anyone can call this; a compromised endpoint cannot
  prevent refunds
- **Mechanism:** Protects against loss only if the release on EVM was forged
  and the user's Soroban intent is not actually filled; does NOT protect if
  the attacker forges both a FillConfirmed on EVM and a matching fill on
  Soroban

**Status:** Already implemented.

### Trade-offs & design decisions

| Approach | Chosen? | Rationale |
|----------|---------|-----------|
| Phase 1: Endpoint as sole verifier | **Yes** | Standard bridge architecture; Phase 1 launch unblocked |
| Phase 1: Additional on-chain verification | No | Would require endpoint to return cryptographic proof; increases payload and latency |
| Phase 1: Value cap | No / Phase 2 | Adds config complexity; deferred until monitoring suggests it is needed |
| Phase 2: ZK proof layer | Planned | Removes endpoint trust assumption; requires ZK infrastructure |
| Phase 2: Multiple message layers | Planned | Threshold-signature verification of endpoint messages |
| Phase 2: Delayed-release escrow | Planned | Trades latency for verification time if single-endpoint security is insufficient |

### Residual risk

**CRITICAL.** Endpoint compromise is the most severe risk to Perihelion:

- **Impact:** Full bridge drain (no fund loss limit)
- **Likelihood:** Low (LayerZero is battle-tested, DVN set is reputable) but non-zero
- **Mitigation in Phase 1:** Monitoring + permissionless refund (partial protection)
- **Mitigation in Phase 2:** ZK proofs or multi-endpoint verification (removes assumption)

**Specific steps for Phase 1 production readiness:**

1. **Monitoring deployment:**
   - Bridge monitor observes all `FillConfirmed` events and cross-checks against
     on-chain intent history
   - Alert within 30 seconds of any anomalous release
   - Automate guardian pause on alert (or alert on-call for manual action)

2. **DVN set selection:**
   - Choose well-established DVNs (Chainlink Labs, Nethermind, Certora, or similar)
   - Ensure > 1 DVN; require ≥2 signatures (redundancy)
   - Audit DVN configurations for correctness (block confirmation counts, attestation logic)

3. **Incident response:**
   - Have a plan to pause, investigate, and (if needed) rotate the endpoint to a
     LayerZero governance-controlled new endpoint
   - Timelock delay may prevent fast rotation; pre-arrange with LayerZero for an
     emergency endpoint update if their Layer is hacked

4. **Operational awareness:**
   - Team should be aware that endpoint compromise is the sole catastrophic trust
     assumption
   - Reduce other risks to zero (DVN integrity, peer validation, guardian key rotation)
     so that endpoint is the only non-zero risk

### Implementation notes

- **No code changes (Phase 1):** The endpoint check is already in place
  (`msg.sender == address(endpoint)`)
- **Documentation (this section):** Explicitly states the assumption and worst-case impact
- **Monitoring (operational):** Bridge monitoring system (relayer + backend) should
  implement anomaly detection
- **Phase 2 roadmap:** ZK proofs or multi-endpoint verification to remove the assumption

---

## T17 — Governance-extractable escrow balance

### Threat

**Vector:** `skim(address token, address to, uint256 amount)`
(`PerihelionEscrow.sol:511`) transfers an arbitrary amount of an arbitrary
token to an arbitrary address, `onlyOwner`, with no accounting bound:

```solidity
function skim(address token, address to, uint256 amount) external onlyOwner {
    if (to == address(0)) revert ZeroAddress();
    _safeTransfer(token, to, amount);
    emit Skimmed(token, to, amount);
}
```

The escrow tracks individual `Lock` entries (`locks[intentHash]`) but does not
maintain a running `totalLocked` per token. There is therefore no on-chain
value `skim` is checked against — "surplus only" (the function's NatSpec intent:
recovering rebasing-token gains or accidental direct transfers) is a
convention enforced by nobody, not a constraint the contract enforces. A
malicious or compromised owner set can call `skim` for the full balance of any
token the escrow holds, including funds currently locked against open,
unfilled intents.

**Why this is the largest single concentration of risk:** every other
fund-moving path in the escrow (`lock`, `lzReceive`, `cancelExpired`) is gated
by a specific state transition tied to an individual `Lock`. `skim` is not —
it is a flat withdrawal of contract balance, scoped only by `onlyOwner`.

**The timelock is a detection window, not a prevention:**

1. **No user exit during the delay.** `cancelExpired` requires
   `deadline + confirmationGrace` to have elapsed and is itself blocked by
   `whenNotPaused` (`PerihelionEscrow.sol:743`, see [T19](#t19--refund-denial-via-pause)).
   An adversarial owner can `pause()` immediately after proposing a `skim`,
   preventing any user from self-rescuing via refund during the delay window.
2. **A single owner can veto governance,** including a legitimate emergency
   response (see [T20](#t20--governance-liveness)) — so the timelock's own
   liveness against a compromised or rogue owner is not assured.
3. **The delay bounds detection time, not loss.** Once the delay elapses and
   the operation executes, the transfer is final — the timelock provides a
   window to *notice* and socially/legally respond to a malicious proposal,
   not an on-chain mechanism that prevents it.

**Worst-case impact:** full drain of every token balance the escrow holds —
strictly larger than any single-intent loss, and not bounded by the
`_enforceValueCaps` per-intent/rolling-window caps, which apply only to
`lock()` inflows and are never consulted by `skim`.

### Mitigation status

**Not yet mitigated on-chain.** The only current control is the M-of-N
timelock delay on the *proposal* (per [T20](#t20--governance-liveness), that
delay itself has a governance-liveness gap). Tracked in
[issue #273](https://github.com/Perihelion-Protocol/Perihelion/issues/273)
("`skim` can transfer locked user funds — no `totalLocked` accounting bounds
it"), whose proposed fix is to track `totalLocked` per token (incremented on
`lock`, decremented on `released`/`refunded`) and bound `skim` to
`balance - totalLocked`. Related: [issue #277](https://github.com/Perihelion-Protocol/Perihelion/issues/277)
(refund path pausable, see T19) compounds this by removing the user's exit
during the timelock window.

### Trade-offs considered

| Approach | Chosen? | Rationale |
|----------|---------|-----------|
| `totalLocked` accounting, bound `skim` to surplus | Proposed (#273) | Directly closes the gap; requires careful accounting at every lock-state transition |
| Remove `skim` entirely | No | Legitimate need to recover rebasing-token surplus / accidental transfers; the function's purpose is sound, its bound is missing |
| Multisig-only (no timelock) for `skim` specifically | Not proposed | Does not address the core issue — still unbounded, only changes who can trigger it |
| Rely on the existing timelock delay as sufficient | No | Detection window ≠ prevention; user has no exit during the delay (T19) and a single owner can extend the exposure window by vetoing recovery governance (T20) |

### Residual risk

**HIGH — the largest unmitigated concentration of risk in the protocol.**
Likelihood is low under an honest owner set (the same assumption the
"Admin / timelock owner set" row in [§0](#0-consolidated-trust-model) already
makes explicit), but impact is unbounded — full escrow drain, not capped by
any per-intent or rolling-window mechanism. This is a **trust boundary**, not
a bug in the sense of unintended behavior: the code does exactly what it
says. The gap is that the threat model previously did not say so plainly.
Until [#273](https://github.com/Perihelion-Protocol/Perihelion/issues/273)
lands, integrators should treat the escrow's custody guarantee as bounded by
owner-set honesty, not by contract logic.

### Implementation notes

- **This section:** Documents the gap; no code change here.
- **Mitigation:** [issue #273](https://github.com/Perihelion-Protocol/Perihelion/issues/273).
- **Compounding issues:** [#277](https://github.com/Perihelion-Protocol/Perihelion/issues/277)
  (refund path pausable), [#280](https://github.com/Perihelion-Protocol/Perihelion/issues/280)
  (`_enforceValueCaps` circuit breaker discarded by the revert it's part of —
  another reason value caps cannot be relied on to bound this), [#282](https://github.com/Perihelion-Protocol/Perihelion/issues/282)
  (single-owner `cancel`, see T20).
- **README / FAQ:** [Trust Assumptions](../README.md#trust-assumptions) and
  [docs/faq.md](./faq.md#who-do-i-have-to-trust) now scope the "no custodial
  risk" claim against this entry.

---

## T18 — Instant endpoint rotation on Soroban

### Threat

**Vector:** `set_endpoint` (`contracts/soroban/settlement/src/lib.rs:161`) is
admin-only and takes effect immediately — no delay, no confirmation step, no
event-driven cooling period:

```rust
pub fn set_endpoint(env: Env, new_endpoint: Address) -> Result<(), PerihelionError> {
    Self::require_admin(&env)?.require_auth();
    let old: Option<Address> = env.storage().instance().get(&DataKey::Endpoint);
    env.storage().instance().set(&DataKey::Endpoint, &new_endpoint);
    env.events().publish((Symbol::new(&env, "endpoint_set"),), (old, new_endpoint));
    ...
}
```

This is inconsistent with `propose_peer` / `confirm_peer`
(`lib.rs:191`, `lib.rs:216`), which enforce `MIN_PEER_CHANGE_DELAY`
(`lib.rs:93`, 1 day) between proposal and effect. The endpoint is the sole
caller of `lz_receive` and the root of inbound message authenticity (see
[T16](#t16--layerzero-endpoint-compromise--malicious-origin-spoofing)) — the
doc-comment directly above `set_endpoint` even says so ("Endpoint rotations
are high-sensitivity: a malicious rotation would redirect all inbound
LayerZero message delivery") but the function applies no delay to match that
stated sensitivity.

**Worst-case impact:** a compromised or malicious Soroban admin key redirects
all inbound message delivery in a single transaction, with only an emitted
event (`endpoint_set`) — not a delay — as the detection signal. By the time an
operator observes and reacts to the event, the rotation has already taken
effect.

### Mitigation status

**Not yet mitigated.** No dedicated tracking issue exists yet for bringing
`set_endpoint` under the same propose/confirm delay as `set_peer`; this is
recommended as a follow-up. The event emission itself
([issue #16](https://github.com/Perihelion-Protocol/Perihelion/issues/16),
closed) already gives off-chain monitors *something* to alert on — it just
alerts after the fact rather than during a delay window.

### Trade-offs considered

| Approach | Chosen? | Rationale |
|----------|---------|-----------|
| Reuse the `propose_peer`/`confirm_peer` delay pattern for the endpoint | Recommended, not yet implemented | Consistent with how the equally-sensitive peer rotation is already handled; smallest change that closes the gap |
| Leave instant (status quo) | No (this entry is the record of that decision being revisited) | Inconsistent with the documented sensitivity of the endpoint and with the EVM side's admin-config posture |
| Two-key requirement for endpoint rotation specifically | Not proposed | Soroban admin is currently single-key by design (§0, "future: migrate to multisig"); scoping a special case for just this one field adds complexity ahead of that broader change |

### Residual risk

**Medium.** Likelihood is low (requires a compromised or malicious admin key,
the same assumption already priced into the "Admin (Soroban)" row of
[§0](#0-consolidated-trust-model)), but impact is high — full redirection of
inbound settlement messages — and, unlike the EVM peer-rotation front-running
case analyzed in [T15](#t15--front-running-of-pause-bypass--telegraphed-timelock-actions),
there is currently no delay window at all on this specific action, so there is
no time for the community to react before it takes effect.

### Implementation notes

- **This section:** Documents the gap; no code change here.
- **Recommended mitigation:** extend the `propose_peer`/`confirm_peer` pattern
  (`lib.rs:191`, `lib.rs:216`, `MIN_PEER_CHANGE_DELAY` at `lib.rs:93`) to
  `set_endpoint`.
- **Tracking:** no open issue yet — file one before scoping the fix.

---

## T19 — Refund denial via pause

### Threat

**Vector:** the documented "guaranteed refund path" is, on both chains,
gated by the same pause flag that halts new activity:

- **EVM:** `cancelExpired` (`PerihelionEscrow.sol:743`) carries the
  `whenNotPaused` modifier, three lines below NatSpec that calls the refund
  "guaranteed". Tracked in [issue #277](https://github.com/Perihelion-Protocol/Perihelion/issues/277).
- **Soroban:** `cancel_expired_intent` (`lib.rs:691`) calls
  `Self::require_not_paused(&env)?` at `lib.rs:698`. The global `paused` flag
  is set via `set_paused`/`pause`-equivalent admin calls; `lz_receive` itself
  also has its own per-`src_eid` pause gate (`PausedEid`, `lib.rs:432`) — so
  either the global flag or a per-route flag can strand a refund.

**Why it matters:** the guardian is intentionally a hot key with an
instant, low-friction `pause()` — that design is sound for stopping new
`lock()` calls quickly during an incident (see [T11](#t11--guardian-key-dos-via-repeated-instant-pause)).
But because the *same* flag also blocks the refund path, the guardian's
instant pause is simultaneously an instant, unilateral block on every user's
ability to exit an expired, unfilled intent. Combined with
[T11](#t11--guardian-key-dos-via-repeated-instant-pause)'s finding that a
compromised guardian key can maintain up to a 50% pause duty cycle, a
compromised guardian can deny refunds for up to 72 hours at a stretch,
indefinitely, on a repeating cycle.

**Compounding interaction with T17:** an owner who has proposed a malicious
`skim` (or any other harmful timelocked action) can pause the contract
immediately after proposing, removing the user's self-service exit for the
duration of the timelock delay — see [T17](#t17--governance-extractable-escrow-balance).

### Mitigation status

**Not yet mitigated.** Both `cancelExpired` (EVM, #277) and
`cancel_expired_intent` (Soroban) currently share the pause gate with the
non-refund paths they were meant to be independent of. The straightforward
fix — carve the refund/cancel path out from `whenNotPaused` /
`require_not_paused` on both chains, so only *new* activity (`lock`, new
`fill_intent` registrations) is paused, matching the existing exemption
already given to `lzReceive`/inbound settlement (see
[T15](#t15--front-running-of-pause-bypass--telegraphed-timelock-actions),
"pause excludes releases") — has not landed.

### Trade-offs considered

| Approach | Chosen? | Rationale |
|----------|---------|-----------|
| Exempt refund/cancel-expired from the pause gate on both chains | Recommended, not yet implemented | Matches the existing design principle that in-flight/exit paths should survive a pause; consistent with why `lzReceive` is already exempt |
| Leave refund paths pausable (status quo) | No (this entry records that decision being revisited) | Contradicts the "guaranteed refund" NatSpec and removes the user's only self-service exit during an incident or a malicious timelock proposal |
| Separate "new-activity-only" pause flag from a rarely-used "full halt" flag | Deferred | Larger design change (two pause states); the minimal fix (exempt one function per chain) captures most of the benefit |

### Residual risk

**Medium → High**, specifically because of the T17 compounding case: on its
own (guardian-triggered pause during a genuine incident), the residual risk
is bounded by the same ≤50% duty cycle as T11. Combined with a malicious
timelock proposal (T17) or a single vetoing owner (T20), an adversarial actor
can use the refund-path pause to remove the user's exit for the full duration
of their attack window, not just the guardian's 72-hour cycle.

### Implementation notes

- **This section:** Documents the gap; no code change here.
- **EVM mitigation tracking:** [issue #277](https://github.com/Perihelion-Protocol/Perihelion/issues/277).
- **Soroban:** no dedicated tracking issue yet for `cancel_expired_intent`'s
  pause gate specifically — file one alongside #277's EVM fix so both chains
  are addressed together (the wire-format/parity discipline the rest of this
  codebase already follows).
- **Related:** [T11](#t11--guardian-key-dos-via-repeated-instant-pause) (pause
  duty-cycle bound), [T15](#t15--front-running-of-pause-bypass--telegraphed-timelock-actions)
  ("pause excludes releases" — the design precedent this fix would extend to
  refunds).

---

## T20 — Governance liveness

### Threat

**Vector:** `PerihelionTimelock.cancel(bytes32 id)` (`PerihelionTimelock.sol:262`)
is `onlyOwner` — **any single owner**, not a threshold, can cancel a pending
operation, including one the rest of the owner set has already confirmed:

```solidity
/// @notice Cancel a pending (un-executed) operation. Any owner may cancel.
function cancel(bytes32 id) external onlyOwner {
```

This means the M-of-N confirmation threshold that governs *proposing* and
*executing* an operation does not apply symmetrically to *blocking* one — a
single compromised, coerced, or simply obstructionist owner has unilateral
veto power over every governance action, including:

- A legitimate emergency unpause after a guardian incident.
- A guardian-key rotation after a leak is discovered.
- A recovery action proposed in response to a [T17](#t17--governance-extractable-escrow-balance)
  attack by a *different* malicious owner.

**Compounding factors** (same underlying single-owner-`onlyOwner` pattern,
tracked separately): [issue #283](https://github.com/Perihelion-Protocol/Perihelion/issues/283)
notes `revokeConfirmation` resets `readyAt`, letting one owner reset the delay
clock indefinitely even without an outright `cancel`; [issue #281](https://github.com/Perihelion-Protocol/Perihelion/issues/281)
notes `cancel` does not clear `confirmedBy`, permanently bricking a
re-proposed operation under the same salt. Together these mean a single owner
can not only block an operation once, but make it costly to ever re-propose.

**Why the existing threat-model text undersells this:** [§0](#0-consolidated-trust-model)'s
"Admin / timelock owner set" row currently lists "a single honest owner can
`cancel`" as a *mitigation* (a safety valve against a malicious majority).
That framing is correct for the case it describes, but it is incomplete: the
same mechanism is a **liveness vulnerability** when the single acting owner is
the adversarial or compromised one, not the honest holdout.

### Mitigation status

**Not yet mitigated.** [Issue #44](https://github.com/Perihelion-Protocol/Perihelion/issues/44)
("timelock `cancel` is callable by any single owner, allowing one owner to
unilaterally block all governance") was filed and **closed without the
underlying code changing** — see [issue #282](https://github.com/Perihelion-Protocol/Perihelion/issues/282),
which reopens the finding and is the current tracking issue. This is itself
an instance of the closed-without-landing pattern flagged by [issue #357](https://github.com/Perihelion-Protocol/Perihelion/issues/357)'s
review-gate audit.

### Trade-offs considered

| Approach | Chosen? | Rationale |
|----------|---------|-----------|
| Require a threshold (not a single owner) to `cancel` | Recommended (#282), not yet implemented | Restores symmetry with the confirm/execute threshold; a single owner should be able to *flag* concern (e.g. via `revokeConfirmation` on their own confirmation) but not unilaterally kill consensus |
| Leave single-owner `cancel` as-is (status quo) | No (this entry records that decision being revisited) | The safety-valve rationale only holds against a malicious majority; it creates an equal and opposite liveness risk from a malicious minority of one |
| Remove `cancel` entirely, rely on letting operations expire via `GRACE_PERIOD` | No | Removes the legitimate fast-abort case (e.g. a proposal found to be buggy before it executes); the fix is to raise the bar on who can cancel, not to remove the capability |

### Residual risk

**Medium.** Likelihood requires one compromised or adversarial owner (already
priced into the M-of-N trust assumption), but the impact is liveness-only —
no funds move via `cancel` alone. The risk is that it can be *combined* with
other findings: it removes the recovery path exactly when [T17](#t17--governance-extractable-escrow-balance)
or a guardian-key compromise ([T11](#t11--guardian-key-dos-via-repeated-instant-pause))
needs one, which is why it is documented here as a first-class entry rather
than left as a footnote on the trust table.

### Implementation notes

- **This section:** Documents the gap; no code change here.
- **Tracking:** [issue #282](https://github.com/Perihelion-Protocol/Perihelion/issues/282)
  (primary), [#281](https://github.com/Perihelion-Protocol/Perihelion/issues/281),
  [#283](https://github.com/Perihelion-Protocol/Perihelion/issues/283)
  (compounding `confirmedBy`/`readyAt` issues in the same function family).
  Closed-without-fix history: [#44](https://github.com/Perihelion-Protocol/Perihelion/issues/44).
