# Perihelion On-Chain Monitoring & Alerting Design

**Status:** Design document for operators, security team, and auditors
**Last Updated:** 2026-07-25
**Audience:** Mainnet operators, incident response team, security reviewers

---

## Overview

Perihelion's cross-chain bridge emits events from both Soroban and EVM contracts to enable incident detection and real-time monitoring. This document defines:

- The set of monitored events and their semantics
- Alert conditions, severity levels, and response protocols
- Integration with circuit-breaker and pause controls
- Reference implementations for watchers and querying tools
- Operational runbooks for common incident scenarios

**Key Principle:** Events are signals, not guarantees. A comprehensive monitoring system must combine on-chain events with off-chain state observation to catch silent failures, delays, and divergences.

---

## Part I: Event Specifications

### Soroban Events

All Soroban events are emitted from the settlement contract (`contracts/soroban/src/contract.rs`).

#### `Registered(hash: XDRHash, user: Address, amount: i128)`
- **When:** User intent is registered on Soroban (solver called `fill_intent()`)
- **Semantics:** Intent received destination settlement amount
- **Invariant:** One `Registered` per unique intent hash (idempotency via hash key)
- **Action:** Record for value conservation checks; link to source lock

#### `Filled(hash: XDRHash, user: Address, amount: i128, destination: Address)`
- **When:** Solver calls `fill_intent()` and user receives assets on Stellar
- **Semantics:** Amount of destination asset delivered to user
- **Invariant:** At most one `Filled` per intent hash (atomic settlement via `I2`)
- **Action:** Confirm user received promised amount; start timeout for `FillConfirmed` on EVM

#### `Cancelled(hash: XDRHash, reason: String)`
- **When:** Intent expires via `cancel_expired_intent()` (permissionless)
- **Semantics:** Reason is either `"expired"` (deadline passed) or `"refund_bridge"` (EVM cancel message)
- **Action:** Check EVM for corresponding `Refunded` event; flag if missing after timeout

#### `RefundBridge(hash: XDRHash, user: Address, amount: i128)`
- **When:** Soroban cancel path sends refund message to EVM via LayerZero
- **Semantics:** Refund message dispatched for LST; amount committed to be refunded
- **Action:** Monitor EVM receipt of corresponding `Refunded` event within SLA

### EVM Events

All EVM events are emitted from the escrow contract (`contracts/evm/src/PerihelionEscrow.sol`).

#### `Locked(hash: XDRHash, user: Address, amount: uint256, solver: Address, deadline: uint256)`
- **When:** Solver calls `lock(intent, signature)` on EVM escrow
- **Semantics:** Source funds escrowed; solver committed to fill on Soroban
- **Invariant:** One `Locked` per unique intent hash
- **Action:** Record escrow event; link to Soroban settlement; monitor deadline

#### `Released(hash: XDRHash, solver: Address, amount: uint256)`
- **When:** `lzReceive()` processes `FillConfirmed` message from Soroban
- **Semantics:** Funds released from escrow to solver
- **Invariant:** Only after `FillConfirmed` verified; at most one `Released` per hash (`I2`)
- **Action:** Confirm value conservation (locked ≥ released + refunded)

#### `Refunded(intentHash: bytes32, user: address, amount: uint256, reason: uint8)`
- **When:** `lzReceive()` processes cross-chain `CancelIntent` message from Soroban
- **Semantics:** Cross-chain cancel succeeded and was confirmed by Stellar; funds returned to user
- **Action:** Verify reason code matches Soroban cancellation; link to source lock

#### `RefundedLocalTimeout(intentHash: bytes32, user: address, amount: uint256)`
- **When:** User or keeper calls `cancelExpired()` on EVM after `deadline + confirmationGrace`
- **Semantics:** Local timeout fallback; cross-chain message failed to complete within grace period
- **Action:** Alert on anomalous bridge or relayer activity; investigate messaging failure or solver abandonment

#### `MessageReceived(hash: XDRHash, messageType: String, srcChain: String)`
- **When:** `lzReceive()` processes any inbound LayerZero message
- **Semantics:** Message type is `"FillInstruction"`, `"FillConfirmed"`, `"CancelIntent"`, or `"RefundBridge"`
- **Action:** Track message latency; flag if confirmations delayed beyond SLA

---

## Part II: Alert Definitions

Each alert is mapped to severity, response SLA, and integration with pause controls.

