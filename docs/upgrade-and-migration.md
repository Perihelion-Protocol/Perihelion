# Perihelion Contract Upgrade & Migration Runbook

This document specifies the upgrade model for both Perihelion chains and provides
runbooks for migrating to new contract deployments (bug fixes, feature additions,
version cutover, etc.).

---

## Table of Contents

1. [Architecture overview](#architecture-overview)
2. [EVM escrow: immutable design](#evm-escrow-immutable-design)
3. [Soroban settlement: upgradeable design](#soroban-settlement-upgradeable-design)
4. [Version lifecycle](#version-lifecycle)
5. [Migration runbooks](#migration-runbooks)
6. [Governance and disclosure](#governance-and-disclosure)

---

## Architecture Overview

Perihelion runs on two chains with different upgrade stories:

| Chain | Deployment | Upgrade mechanism | Lock strategy |
|-------|-----------|---|---|
| **EVM** | Single immutable instance | Redeploy a new escrow; repoint peers | Drain in-flight locks before cutover |
| **Soroban** | Single upgradeable instance | In-place Soroban upgrade | Can upgrade in-place with care |

**Why different models?**

- **EVM:** Solidity smart contracts cannot be transparently upgraded without a proxy.
  Perihelion chose to avoid proxy complexity (and its security surface) by deploying
  immutable code. The cost is that a bug fix requires a full migration. The benefit
  is simpler code and no delegatecall risks.

- **Soroban:** Soroban contracts support first-class upgrades (the contract WASM code
  can be replaced in-place without redeploying). Perihelion leverages this but **must
  govern upgrades carefully** to prevent a compromised admin from unilaterally
  changing settlement logic.

---

## EVM Escrow: Immutable Design

### What is immutable

| Field | Type | Rationale |
|-------|------|-----------|
| `DOMAIN_SEPARATOR` | bytes32 | EIP-712 domain binds signatures to the exact contract. Cannot change. |
| `endpoint` | address | LayerZero endpoint is baked in at deploy time. Changing it requires a new contract. |
| `stellarEid` | u32 | EID is protocol-level and immutable. A new EID would be a new Stellar instance. |
| **Contract code** | (all logic) | The entire contract logic is immutable. |

### What is configurable (via governance)

| Field | Mutation | Governance |
|-------|----------|-----------|
| `stellarPeer` | `setPeer(bytes32)` | Owner (timelock) |
| `confirmationGrace` | `setConfirmationGrace(uint256)` | Owner (timelock) |
| `guardian` | `setGuardian(address)` | Owner (timelock) |
| `paused` | `setPaused(bool)` / `pause()` | Owner or guardian |
| `owner` | `transferOwnership()` / `acceptOwnership()` | Two-step handover (owner + new owner) |

### Consequences of immutability

**Consequences if a bug is found:**
1. Cannot patch in place — must redeploy a new escrow contract
2. Requires re-wire with Soroban: old peer address is now orphaned, must repoint
3. Requires draining in-flight locks to the new escrow
4. Users and solvers must trust the new address

**Mitigation:**
- Aggressive testing and formal verification (see [formal-specification.md](./formal-specification.md))
- Code audit before mainnet launch
- Gradual rollout (testnet → low-TVL mainnet → full mainnet)
- Community monitoring of gas usage and settlement patterns

---

## Soroban Settlement: Upgradeable Design

### Upgrade capability

Soroban contracts support **in-place code replacement** via the standard Soroban
upgrade mechanism. The admin can invoke:

```bash
stellar contract upgrade --wasm <new-wasm-path> --contract <contract-id> --network <network> --source <admin-key>
```

This atomically replaces the WASM code without touching storage or state.

### Storage/state invariants

The following **MUST be preserved** across upgrades:

- `Admin` — The admin address cannot change in storage. Whoever holds the admin
  key remains admin after upgrade. (If you want to rotate the admin key, use the
  `set_admin` + `accept_admin` two-step flow, not a storage mutation.)

- `Endpoint` — The LayerZero endpoint address is configuration, not immutable.
  An upgrade can change it via `set_endpoint`, but doing so is high-risk (misdirects
  all inbound messages). Not recommended.

- `Peer(eid)` — Peer addresses are configuration. They survive upgrades. After an
  upgrade, the peer registration is still in place unless an admin action removes it.

- Intent storage (`Intent(hash)`, `Settled(hash)`, `Cancelled(hash)`) — All settled
  intents are persisted in storage. An upgrade cannot erase a settled intent.
  Continuing to respect this invariant is critical: if the new code accidentally
  allows re-settlement of an already-settled intent, it violates I2.

### Governance

**Current state:** Soroban settlement admin is a single account (address).
This account can unilaterally upgrade the contract.

**Risk:** If the admin key is compromised, an attacker can immediately push a
malicious new contract that accepts forged fills or steals settlement records.

**Recommendation:** Soroban settlement admin should be governed by a timelock or
multisig (similar to the EVM owner). This is future work (see roadmap below).

**For now (Phase 1):** The admin key must be:
- Held in a hardware security module (HSM) or multisig account
- Never hot-stored
- Rotated regularly
- Monitored for unexpected upgrade transactions

### Version strategy

Soroban contracts use semantic versioning in their storage and configuration.
Perihelion follows this pattern:

**Contract version:** Stored in code (not in storage), so it changes only on upgrade.
The version is visible in logs and events only if explicitly emitted.

**Recommendation:** Before any upgrade, emit an `upgraded` event:
```rust
pub fn upgrade_contract(env: Env, new_version: u32) -> Result<(), PerihelionError> {
    Self::require_admin(&env)?.require_auth();
    env.events().publish(
        (Symbol::new(&env, "upgraded"),),
        (new_version, env.ledger().timestamp()),
    );
    Ok(())
}
```

This gives monitoring systems (indexers, relayers, dashboards) a signal that the
contract has changed.

---

## Version Lifecycle

### Version numbering

Perihelion uses semantic versioning: `MAJOR.MINOR.PATCH`

| Version | Scope | Governance | Rollout |
|---------|-------|-----------|---------|
| **MAJOR** | Breaking change to wire format, intent hash, peer semantics | Requires user action (new SDK) | Coordinated cutover, period of dual-version support |
| **MINOR** | New feature (e.g., per-eid pause), new entrypoint | Admin decision | Can be deployed immediately if backward-compatible |
| **PATCH** | Bug fix, optimization (same wire format) | Admin decision | Can be deployed immediately |

### Backward compatibility

- **MAJOR version bumps break compatibility.** A user's intent signed against v1 wire
  format cannot be accepted by v2. Both chains must upgrade atomically (or during a
  cutover window).

- **MINOR/PATCH versions maintain compatibility.** A v1.1 escrow can still process
  intents from a v1.0 SDK as long as the wire format unchanged.

### Version-negotiation (Phase 2)

**Future feature:** A version-negotiation handshake between EVM and Soroban to
detect incompatibilities at runtime. For now, upgrades must be coordinated
manually.

---

## Migration Runbooks

### Scenario A: PATCH or MINOR upgrade (no wire format change)

**Examples:** Gas optimization, internal refactoring, new governance feature.

#### EVM side: Not applicable

Immutable contract. No upgrade.

#### Soroban side

1. **Build the new WASM:**
   ```bash
   cd contracts/soroban
   cargo build --target wasm32-unknown-unknown --release
   ```

2. **Verify bytecode determinism:**
   ```bash
   # Compare against known-good hash or build artifact
   sha256sum target/wasm32-unknown-unknown/release/perihelion_settlement.wasm
   ```

3. **Upgrade on testnet first:**
   ```bash
   stellar contract upgrade --wasm target/wasm32-unknown-unknown/release/perihelion_settlement.wasm \
     --contract <testnet-settlement-id> \
     --network testnet \
     --source-account <admin-account> \
     --source-secret-key <admin-secret>
   ```

4. **Verify settlement state integrity:**
   ```bash
   # Query a known settled intent; verify it's still recorded
   stellar contract invoke --id <settlement-id> \
     -- intent_status --intent_hash <known-hash>
   # Should return "filled" or "cancelled", not error
   ```

5. **Upgrade on mainnet** (with appropriate governance delays/approvals):
   ```bash
   stellar contract upgrade --wasm target/wasm32-unknown-unknown/release/perihelion_settlement.wasm \
     --contract <mainnet-settlement-id> \
     --network public \
     --source-account <admin-account> \
     --source-secret-key <admin-secret>
   ```

6. **Emit an `upgraded` event** (if the new version includes this):
   ```bash
   stellar contract invoke --id <settlement-id> \
     -- upgrade_contract --new_version <version-number>
   ```

7. **Monitor settlement for 1 hour:**
   - Watch logs for any unexpected errors
   - Verify settlement transactions are still being processed
   - Confirm fills and cancels work end-to-end

---

### Scenario B: MAJOR upgrade or bug fix (requires redeployment)

**Examples:** Critical security fix, wire format change, new intent structure.

#### Phase 1: Drain in-flight locks (both chains)

**Duration:** 1-4 hours (until all pending locks resolve)

**Actions:**

1. **Pause both chains to prevent new locks:**
   ```bash
   # EVM (via timelock governance):
   # Propose and execute setPaused(true)
   
   # Soroban (admin-controlled):
   stellar contract invoke --id <settlement-id> \
     -- set_paused --paused true
   ```

2. **Monitor in-flight intents:**
   - Wait for all pending `FillInstruction`s to be processed on Soroban
   - Wait for all `FillConfirmed` / `CancelIntent` messages to arrive on EVM
   - Query both sides to confirm all locks are in terminal state (filled or refunded)
   ```bash
   # EVM: count locks that are NOT released and NOT refunded
   # Soroban: count intents that are NOT in {Filled, Cancelled}
   ```

3. **If any intents remain unresolved after a timeout:**
   - Manually cancel/refund them using admin operations
   - Document which intents needed manual intervention and why

#### Phase 2: Deploy new contracts (opposite order from initial deploy)

1. **Deploy new Soroban settlement contract:**
   ```bash
   cd contracts/soroban
   cargo build --target wasm32-unknown-unknown --release
   
   # Deploy new contract. The contract has a constructor (issue #910), so the
   # admin, endpoint and native token are passed at deploy time; there is no
   # separate `initialize` call.
   stellar contract deploy --wasm target/wasm32-unknown-unknown/release/perihelion_settlement.wasm \
     --network public \
     --source-account <deployer> \
     -- --admin $ADMIN --endpoint $LZ_ENDPOINT --native_token $NATIVE_TOKEN
   # -> note the new $SETTLEMENT_V2 address
   ```

2. **Deploy new EVM escrow contract:**
   ```bash
   cd contracts/evm
   forge build
   
   export PERIHELION_ENDPOINT=0xLZEndpoint
   export PERIHELION_STELLAR_EID=30316
   export PERIHELION_STELLAR_PEER=<settlement_v2-as-32-bytes>
   export PERIHELION_GUARDIAN=0xGuardian
   export PERIHELION_OWNER=$TIMELOCK
   forge script script/Deploy.s.sol --rpc-url "$RPC" --broadcast
   # -> note the new $ESCROW_V2 address
   ```

#### Phase 3: Wire new contracts to each other

1. **On new Soroban settlement, set the new EVM escrow as peer:**
   ```bash
   stellar contract invoke --id $SETTLEMENT_V2 \
     -- propose_peer --eid $EVM_EID --peer <escrow_v2-as-32-bytes>
   
   # Wait for the delay to expire
   sleep $((MIN_PEER_CHANGE_DELAY + 10))
   
   stellar contract invoke --id $SETTLEMENT_V2 \
     -- confirm_peer --eid $EVM_EID
   ```

2. **On new EVM escrow, set the new Soroban settlement as peer** (via timelock):
   ```bash
   # Propose setPeer via timelock governance
   CALLDATA=$(cast calldata "setPeer(bytes32)" <settlement_v2-as-32-bytes>)
   # Then propose → confirm (×M) → wait → execute via the timelock
   ```

3. **Verify both sides are wired:**
   ```bash
   # EVM: check stellarPeer
   cast call $ESCROW_V2 "stellarPeer()" --rpc-url $EVM_RPC
   
   # Soroban: check peer for EVM eid
   stellar contract invoke --id $SETTLEMENT_V2 \
     -- get_peer --eid $EVM_EID
   ```

#### Phase 4: Cutover and verification

1. **Unpause both contracts:**
   ```bash
   # EVM (via timelock):
   # Propose and execute setPaused(false)
   
   # Soroban (admin):
   stellar contract invoke --id $SETTLEMENT_V2 \
     -- set_paused --paused false
   ```

2. **Run a small end-to-end test transfer:**
   - User locks funds on new escrow (`$ESCROW_V2`)
   - Solver fills on new settlement (`$SETTLEMENT_V2`)
   - Verify the entire flow works

3. **Announce the cutover to users:**
   - Post on Discord/Twitter: "Perihelion has migrated to new contracts at [EVM
     address] and [Soroban address]. Old contract is no longer operational."
   - Provide new contract addresses and update SDK if necessary

#### Phase 5: Decommission old contracts (optional)

Old contracts can be left in place (paused) as a safety measure, in case a critical
bug is discovered in the new version and a quick rollback is needed. Eventually:

1. **Drain all remaining funds from old escrow** (if any) and transfer to multisig
2. **Document the old contract addresses** for audit/archival
3. **Retire the old contract** (optional; it can remain paused forever)

---

### Scenario C: Version-incompatible SDK (major protocol change)

**Example:** A wire-format change forces users to upgrade their SDK.

#### Dual-version support period

To minimize user disruption, support both old and new versions for a grace period:

1. **Announce the deprecation 2-4 weeks in advance:**
   - Blog post: "Perihelion protocol v2 launches on [date]. SDK v1 support ends on
     [date + 2 weeks]."
   - Provide upgrade guide

2. **Deploy new contracts (following Scenario B)** with the new wire format

3. **Leave old contracts running and unpaused** for 2 weeks so users can finish
   settling their old intents

4. **During the 2-week window:**
   - New locks must use the new contract (new SDK points to new contract address)
   - Old locks can still settle via the old contract (old SDK still works)

5. **After 2 weeks, pause the old contract** to prevent new locks:
   ```bash
   # Set PerihelionEscrow_V1.paused = true
   ```

6. **After 30 days, drain and archive the old contract** (all locks should be resolved)

---

## Governance and Disclosure

### Before any upgrade (mainnet)

1. **Code audit:** External audit of changes (security + correctness)
2. **Testnet verification:** Full end-to-end testing on testnet
3. **Governance approval:** M-of-N multisig (EVM owner, Soroban admin multisig) approval
4. **Public announcement:** 24-72 hour notice before upgrade, with change summary
5. **Monitoring setup:** Dashboards and alerts to detect upgrade problems

### During upgrade

- Oncall team monitoring logs and metrics in real-time
- Incident commander on standby
- Rollback plan pre-written and tested (in case of critical bug)

### After upgrade

- [ ] Verify settlement is working (sample fills and cancels)
- [ ] Check that no intents were lost or duplicated
- [ ] Monitor for unusual gas usage or latency
- [ ] Post-mortem if anything unexpected occurred

### Trust model disclosure

**Users should know:**

1. **EVM is immutable** — If a bug is discovered, upgrading requires deploying a new
   contract and migration. Users must trust the migration process.

2. **Soroban is upgradeable** — The admin can change the contract code instantly
   (modulo governance delays). Malicious code pushed to Soroban could intercept
   settlement. The admin must be properly governed (HSM/multisig, never hot-stored).

3. **Version mismatch risk** — If EVM and Soroban run different versions with
   incompatible wire formats, settlement will fail. The team must coordinate
   upgrades.

4. **Wire format is permanent** — The EIP-712 domain, intent hash, and message
   encoding are canonical. Users' signed intents depend on these staying constant
   (or a MAJOR version requiring new signatures).

### Change summary template

Post this with every upgrade announcement:

```
Perihelion Upgrade Notice
=========================
Effective: [date/time UTC]
Severity: [PATCH | MINOR | MAJOR]

## Chains
- [ ] EVM: new escrow at 0x[...]
- [ ] Soroban: upgraded in-place
- [ ] Both chains are backward compatible with SDK [versions]

## Changes
- [Brief summary of bug fix / feature]
- [Any user action required? Re-lock? Resync? No]

## Monitoring
- Mainnet deployment: [block/ledger height]
- Expected cutover: [duration]
- Status dashboard: [URL]

## Support
- Questions: [Discord channel]
- Bug reports: [security@perihelion.xyz]
```

---

## Roadmap

### Phase 1 (Current): Immutable EVM, upgradeable Soroban

- EVM: Full migration runbook (§ Scenario B)
- Soroban: Admin-controlled upgrades (no governance delay)
- Coordination: Manual, via Discord / GitHub

### Phase 2 (Q3 2026): Soroban timelock governance

- Implement Soroban timelock equivalent (similar to EVM)
- Require M-of-N approval + delay for upgrades
- Binds Soroban admin to same governance rigor as EVM owner

### Phase 3 (Q4 2026): Version negotiation

- Add version handshake in `lz_receive` / `fill_intent`
- Detect incompatibilities and reject old-version messages on new contracts
- Enables safer dual-version support windows

### Phase 4 (2027): Formal verification of migration invariants

- Prove that intent state survives upgrades (storage invariants)
- Prove that old intents can be settled in new contracts
- Codify in Certora / Halmos rules

---

## References

- [Deployment & Operations](./deployment.md) — Initial deployment procedures
- [Threat Model](./threat-model.md) — Role definitions, admin risks
- [Formal Specification](./formal-specification.md) — Invariant definitions
- [Incident Response](./incident-response.md) — How to handle upgrade rollback

---

**Status:** Documented; dual-chain strategy in place.  
**Last updated:** July 2026  
**Owned by:** Protocol Engineering & Operations  
**Review cadence:** Quarterly or after each upgrade
