# Perihelion Incident Response Runbooks

This document provides operational procedures for the top failure scenarios affecting
Perihelion. Each runbook covers detection, triage, containment, investigation,
recovery, and post-incident actions. This is the **single source of truth** for
incident response and must be executed under pressure with discipline.

> **Audience:** Oncall operators, incident commanders, and protocol admins. Treat
> this runbook as law during an incident.

---

## Table of Contents

1. [Pre-incident setup](#pre-incident-setup)
2. [Stuck / dropped cross-chain message](#runbook-1-stuck--dropped-cross-chain-message)
3. [LayerZero outage](#runbook-2-layerzero-outage)
4. [Source-chain reorg](#runbook-3-source-chain-reorg)
5. [Leaked guardian key](#runbook-4-leaked-guardian-key)
6. [Peer misconfiguration](#runbook-5-peer-misconfiguration)
7. [Suspected exploit / value divergence](#runbook-6-suspected-exploit--value-divergence)
8. [Post-incident review](#post-incident-review)

---

## Pre-incident Setup

### Alert thresholds and escalation

| Alert | Trigger | Severity | Action |
|-------|---------|----------|--------|
| **StuckIntent** | Intent unresolved for > 2 × `confirmationGrace` | **P1** | Page oncall immediately; start runbook #1 |
| **MessageUndelivered** | `MessageSent` on EVM not relayed within 12 hours | **P1** | Page oncall; start runbook #2 |
| **EndpointLatency** | Relayer reports endpoint RPC latency > 30s | **P1** | Check LayerZero status; start runbook #2 |
| **ReorgDetected** | Fork chain reorg depth > configured DVN threshold (≥15 blocks) | **P1** | Page oncall; start runbook #3 |
| **GuardianKeyCompromise** | Unauthorized pause + unpause cycle; unexplained guardian tx | **P0** | Immediate page + incident commander; start runbook #4 |
| **ValueDivergence** | Reconciliation detects locked EVM ≠ settled Stellar | **P1** | Page oncall; start runbook #6 |

### Equipment checklist

Before any on-call shift, verify:

- [ ] Access to all admin keys (encrypted in vault, not in Slack / email)
- [ ] Access to EVM timelock dashboard (e.g., Etherscan interface with custom UI)
- [ ] Access to Stellar CLI and account operations
- [ ] Access to monitoring dashboards (Grafana, alerting, logs)
- [ ] Mobile phone + backup communication (Slack, PagerDuty, Discord)
- [ ] Incident commander on standby contact list
- [ ] Legal/business escalation contact list

---

## Runbook 1: Stuck / Dropped Cross-Chain Message

### Scenario

A user locked funds on the EVM chain, but the FillConfirmed/CancelIntent message
never arrives on Soroban within the expected `confirmationGrace` window. Funds
remain locked or unresolved beyond the deadline.

### Detection

| Signal | What to check |
|--------|---------------|
| **Alert:** `StuckIntent` fires | Reconciliation job found unresolved intents |
| **Manual:** User report in Discord | "My lock has been pending for X hours" |
| **Dashboard:** Intent timeout heatmap | Several intents stalled in same 12h window |

### Triage (first 5 minutes)

1. **Confirm the stuck intent:**
   ```bash
   # On Soroban: check intent status
   stellar contract invoke --id <settlement-contract> \
     -- intent_status --intent_hash <0xhash>
   # Expected: Either "filled", "cancelled", or a timestamp in the past
   # If pending with an old deadline: STUCK
   ```

2. **Check if EVM lock exists and when it was created:**
   ```bash
   # On Etherscan or RPC: read the escrow contract storage
   # Verify the lock is real and timestamp aligns with user's claim
   ```

3. **Determine the message path:**
   - Did the escrow emit a `FillInstruction` / `CancelIntent` message on EVM?
   - Check `MessageSent` events in the escrow contract logs (Etherscan Events tab)
   - Note the `nonce` and timestamp

4. **Is this one intent or many?**
   - If one: likely a relayer delivery issue (runbook #2)
   - If multiple (same time window): likely LayerZero outage (runbook #2)

### Immediate Containment (first 15 minutes)

**If the intent is NOT critical (value < threshold, user can wait):**
- No containment needed; proceed to investigation

**If the intent IS critical (user locked significant value, deadline approaching):**

1. **Assess timeout risk:**
   - Calculate `deadline - now`. If < 1 hour, prepare a forced cancel
   - Forced cancel requires admin intervention (see recovery step)

2. **Prepare a pause if value is under active attack:**
   - If the intent seems to be part of a broader attack pattern (many stuck,
     unusual peer/endpoint change), see runbook #6 (value divergence)
   - If isolated, do NOT pause yet; investigate first

### Investigation (15 minutes – 1 hour)

1. **Check the relayer logs:**
   ```bash
   # Relayer logs on the deployment (or tail the service logs)
   grep "<intent-hash>" /var/log/relayer.log | tail -20
   # Look for: picked up message, confirmed blocks, delivery attempted
   ```

2. **Check LayerZero endpoint status:**
   ```bash
   # Verify endpoint is accepting messages
   # Call the endpoint's `nonce` getter for your settlement contract
   stellar contract invoke --id <endpoint-contract> \
     -- get_inbound_nonce --src_eid <EVM_EID> --sender <escrow-address>
   # Should match the nonce of the FillInstruction in EVM logs
   ```

3. **Check Soroban settlement for message receipt:**
   ```bash
   # In settlement logs, search for lz_receive invocations
   grep "lz_receive" /var/log/settlement.log
   # If not present: message never left EVM or endpoint rejected it
   ```

4. **Cross-check the message:**
   - Compute the intent hash on both sides; confirm they match
   - Check `inboundNonce` on Soroban; is it behind EVM's outbound nonce?

### Recovery (1–4 hours)

**If the message is truly lost (relayer died, LayerZero down, etc.):**

1. **Restart the relayer:**
   ```bash
   systemctl restart perihelion-relayer
   # Wait 2 minutes; check logs for recovery
   grep "resuming from cursor" /var/log/relayer.log
   ```

2. **If relayer restart doesn't trigger re-delivery within 10 minutes:**
   - The message was likely confirmed on LayerZero but Soroban failed to decode
     it. Proceed to manual force-cancel (admin-only).

3. **Manual force-cancel (admin action):**
   - Only after confirming the message is unrecoverable
   - Admin calls `cancel_expired_intent` directly on Soroban with the intent hash
   - This refunds the user and unblocks the lock
   ```bash
   stellar contract invoke --id <settlement-contract> \
     -- cancel_expired_intent --intent_hash <0xhash>
   ```
   - **Logging:** Log this action with timestamp, intent hash, and reason in an
     audit log. Post to #incidents on Slack with details.

4. **If deadline has passed and funds are locked on EVM:**
   - User has a local-fallback refund available (`cancelExpired` on EVM)
   - Instruct user: "Call `cancelExpired(<intentHash>)` on the Escrow to refund
     yourself; the cross-chain message was lost."

**If the message is in flight (confirmed on LayerZero, not yet on Soroban):**
- Wait up to `MAX_TTL` for the message (typically a few hours)
- If still not received: escalate to LayerZero support + run recovery steps

### Post-resolution

- [ ] Confirm the intent is in a terminal state (filled or cancelled)
- [ ] Verify user received refund or fill confirmation
- [ ] Update monitoring: add this intent hash to a dead-letter list for post-mortem
- [ ] Post a status update to #incidents: "Resolved: intent <hash> cancelled
      (message loss)"

---

## Runbook 2: LayerZero Outage

### Scenario

LayerZero endpoint or DVN infrastructure is degraded or down. Messages are
confirmed but not delivered, or delivery is stuck indefinitely. Cross-chain
settlement halts.

### Detection

| Signal | What to check |
|--------|---------------|
| **Alert:** `EndpointLatency` fires | Relayer RPC is timing out |
| **Alert:** `MessageUndelivered` fires | Multiple messages stalled > 12 h |
| **Dashboard:** Check LayerZero status | LayerZero infrastructure status page |

### Triage (first 5 minutes)

1. **Check LayerZero status and recent incidents:**
   - Check the LayerZero infrastructure status (consult LayerZero dashboard or support)
   - Look for "Soroban network" or "EVM network" incidents
   - If there's an active incident post, escalate to LayerZero support immediately

2. **Verify endpoint is reachable on both chains:**
   ```bash
   # EVM side: call endpoint contract, get last confirmed block
   cast call <endpoint-address> "latestConfirmedBlock()" --rpc-url $EVM_RPC
   
   # Soroban side: verify endpoint contract exists and responds
   stellar contract invoke --id <endpoint-contract> \
     -- get_domain --src_eid <EVM_EID>
   ```

3. **Check relayer connectivity:**
   ```bash
   # Is the relayer process running?
   systemctl status perihelion-relayer
   
   # Is it emitting heartbeat logs?
   tail -f /var/log/relayer.log | grep "tick"
   ```

### Immediate Containment (first 15 minutes)

**If LayerZero is fully down (known incident):**
- [ ] Post status to Discord/Twitter: "Cross-chain settlement paused due to
      LayerZero infrastructure maintenance. EVM locks are safe; refunds available
      via local fallback after deadline. No user funds at risk."
- [ ] Alert all relayer operators to stop delivery attempts (set `PAUSE_DELIVERY=1`)
- [ ] Do NOT pause the protocol yet; users can still lock (they'll refund locally
      after deadline)

**If LayerZero is intermittently available:**
- [ ] Keep relayer running; it will queue retry attempts
- [ ] Reduce relayer polling frequency to avoid hammering downed endpoints (set
      `POLLING_INTERVAL_MS=60000`)

### Investigation (15 minutes – 1 hour)

1. **Query LayerZero support:**
   - Open a ticket on LayerZero discord / support
   - Provide: network names, affected EIDs, time window, sample nonces
   - Ask for ETA on recovery

2. **Check if there's a known DVN issue:**
   - Log in to LayerZero dashboard (requires admin access)
   - Verify the configured DVN set is operational
   - Check if a DVN went offline (would fail threshold but not completely halt)

3. **Estimate impact:**
   - Count intents created since outage start
   - Calculate total locked value
   - Determine deadline pressure (how many are approaching `deadline`?)

### Recovery (1–24 hours)

**When LayerZero is back online:**

1. **Restart relayer to pick up stalled messages:**
   ```bash
   systemctl restart perihelion-relayer
   ```

2. **Manually trigger any stalled message delivery:**
   - Relayer will automatically retry confirmed-but-undelivered messages
   - Monitor logs for delivery success: `grep "lz_receive delivery"` in settlement
     logs

3. **If relayer stalls again after 30 minutes:**
   - Check if endpoint RPC is still responsive
   - If yes, escalate to LayerZero support again (likely a contract issue)

4. **Handle expiring intents:**
   - After LayerZero recovery, prioritize intents whose deadline is < 24 hours away
   - Relayer will deliver them, or users will take local fallback refund

### Post-resolution

- [ ] Verify all stalled messages were delivered
- [ ] Post-mortem: was this a DVN threshold issue, an RPC outage, or a LayerZero
      contract bug?
- [ ] Update monitoring thresholds if relayer's "no delivery for N minutes" alert
      was too sensitive
- [ ] Document LayerZero SLA expectations

---

## Runbook 3: Source-Chain Reorg

### Scenario

A deep reorg on the EVM chain (≥ 15 blocks, or a specific block that contained a
FillInstruction) invalidates a cross-chain message. The message nonce was already
delivered on Soroban, but the source-chain event is now orphaned. Risk of a
double-settlement if the intent is re-locked after reorg recovery.

### Detection

| Signal | What to check |
|--------|---------------|
| **Manual:** Block explorer shows reorg | Etherscan shows pending blocks reverted |
| **Monitoring:** Relayer reports reorg depth | `REORG_DEPTH_BLOCKS` in logs exceeds threshold |
| **User report:** "Lock appeared, then disappeared" | Lock showed in Etherscan, then vanished |

### Triage (first 5 minutes)

1. **Confirm the reorg depth:**
   ```bash
   # Query the EVM RPC for chain reorganization
   curl -X POST $EVM_RPC -H "Content-Type: application/json" \
     -d '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}'
   
   # Cross-check with another RPC provider; if they differ, reorg in progress
   ```

2. **Identify affected messages:**
   - Check which blocks were reorg'd (e.g., "block 18,000,000 to 18,000,015")
   - Query EVM escrow events in that range: did any `MessageSent` fire there?
   ```bash
   cast logs --address <escrow> --from-block 18000000 --to-block 18000015 \
     "MessageSent" --rpc-url $EVM_RPC
   ```

3. **Determine if messages were already relayed:**
   - For each affected message, check if it was already confirmed and delivered on
     Soroban
   - If delivered: there's a mismatch risk
   - If not delivered: message is orphaned and will need re-relay

### Immediate Containment (first 15 minutes)

**If a message was delivered to Soroban before the reorg:**

1. **Pause the protocol immediately:**
   ```bash
   # EVM: owner-controlled pause (requires timelock)
   # If this is a critical reorg, prepare emergency governance call
   
   # Soroban: admin-controlled immediate pause
   stellar contract invoke --id <settlement-contract> \
     -- set_paused --paused true
   ```

2. **Post status to users:**
   - "EVM chain experienced a reorganization. Cross-chain settlement is paused
     while we verify message integrity. Updates in 30 minutes."

3. **Do NOT allow new locks on EVM** (pause is active)

**If a message was NOT delivered (orphaned):**
- No pause needed; the message is dead and cannot cause double-settlement
- Proceed to recovery

### Investigation (15 minutes – 1 hour)

1. **Map affected intents:**
   - List all messages in the reorg'd blocks
   - For each: is it already settled on Soroban?
   - Build a list of (message nonce, settlement status)

2. **Check for replay risk:**
   - If a message was delivered to Soroban before reorg, it is now:
     - ✗ NOT present in the EVM canonical chain
     - ✓ IS recorded on Soroban (idempotent marker set)
   - Result: No double-settlement risk (idempotency protects us)
   - BUT: The source-chain event is now inconsistent; requires investigation

3. **Understand why the reorg happened:**
   - Was this a known blockchain event (validator outage, consensus issue)?
   - Check EVM chain status page and node operator communications
   - Determine if this is likely to repeat

### Recovery (1–4 hours)

1. **Verify all affected messages on Soroban:**
   ```bash
   # For each message nonce that was reorg'd:
   stellar contract invoke --id <settlement-contract> \
     -- intent_status --intent_hash <hash>
   # Expected: "filled" or "cancelled" (terminal states are safe)
   ```

2. **Restart relayer to re-confirm messages in the extended reorg window:**
   ```bash
   # Relayer should detect the reorg and re-confirm all affected messages
   systemctl restart perihelion-relayer
   # Tail logs and watch for "reorg recovery" messages
   ```

3. **Resume the protocol:**
   ```bash
   # Soroban: admin-controlled unpause
   stellar contract invoke --id <settlement-contract> \
     -- set_paused --paused false
   
   # EVM: requires timelock proposal (if pause was activated)
   # Prepare unpause governance call
   ```

4. **If a message was lost in the reorg:**
   - Relayer will detect it and attempt re-delivery
   - User can also force a local cancel if deadline has passed

### Post-resolution

- [ ] Document the reorg: depth, duration, root cause
- [ ] Verify settlement consistency on both chains
- [ ] Check if relayer's reorg detection / recovery worked correctly
- [ ] Consider adjusting DVN confirmation thresholds if this reorg was deeper than
      expected (>15 blocks is unusual)
- [ ] Post-mortem: did this reorg reveal any protocol gaps?

---

## Runbook 4: Leaked Guardian Key

### Scenario

The EVM guardian key (used only for `pause()`) is compromised. An attacker
repeatedly pauses and unpauses the protocol, creating a denial-of-service state
where the protocol is locked indefinitely. Funds are NOT at risk (pause does not
affect in-flight settlement or unpause capability), but liveness is destroyed.

### Detection

| Signal | What to check |
|--------|---------------|
| **Alert:** `GuardianKeyCompromise` | Unauthorized pause + unpause cycle |
| **Manual:** Multiple pause txs from unknown address | Etherscan shows repeated guardian calls |
| **User report:** "Protocol is in a loop — paused, then unpaused, then paused again" | Unusual state churn |

### Triage (first 2 minutes)

1. **Confirm the guardian key was used:**
   ```bash
   # Check recent guardian-initiated pauses on Etherscan
   cast logs --address <escrow> "PausedSet(bool)" --rpc-url $EVM_RPC \
     --logs-count 10
   # Filter by `msg.sender == guardian`; check timestamps
   ```

2. **Verify the key is actually compromised:**
   - Are the pauses coming from the expected guardian address?
   - If yes: the key is compromised
   - If no: someone else has the key (more severe; escalate to legal + security)

3. **Assess current pause state:**
   ```bash
   cast call <escrow> "paused()" --rpc-url $EVM_RPC
   # true = currently paused; false = currently unpaused
   ```

### Immediate Containment (first 5 minutes)

**CRITICAL: Do NOT waste time on investigation. Rotate the key immediately.**

1. **Revoke the compromised guardian immediately:**
   - The owner (timelock) must call `setGuardian(address(0))` to clear the
     guardian slot
   - This requires a timelock proposal (prepare immediately)
   ```bash
   # Owner (timelock) action:
   stellar multisig propose \
     --operation "setGuardian(address(0))" \
     --contract <escrow>
   # Wait for M-of-N threshold of approvals, then execute after delay
   ```

2. **Spin up a new guardian key:**
   - Generate a new key in hardware wallet or hardware security module
   - Store securely (encrypted vault, not Slack/email/notes)

3. **After timelock clears the old guardian, set the new one:**
   ```bash
   # Owner action (after M-of-N + delay):
   stellar multisig execute --operation "setGuardian(<new-key>)"
   ```

4. **Notify the team:**
   - Post to #security: "Guardian key rotation complete; old key revoked. New
     key is in HSM. No user funds were at risk."

### Investigation (parallel, 5 minutes – ongoing)

While the key rotation is underway in parallel:

1. **Determine the breach source:**
   - Was the key stolen from a developer laptop?
   - Was it leaked in a GitHub commit / CI logs?
   - Was it phished or socially engineered?
   - **Action:** Quarantine the source and start a forensic investigation

2. **Audit guardian usage in the timeframe:**
   - Grep all guardian actions in the past 24 hours
   - Log them for post-mortem analysis

### Recovery (immediately after key rotation)

1. **Verify the new guardian is active:**
   ```bash
   cast call <escrow> "guardian()" --rpc-url $EVM_RPC
   # Should return the new guardian address
   ```

2. **Test the new guardian (in testnet first):**
   - Call `pause()` from the new key to confirm it works
   - Call `unpause()` from the owner to confirm recovery works

3. **Resume normal operations:**
   - No protocol pause is needed
   - Users can still refund locally even if the protocol was paused

### Post-incident review

- [ ] **Mandatory:** Conduct a forensic investigation of the breach
- [ ] **Mandatory:** Review access logs for all admin keys (GitHub, CI, HSM, vault)
- [ ] **Mandatory:** Rotate all other sensitive keys (relayer signer, solver keys)
- [ ] **Update:** Guardian key storage procedures (should be in HSM, not a laptop)
- [ ] **Update:** CI/CD secret management to prevent accidental key leakage
- [ ] **Communication:** Publish a post-mortem on the Perihelion blog (no details
      of the breach, focus on prevention)

---

## Runbook 5: Peer Misconfiguration

### Scenario

The trusted cross-chain peer address was set incorrectly on one chain. Either:
- Soroban `set_peer` was pointed at a wrong EVM address (attacker-controlled)
- EVM `setPeer` was pointed at a wrong Soroban address
- Both sides have mismatched peer addresses

Result: Inbound messages are rejected or forged messages are accepted, breaking
settlement integrity.

### Detection

| Signal | What to check |
|-------|---------------|
| **Manual:** Configuration audit | Comparing peer addresses on both chains |
| **Monitoring:** Signature verification failures | Logs show "peer mismatch" or "invalid sender" |
| **User report:** "Fills aren't working; messages rejected" | Cross-chain settlement broken |

### Triage (first 10 minutes)

1. **Read the peer address on both chains:**
   ```bash
   # EVM side:
   cast call <escrow> "stellarPeer()" --rpc-url $EVM_RPC
   
   # Soroban side:
   stellar contract invoke --id <settlement-contract> \
     -- get_peer --eid <EVM_EID>
   ```

2. **Cross-check against the source of truth:**
   - What is the intended peer address on EVM? (from deployment notes)
   - What is the intended peer address on Soroban? (from deployment notes)
   - Do they match what you just read?

3. **If mismatched:**
   - Determine which side was set incorrectly
   - Determine who set it and when (check git history, governance proposals)

### Immediate Containment (first 15 minutes)

**If an attacker-controlled peer was set:**

1. **Pause the protocol immediately (both chains):**
   ```bash
   # EVM: owner-controlled pause (requires timelock)
   # Soroban: admin-controlled immediate pause
   stellar contract invoke --id <settlement-contract> \
     -- set_paused --paused true
   ```

2. **Alert users:**
   - "Peer address was misconfigured. Settlement is paused while we correct it.
     Your locks are safe and will be refunded after deadline."

3. **Rotate the peer address immediately:**
   ```bash
   # Soroban: admin-controlled
   stellar contract invoke --id <settlement-contract> \
     -- set_peer --eid <EVM_EID> --peer <correct-bytes32>
   
   # EVM: owner-controlled (requires timelock)
   # Prepare governance call
   ```

**If the peer was only slightly wrong (typo in address, not attacker-controlled):**
- Proceed to correction without pausing (users are not at risk)

### Investigation (15 minutes – 1 hour)

1. **Audit peer-change events:**
   ```bash
   # Find all PeerSet events
   cast logs --address <escrow> "PeerSet(bytes32)" --rpc-url $EVM_RPC
   cast logs --address <settlement-contract> "peer_set" \
     --soroban-rpc $SOROBAN_RPC
   # Correlate by timestamp; identify the misconfiguration event
   ```

2. **Determine root cause:**
   - Was this a copy-paste error by an operator?
   - Was a governance proposal approved with wrong data?
   - Was an admin key compromised?
   - **Action:** Review the approval chain and control procedures

3. **Check if messages were forged:**
   - If the wrong peer was set, did any messages pass verification during that
     window?
   - If yes: those messages are FAKE (settlement integrity violated)
   - If no: no settlement occurred; no user funds at risk

### Recovery (30 minutes – 4 hours)

1. **Correct the peer on the affected side:**
   ```bash
   # Soroban (immediate):
   stellar contract invoke --id <settlement-contract> \
     -- set_peer --eid <EVM_EID> --peer <correct-bytes32>
   
   # EVM (requires timelock):
   # Propose and execute via governance
   ```

2. **Verify both sides now match:**
   ```bash
   # Read peer on both sides again
   cast call <escrow> "stellarPeer()" --rpc-url $EVM_RPC
   stellar contract invoke --id <settlement-contract> \
     -- get_peer --eid <EVM_EID>
   # Should now match
   ```

3. **Test a small cross-chain message:**
   - Have a test account lock funds on EVM
   - Verify FillConfirmed is accepted on Soroban
   - Confirm no unexpected rejections

4. **Resume the protocol:**
   ```bash
   # Both chains: unpause
   stellar contract invoke --id <settlement-contract> \
     -- set_paused --paused false
   # EVM requires timelock unpause
   ```

### Post-incident review

- [ ] Add a peer-verification step to all deployment / configuration checklists
- [ ] Implement a peer-verification smart contract check: both sides should verify
      each other's peer address before settling
- [ ] Consider requiring dual-approval (M-of-N) for peer changes
- [ ] Update documentation to emphasize peer-mismatch as a critical config risk

---

## Runbook 6: Suspected Exploit / Value Divergence

### Scenario

The reconciliation job detects a divergence: the sum of EVM-locked funds does not
match the sum of Soroban-settled funds. This suggests either:
- A double-settlement bug (solver repaid twice for one fill)
- A forged FillConfirmed (guardian key leaked, DVN compromised, or peer address
  set to attacker's address)
- A lost refund (funds locked on EVM but not recorded on Soroban)
- A solver extracted value without delivering destination assets

This is a **P0 incident requiring immediate incident commander escalation.**

### Detection

| Signal | What to check |
|-------|---------------|
| **Alert:** `ValueDivergence` fires | Reconciliation detected locked ≠ settled |
| **Manual:** Regular reconciliation audit | Comparing escrow balance against settlement records |

### Immediate Triage (first 2 minutes)

1. **Confirm the divergence is real:**
   ```bash
   # EVM: sum of all locked funds
   # Query escrow storage for Lock entries; sum `amount` field for all
   # locks with released=false and refunded=false
   cast call <escrow> "getTotalLocked()" --rpc-url $EVM_RPC
   
   # Soroban: sum of all settled (filled + refunded) funds
   stellar contract invoke --id <settlement-contract> \
     -- get_total_settled
   
   # Compare: EVM_locked should ≈ Soroban_settled (within a few wei of rounding)
   # If EVM > Soroban: there's unreconciled value on EVM
   # If Soroban > EVM: potential double-settlement or forged message
   ```

2. **Calculate the divergence amount:**
   - Difference = abs(EVM_locked - Soroban_settled)
   - If Difference > 0.1% of TVL: **escalate to incident commander immediately**
   - If Difference < 0.1%: likely a rounding artifact; monitor closely

### Immediate Containment (first 5 minutes)

**If divergence is significant (> 0.1% TVL):**

1. **Pause BOTH chains immediately:**
   ```bash
   # EVM: owner-controlled pause (requires timelock OR guardian emergency pause)
   # If timelock is too slow, guardian can pause for up to 72 hours
   
   # Soroban: admin-controlled immediate pause
   stellar contract invoke --id <settlement-contract> \
     -- set_paused --paused true
   ```

2. **Freeze all admin keys:**
   - Do NOT allow any peer/endpoint/guardian changes until root cause identified
   - Lock governance to prevent further config changes

3. **Notify users immediately:**
   - "Perihelion settlement is paused due to a suspected security incident. All
     user funds are safe. We are investigating and will provide an update within
     2 hours."
   - Post to Twitter, Discord, email all users

4. **Convene the incident commander and security team:**
   - Conference call within 10 minutes
   - Assign roles: incident commander, technical lead, communications lead

### Investigation (30 minutes – 4 hours)

This is a **forensic investigation.** Every step must be documented.

1. **Identify which intents are affected:**
   ```bash
   # For each intent on EVM, cross-reference its status on Soroban
   # Build a mapping: intent_hash → (EVM_status, Soroban_status)
   
   # Query escrow for all locks:
   cast call <escrow> "getLocks()" --rpc-url $EVM_RPC
   
   # For each lock, check settlement status on Soroban:
   stellar contract invoke --id <settlement-contract> \
     -- intent_status --intent_hash <hash>
   
   # Categorize:
   # - [GOOD] Both released or both cancelled
   # - [BAD] EVM released + Soroban cancelled (or vice versa) — double-settlement
   # - [STUCK] EVM released but Soroban still pending — message loss
   # - [FORGED] Soroban released but EVM has no lock — impossible state
   ```

2. **For each BAD / FORGED intent, trace the message:**
   ```bash
   # Find the FillConfirmed message on EVM (should not exist if not released)
   cast logs --address <escrow> "MessageSent()" --rpc-url $EVM_RPC \
     | grep <intent_hash>
   
   # Find the corresponding confirmation on Soroban
   grep "fill_confirmed" /var/log/settlement.log | grep <intent_hash>
   
   # Verify the message was authentic:
   # - Sender == stellarPeer (configured peer address)?
   # - Signature valid (matches the settlement contract's verify function)?
   # - Nonce replay-protected (inboundNonce advanced)?
   ```

3. **If a forged message was detected:**
   - **CRITICAL:** A guardian key OR DVN set OR peer address has been compromised
   - Check which:
     - Was the peer address malicious? (run runbook #5)
     - Was the guardian key misused? (run runbook #4)
     - Was the DVN set compromised? (escalate to LayerZero immediately)

4. **If a double-settlement bug was detected:**
   - This indicates a code bug (not a key/config compromise)
   - Affected intent hash(es) must be locked in escrow and settlement contract
   - Prepare a targeted fix and mitigation

### Recovery (4 – 24 hours)

**Recovery depends on the root cause; follow the corresponding runbook:**

- **Forged message:** Runbook #4 (guardian) or #5 (peer) or escalate to LayerZero
- **Double-settlement code bug:** Require a code fix + redeployment
- **Lost message:** Runbook #1 (stuck message)

**General recovery steps:**

1. **Once root cause is identified and fixed:**
   - Deploy the fix (if code bug) or rotate keys/config (if compromise)
   - Test thoroughly on testnet first

2. **Reconcile diverged intents:**
   - For each affected intent, manually verify correct settlement state
   - If funds need recovery, prepare a draining procedure

3. **Resume the protocol:**
   - Unpause both chains
   - Communicate resolution to users

### Post-incident review (mandatory within 24 hours)

- [ ] **Forensic report:** Document root cause, affected intents, impact
- [ ] **Security review:** Did monitoring / reconciliation catch this in time?
- [ ] **Code review:** If a bug, conduct a full audit for similar issues
- [ ] **Governance review:** Were config/key controls sufficient?
- [ ] **Communication:** Post a full post-mortem (after legal/security review)
- [ ] **Compensation:** If user funds were impacted, prepare a recovery plan

---

## Post-Incident Review

After every incident (severity P1 or higher), conduct a post-mortem within 48
hours.

### Post-Mortem Checklist

- [ ] **Incident summary:** What happened, when, impact, duration
- [ ] **Root cause:** Why did it happen? Single point of failure?
- [ ] **Timeline:** Document key events with timestamps
- [ ] **Detection latency:** How long from occurrence to detection?
- [ ] **Response quality:** Did the runbook work? Were there gaps?
- [ ] **Follow-ups:**
  - [ ] Code fixes (if applicable)
  - [ ] Configuration changes (peer rotation, guardian rotation, etc.)
  - [ ] Monitoring improvements (new alerts, thresholds)
  - [ ] Documentation updates (this runbook, threat model)
  - [ ] Key management improvements
  - [ ] Governance procedures (M-of-N, delays, approvals)

### Drill Schedule

Run incident drills quarterly:

- **Q1:** Stuck message (runbook #1)
- **Q2:** LayerZero outage (runbook #2)
- **Q3:** Guardian key compromise (runbook #4)
- **Q4:** Value divergence (runbook #6)

**Drill requirements:**
- Oncall team must execute the runbook from scratch
- Time the response (goal: containment within 15 minutes)
- Log all actions and observations
- Conduct a debrief immediately after

---

## Related Controls & Resources

**To invoke the controls mentioned in this runbook, see:**

- [Deployment & Operations Runbook](./deployment.md) — pause/unpause procedures,
  timelock operations, key rotation
- [Threat Model](./threat-model.md) — role definitions, compromise scenarios,
  bounding mechanisms
- [Relayer Runbook](./relayer-runbook.md) — relayer restart, cursor recovery,
  message delivery status

**External resources:**

- LayerZero infrastructure dashboard: consult LayerZero support for status
- Stellar CLI: available via `cargo install stellar-cli` or the Stellar documentation site
- EVM RPC tools (cast, curl): See Foundry and curl documentation

**Escalation contacts (update with your team):**

| Role | Contact | Backup |
|------|---------|--------|
| Incident Commander | [TBD] | [TBD] |
| Security Lead | [TBD] | [TBD] |
| Protocol Lead | [TBD] | [TBD] |
| Communications | [TBD] | [TBD] |

---

**Last updated:** July 2026  
**Owned by:** Perihelion Operations Team  
**Review cadence:** Quarterly