### CRITICAL Alerts (Pause Bridge Immediately)

These alerts indicate potential active exploitation or unrecoverable state divergence.

#### Alert C1: Value Divergence Detected
- **Condition:** `∑(Locked on EVM) ≠ ∑(Filled + Cancelled on Soroban) ± tolerance`
  - Tolerance: configurable, recommend 1 bps (0.01%) to account for rounding
  - Timeframe: measured over 1-hour rolling windows
- **Trigger:** Sum diverges by > tolerance for > 10 minutes
- **Action:**
  - Emit alert immediately
  - Trigger `pauseBridge()` circuit-breaker on both chains
  - Notify security team and ops
  - Freeze new intent acceptance
  - Keep existing in-flight intents processing (allow pending to settle or refund)
- **Recovery:**
  - Security review required before unpause
  - Reconciliation service must confirm divergence is understood
  - Manual code review if exploit is suspected

#### Alert C2: Message Delivery Breakdown
- **Condition:** LayerZero messages not received within SLA for > 3 consecutive intents
  - `FillInstruction` (EVM → Soroban): SLA 10 minutes
  - `FillConfirmed` (Soroban → EVM): SLA 10 minutes
  - `CancelIntent` or `RefundBridge`: SLA 30 minutes
- **Trigger:** SLA breach repeated 3x
- **Action:**
  - Check LayerZero DVN status and message fees
  - If DVN is down, pause bridge (messaging is broken)
  - If fees exhausted, top up and retry
  - Notify security team if DVN compromise is suspected
- **Recovery:**
  - Confirm DVNs are responding
  - Manually retry failed messages if safe
  - If DVN is compromised, escalate to Stellar and LayerZero teams

#### Alert C3: Unmatched Settlement
- **Condition:** Intent in `Settled` state on EVM (all funds released) but no corresponding `Filled` event on Soroban within grace period
  - Grace period: 30 minutes (accounts for message delay + verification)
- **Trigger:** Alert fires if grace period expires
- **Action:**
  - Immediate pause
  - Check if `Filled` event exists but was not indexed
  - If truly unmatched, escalate to auditing team
  - Do not resume without proof of intent on Soroban

### HIGH Alerts (Manual Review Required, May Pause)

These indicate anomalies that require investigation but may have benign explanations.

#### Alert H1: Large Value Movement
- **Condition:** Single intent amount > configurable threshold
  - Recommend: start at 10% of bridge liquidity, tune operationally
- **Trigger:** Exceeds threshold
- **Action:**
  - Log event with solver identity and destination address
  - Check if solver is known/whitelisted
  - If solver is new or bridge is low-liquidity, consider brief pause
  - Notify ops for manual approval of unusual actors

#### Alert H2: Solver Behavior Anomaly
- **Condition:** Solver fills > N% of intents in time window, or abruptly changes fill rate
  - Recommend: N = 70% (dominance check), time window = 1 hour
- **Trigger:** Exceeds threshold for rolling window
- **Action:**
  - Flag in dashboard; no auto-pause
  - Check if solver is expected (e.g., Perihelion team's relayer during testing)
  - If unexpected concentration, escalate for review
  - Consider incentive realignment if needed

#### Alert H3: Configuration Change Detected
- **Condition:** Contract upgrade, guardian set change, or parameter adjustment detected
- **Trigger:** Immediate on change
- **Action:**
  - Log change with timestamp and operator (if known)
  - Verify change matches known deployment plan
  - If unscheduled, escalate immediately (unauthorized upgrade)
  - Broadcast notification to monitoring subscribers

#### Alert H4: Elevated Refund Rate & Local-Timeout Detection (`RefundedLocalTimeout`)
- **Condition:** Any `RefundedLocalTimeout` event log detected, or `∑(Refunded + RefundedLocalTimeout) / ∑(Locked)` exceeds threshold for time window
  - Local-timeout event topic: `RefundedLocalTimeout(bytes32,address,uint256)`
  - Recommend: threshold = 5%, time window = 1 hour
- **Why it matters:** `Refunded` means the cross-chain unwind succeeded normally via Stellar. `RefundedLocalTimeout` means the cross-chain path failed to complete within the grace period (relayer down, DVN degraded, or solver abandoned fill).
- **Trigger:** Immediate alert on `RefundedLocalTimeout` log filter, or rate > threshold for rolling window
- **Action:**
  - Check if relayer or DVN is down and restart if needed
  - Check if destination chain message delivery is stuck
  - If rate remains elevated, escalate (possible attack or griefing)

#### Alert H5: Timelock Revoke/Re-confirm Griefing (issue #283)
- **Condition:** The same operation id emits `ConfirmationRevoked` followed by
  `Confirmed` (or `Ready`) more than **2 times within any 24-hour window**,
  or a `Ready` event is emitted for an id that already emitted `Ready` previously.
- **Why it matters:** Prior to the monotonic-clock fix (issue #283),
  `revokeConfirmation` reset `readyAt` so a revoke/re-confirm cycle could
  push the execution window forward indefinitely. The fix made `readyAt`
  monotonic, so `Ready` is emitted at most once per operation. If `Ready`
  fires more than once for the same id, or if the revoke/re-confirm pattern
  repeats rapidly, it signals either:
  - A disgruntled owner attempting governance delay (should not affect
    `readyAt` after the fix, but still wastes honest owners' gas).
  - A contract running pre-fix code (deployment incident).
- **Trigger:** `Ready(id, readyAt)` emitted for an id that already has a
  recorded `readyAt`; or `ConfirmationRevoked(id)` followed by `Confirmed(id)`
  more than 2 times within 24 hours for the same id.
- **Action:**
  - Verify the deployed contract is the patched version (no `readyAt` reset
    in `revokeConfirmation`). If it is pre-fix, pause and redeploy immediately.
  - If post-fix: log the cycling owner address; the operation itself is safe
    (readyAt is unchanged), but the pattern may indicate a disgruntled signer.
  - Alert ops to coordinate with the cycling owner out-of-band.
  - No auto-pause required for post-fix deployments; the protocol is not at risk.
- **Monitoring query:**
  ```sql
  -- Detect repeated Ready emissions for the same operation (post-fix: should be 0)
  SELECT id, COUNT(*) as ready_count
  FROM timelock_events
  WHERE event_name = 'Ready'
    AND block_time > NOW() - INTERVAL 7 DAYS
  GROUP BY id
  HAVING COUNT(*) > 1
  ORDER BY ready_count DESC;

  -- Detect rapid revoke/re-confirm cycling
  SELECT id, COUNT(*) as cycle_count, MIN(block_time) as first_seen
  FROM (
    SELECT id, block_time,
           LAG(event_name) OVER (PARTITION BY id ORDER BY block_time) as prev_event
    FROM timelock_events
    WHERE event_name IN ('ConfirmationRevoked', 'Confirmed')
  ) t
  WHERE event_name = 'Confirmed' AND prev_event = 'ConfirmationRevoked'
    AND block_time > NOW() - INTERVAL 24 HOURS
  GROUP BY id
  HAVING COUNT(*) > 2;
  ```

### MEDIUM Alerts (Informational, No Pause)

These indicate degraded performance or minor anomalies.

#### Alert M1: Message Latency Elevated
- **Condition:** Percentile (P95/P99) message latency > 2x baseline SLA
  - Baseline SLA: 10 minutes for inter-chain messages
  - Alert threshold: > 20 minutes (P95)
- **Trigger:** Threshold exceeded
- **Action:**
  - Check LayerZero network status and gas prices
  - Log for trend analysis
  - No operational action unless combined with other alerts

#### Alert M2: Event Processing Lag
- **Condition:** Indexer (watcher service) falls behind real-time events by > threshold
  - Recommend: threshold = 2 blocks
- **Trigger:** Lag detected
- **Action:**
  - Restart indexer if hung
  - Check database performance
  - No user-facing action unless lag persists > 10 minutes

#### Alert M3: Solver Timeout / Repeated Failures
- **Condition:** Solver submits transaction for same intent > 5 times on EVM
- **Trigger:** Detected in transaction pool
- **Action:**
  - Log event; may indicate mempool congestion or bad nonce
  - No action; solver will eventually succeed or refund

---

## Part III: Integration with Circuit-Breaker & Pause Controls

### Pause Conditions

The bridge can enter a paused state via two paths:

1. **Automatic (Critical alerts):**
   - Alert C1 (value divergence)
   - Alert C2 (message delivery breakdown)
   - Alert C3 (unmatched settlement)

2. **Manual (Guardian activation):**
   - Multi-sig guardian can call `pauseBridge()` on Soroban or EVM
   - Requires `N`-of-`M` signature (recommend 3-of-5 for mainnet)

### Pause Semantics

When bridge is paused:

- ✅ Existing in-flight intents continue to settle or refund (non-blocking)
- ❌ New intent acceptance is blocked (no new `lock()` on EVM)
- ❌ Solver fill attempts are rejected
- ✅ Permissionless refund path remains active (users can reclaim funds)
- ✅ Message processing continues (LayerZero delivers in-flight messages)

### Resume Conditions

Bridge resumes only after:

1. **Root cause confirmed** — Reconciliation service proves value is balanced (or deviation is understood)
2. **Fix deployed** — If exploit was detected, patched version is running on all endpoints
3. **Manual governance** — Guardian multi-sig approves `resumeBridge()`
4. **Attestation** — Incident report published with timeline and remediation

---

## Part IV: Reference Watcher Implementation

### Architecture

The **Perihelion Watcher** is an off-chain service that:

1. Indexes Soroban and EVM events in real-time
2. Correlates events across chains via intent hash
3. Computes aggregates (value sums, message latencies)
4. Evaluates alert conditions
5. Emits alerts and signals circuit-breaker if needed
6. Publishes a public monitoring dashboard

### Components

#### Event Indexer
- **Input:** Soroban RPC and EVM RPC (infura/alchemy/custom)
- **Process:**
  - Poll RPC for new blocks every 12 seconds (Soroban) and 12 seconds (EVM)
  - Parse logs for known event signatures
  - Normalize timestamps and metadata
  - Store in time-series database (e.g., InfluxDB, Prometheus)
- **Output:** Event stream (Kafka or pub-sub)

#### Reconciliation Engine
- **Input:** Indexed events, current on-chain state
- **Process:**
  - Group events by intent hash
  - Compute `Locked` sum (EVM) vs. (`Filled` + `Cancelled`) sum (Soroban)
  - Check for unmatched settlements
  - Verify message latencies
- **Output:** Reconciliation report (JSON), alerts (if violations detected)

#### Alert Manager
- **Input:** Reconciliation report
- **Process:**
  - Evaluate alert conditions (C1–C3, H1–H4, M1–M3)
  - Filter duplicates (throttle repeated alerts)
  - Determine severity and action
- **Output:** Structured alert logs, circuit-breaker signals

#### Dashboard / API
- **Endpoints:**
  - `GET /health` — Watcher operational status and indexer lag
  - `GET /bridge-status` — Current bridge status (active/paused)
  - `GET /value-conservation` — Value sum checks
  - `GET /alerts` — Recent and active alerts
  - `GET /intent/{hash}` — Full lifecycle of an intent across chains
- **Consumers:** Web UI, mobile app, Discord/Slack bots, external integrators

### Reference Query Set (SQL / GraphQL)

#### Query 1: Value Conservation Check
```sql
-- For intents settled in the last hour
SELECT
  COUNT(DISTINCT hash) as intent_count,
  SUM(locked_amount) as total_locked,
  SUM(filled_amount) as total_filled,
  SUM(refunded_amount) as total_refunded,
  (SUM(locked_amount) - SUM(filled_amount) - SUM(refunded_amount)) as in_flight_or_error
FROM intent_lifecycle
WHERE last_event_ts > NOW() - INTERVAL 1 HOUR
GROUP BY 1;
```

#### Query 2: Message Delivery SLA
```sql
-- For messages sent in the last 24 hours
SELECT
  message_type,
  COUNT(*) as count,
  PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY delivery_latency_ms) as p95_latency_ms,
  COUNT(CASE WHEN delivery_latency_ms > 600000 THEN 1 END) as sla_breaches
FROM messages
WHERE sent_ts > NOW() - INTERVAL 24 HOURS
GROUP BY message_type;
```

#### Query 3: Unmatched Settlements
```sql
-- Intents released on EVM but not filled on Soroban within grace period
SELECT
  hash,
  evm_release_ts,
  soroban_fill_ts,
  (EXTRACT(EPOCH FROM (evm_release_ts - soroban_fill_ts))) as delay_seconds
FROM intent_lifecycle
WHERE evm_released = TRUE
  AND soroban_filled = FALSE
  AND (EXTRACT(EPOCH FROM (NOW() - evm_release_ts))) > 1800  -- grace: 30 min
ORDER BY delay_seconds DESC;
```

---

## Part V: Operational Runbooks

### Incident: Value Divergence Detected (C1)

**Entry Point:** Alert C1 fires, bridge auto-paused

**Steps:**

1. **Confirm Alert (5 min)**
   - Watcher dashboard shows divergence magnitude and affected intent range
   - Manual recount: sum `Locked` events on EVM, sum `Filled + Cancelled` on Soroban
   - Check if divergence is within tolerance (rounding errors)

2. **Root Cause Analysis (30 min)**
   - Check if a recent large refund or failure occurred
   - Review contract transaction logs around divergence timestamp
   - Check for LayerZero message failures or delivery delays
   - Look for double-settlement or ghost fills

3. **Mitigation (varies)**
   - If rounding error: adjust tolerance in monitoring config, resume
   - If message delay: check DVNs are healthy, may retry messages, resume
   - If exploit suspected: isolate affected intent(s), coordinate with auditors

4. **Recovery (24+ hours)**
   - Write detailed incident report
   - Coordinate with Stellar and LayerZero teams if cross-protocol issue
   - Deploy patch if code issue found
   - Manual governance (multi-sig) approves resume

### Incident: Large Value Movement (H1)

**Entry Point:** Alert H1 fires, manual review needed (no auto-pause)

**Steps:**

1. **Assess Novelty (5 min)**
   - Is solver new (not in known registry)?
   - Is destination address suspicious (new or unvetted)?
   - Is amount consistent with bridge liquidity and market conditions?

2. **Check Context (10 min)**
   - Look at recent fill history for this solver
   - Check if transaction is part of larger batch (institutional onramp)
   - Verify slippage is reasonable

3. **Decision (5 min)**
   - If known solver and reasonable conditions: log and continue
   - If new solver or suspicious destination: brief pause (5 min) while team reviews
   - If truly anomalous: escalate for governance review

### Incident: Elevated Refund Rate (H4)

**Entry Point:** Alert H4 fires, threshold exceeded

**Steps:**

1. **Check Relayer Status (5 min)**
   - Is solver relayer process running and responding to intents?
   - Are there recent transaction failures or dropped connections?

2. **Check Timeline (5 min)**
   - Is the deadline period ending (expected batch refunds)?
   - Did a relayer go down and restart?

3. **Assess Risk (10 min)**
   - If expected (deadline, relayer restart): log and monitor
   - If unexpected: check solver incentives and competitiveness
   - If persistent: consider temporary incentive boost to attract solvers

---

## Part VI: Integration with CI/CD & Alerting

### GitHub Actions

The monitoring service runs as part of CI/CD:

- **Nightly reconciliation check:** Verifies no value divergence in testnet
- **Pre-deployment validation:** Confirms monitoring can reach live RPC endpoints
- **Alerting on merge:** Posts digest of latest incidents to #security Slack channel

### Alert Destinations

Alerts are routed based on severity:

| Severity | Slack | PagerDuty | Email | Log |
| -------- | ----- | --------- | ----- | --- |
| CRITICAL | 🚨 #security (tagged ops) | Yes | Yes | Yes |
| HIGH | 📢 #operations | No | No | Yes |
| MEDIUM | 📊 #monitoring | No | No | Yes |

---

## Part VII: Roadmap

**Phase 1 (Immediate, before mainnet):**
- [ ] Event indexer for Soroban and EVM
- [ ] Basic reconciliation (value sums)
- [ ] Critical alerts (C1–C3) with circuit-breaker integration
- [ ] Reference watcher deployment

**Phase 2 (Post-launch, first 30 days):**
- [ ] High alerts (H1–H4) with tuned thresholds
- [ ] Dashboard and public API
- [ ] Message latency monitoring
- [ ] PagerDuty integration

**Phase 3 (Months 2+):**
- [ ] Predictive anomaly detection (ML-based)
- [ ] Integration with off-chain solver state (competitive dynamics)
- [ ] Cross-chain settlement latency SLA enforcement
- [ ] Solver reputation scoring based on fill history

---

## References

- **Intent Lifecycle:** [TECHNICAL-ARCHITECTURE.md](./TECHNICAL-ARCHITECTURE.md#intent-lifecycle-state-diagram)
- **Security Policy:** [SECURITY.md](../SECURITY.md)
- **Threat Model:** [TECHNICAL-ARCHITECTURE.md#6-security-model--threat-matrix](./TECHNICAL-ARCHITECTURE.md#6-security-model--threat-matrix)
- **Reconciliation Service:** [RECONCILIATION.md](./RECONCILIATION.md)
