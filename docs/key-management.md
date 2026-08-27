# Key Management & Rotation Procedures

This document specifies how each privileged and operational key in Perihelion is
generated, stored, used, monitored, and rotated in production. It covers the
protocols for each key's compromise-response playbook and references the on-chain
controls that enforce rotations.

See [threat-model.md](./threat-model.md) for the threat context and [deployment.md](./deployment.md)
for the deployment topology.

---

## Local Development Setup

For local development and testing with `docker-compose up`, sensitive keys must be
provided via a `.env` file at the repository root. This keeps credentials out of
version control and prevents accidental exposure.

**Setup:**
1. Copy the template: `cp .env.example .env`
2. Edit `.env` and set the required variables:
   - `SIGNER_SECRET`: Relayer signing key (Stellar secret)
   - `PERIHELION_EVM_PRIVATE_KEY`: Solver's EVM private key (hex)
   - `PERIHELION_SOROBAN_SECRET_KEY`: Solver's Soroban signing key (Stellar secret)
3. Run `docker compose up` — it will read `.env` automatically and fail with a
   clear message if any required variable is missing.

**Important:** The all-zero values in `.env.example` are safe test keys (control no
real assets) but must never be used in staging or production. Always generate fresh
keys for each deployment environment.

---

## Key Inventory

| Key role | Layer | Held by | Purpose | Signing frequency | Sensitivity |
|---|---|---|---|---|---|
| **Timelock owners** | EVM | M-of-N multisig (hardware wallets) | Governance: `setPeer`, `setGuardian`, `setConfirmationGrace`, `setPaused`, ownership rotation | Low (≤1 tx per week typically) | Critical |
| **Guardian** | EVM | Hot key or 1-of-N Safe | Emergency pause: `pause()` | Very low (only during incidents) | High |
| **Soroban admin** | Stellar | Multisig account | Settlement contract config: `set_endpoint`, `set_peer`, `set_admin`, `set_paused` | Low (≤1 tx per month typically) | Critical |
| **Relayer signing key** | Off-chain | Relayer operator | Signs LayerZero messages for replay guards | Medium (1+ tx per transfer) | High |
| **Relayer RPC key** | Off-chain | Relayer operator | Authenticates RPC queries and relay submissions | Medium | Medium |
| **Solver signing key** | Off-chain | Solver operator | Signs fill instructions on Stellar | Medium (1+ tx per fill) | High |
| **Soroban endpoint admin** | Stellar | LayerZero governance | LayerZero DVN/ULN config (set by LZ, not Perihelion) | N/A (external) | Critical |
| **EVM deployer key** | EVM | Deployment operator | One-time: contract deployment | Very low (deployment only) | High during deployment, none afterward |

---

## 1. Timelock Owners (EVM Governance)

### 1.1 Generation

**Prerequisites:** Each owner is held by a distinct person or entity.

**Hardware wallet setup:**
1. Each owner generates a keypair on a hardware wallet (Ledger, Trezor, ColdCard, etc.)
2. Export the public key and derive the EVM address
3. Verify the address independently (read it back from the device display)
4. Share the address with the deployment coordinator

**Account structure:** The timelock multisig is deployed with the owner addresses
baked in; changing the owner set requires a governance vote (M-of-N proposal →
confirm → delay → execute).

### 1.2 Storage & Access Control

**Storage:**
- **Private keys:** Held exclusively on the hardware wallet device; never exported
- **Public addresses:** Documented in the deployment record (shareable, non-sensitive)
- **Secret backups:** Each owner has a device backup phrase in their own secure location
  (hardware wallet encrypted backup, paper seed in safe, etc.); do **not** share with
  other owners or the deployment coordinator

**Access control:**
- Each owner controls their own hardware wallet independently
- No single person holds multiple keys
- For a 2-of-3 timelock, any 1 owner can prevent governance deadlock by
  calling `timelock.cancel()` (intentional; see [deployment.md](./deployment.md#9-incident-response-summary))

### 1.3 Operational Use

**Governance proposal flow:**

1. **Propose** (initiator, any owner):
   ```bash
   CALLDATA=$(cast calldata "<function>(<types>)" <args>)
   SALT=<random-32-bytes>
   cast send $TIMELOCK "propose(address,uint256,bytes,bytes32)" \
     $TARGET $VALUE $CALLDATA $SALT --private-key $OWNER_KEY
   ```

2. **Confirm** (threshold−1 other owners):
   Each owner signs a confirmation transaction:
   ```bash
   OPERATION_ID=$(cast call $TIMELOCK "hashOperation(address,uint256,bytes,bytes32)" \
     $TARGET $VALUE $CALLDATA $SALT)
   cast send $TIMELOCK "confirm(bytes32)" $OPERATION_ID --private-key $OWNER_KEY
   ```
   Once threshold confirmations are reached, the delay timer starts.

3. **Wait** (automated):
   The operation is public and actionable by anyone after `DELAY` seconds.

4. **Execute** (any owner or automated keepers):
   ```bash
   cast send $TIMELOCK "execute(address,uint256,bytes,bytes32)" \
     $TARGET $VALUE $CALLDATA $SALT --private-key $OWNER_KEY
   ```

**Key best practices:**
- Propose and confirm from separate signing sessions (network isolation)
- Verify the target address and calldata in a separate terminal before signing
- Use hardware wallet screens to confirm the destination and value (should always be 0 for Perihelion calls)
- Keep hardware wallet firmware up to date

### 1.4 Monitoring

**On-chain:**
- Monitor `timelock.Proposed` events: any unknown proposals may indicate a
  leaked owner key
- Check `timelock.Confirmed` to watch the confirmation window
- Alert on `timelock.Executed`: verify it matches the expected operation

**Off-chain:**
- Subscribe to a block explorer API or event watcher (e.g., Alchemy Notify) to
  alert on timelock operations
- Keep a governance calendar: log every proposal by timestamp, target, and expected execution date
- Cross-check calendar with on-chain events weekly

**Canary state:**
- `escrow.guardianPauseCooldownUntil != 0` in production: indicator that the
  guardian may have been compromised and rotated; escalate to incident response

### 1.5 Rotation

**Planned rotation (per governance policy):**
- Recommended cadence: Every 12 months (or per corporate policy)
- Process: `timelock.removeOwner()` + `timelock.addOwner()` via governance vote
  - Must maintain threshold after removal (i.e., do not reduce from 2-of-3 to
    1-of-2; add the new owner first if needed, then remove)
- Timing: Schedule during a maintenance window; verify no pending operations
  will be affected by the delay

**Emergency rotation (suspected compromise):**

**Signs of compromise:**
- Unauthorized proposal submitted from an unknown governance action
- Governance confirmations from keys you don't recognize
- Hardware wallet theft or loss
- Device compromise (malware, physical tampering)

**Response steps (IMMEDIATE — do not delay):**

1. **Notify co-owners** (within 1 hour):
   - Call or message all other owners
   - State: which key is compromised, what was observed

2. **Propose emergency owner swap** (within 2–4 hours):
   - Use an uncompromised owner's key to propose `removeOwner(compromised_address)` +
     `addOwner(new_address)`
   - Ensure the new key is generated on a fresh, air-gapped device before submitting
   - Set proposal details in a side-channel (Slack, email) so all owners can coordinate

3. **Confirm quorum** (within 4–24 hours):
   - All owners except the compromised one confirm the proposal
   - If threshold is 2-of-3, this gives you 2 confirmations (>= threshold)
   - **Important:** Do not allow the compromised owner to confirm

4. **Wait delay** (e.g., 48 hours):
   - Public governance window; security teams can audit the proposal
   - If the attacker has access to the compromised key, they can `cancel()` the
     proposal (1-of-N cancel), **which is acceptable** — it forces re-coordination
     with the owner that holds the compromised key off-chain

5. **Execute** (after delay):
   - Any uncompromised owner or automated keepers can execute
   - Verify on-chain that `escrow.owner() == timelock` and timelock member set
     reflects the change

6. **Post-rotation audit:**
   - Review all pending proposals; `cancel()` any unknown ones
   - Check event logs from the past 7 days for unauthorized governance
   - Rotate the hardware wallet used for the compromised key (destroy the device
     or factory reset and re-import a new seed)

**Time budget:** Emergency rotations should complete in **≤72 hours** (the
guardian pause is limited to 72 hours of downtime; a government takeover must
resolve within that window or users can force a protocol resumption).

---

## 2. Guardian Key (EVM Emergency Pause)

### 2.1 Generation

**Options:**
1. **Single hardware wallet** (preferred for mainnet):
   - Generated on a single hardware device held by an operations lead
   - Backed up to a hardware wallet backup phrase in secure storage
   - No redundancy; loss means loss of emergency pause capability until rotated

2. **1-of-N Safe** (for redundancy; Phase 2):
   - Deploy a Gnosis Safe with N signers, threshold 1
   - Each signer holds one key; any one can call `pause()`
   - Easier rotation: add/remove signers without timelock delay
   - Higher operational overhead

**Recommendation for Phase 1:** Single hardware wallet held by the operations
lead. Upgrade to a 1-of-N Safe post-audit if incident response speed is critical.

### 2.2 Storage & Access Control

**Storage:**
- **Private key:** Hardware wallet only; never exported or printed
- **Backup phrase:** Stored in a physical safe or cryptographic backup service
  (Verifund, Casa, etc.); accessible only in a key rotation or disaster recovery
- **Access level:** Single person (operations lead) or on-call rotation

**Access control:**
- Only the operations lead can call `pause()`
- No shared access; if the key holder is unavailable, pause is unavailable
  until a new guardian is rotated in (timelock delay: 48 hours)

### 2.3 Operational Use

**Emergency pause** (single transaction):
```bash
cast send $ESCROW "pause()" --private-key $GUARDIAN_KEY --gas-price <priority>
```

The transaction should:
- Use a high gas price (to ensure rapid inclusion)
- Be submitted via multiple relays if available (Flashbots, public mempool)
- Be logged immediately to a monitoring system (e.g., Datadog, PagerDuty) for
  alerting to on-call teams

**Pause semantics:**
- `paused() == true` ⟹ new `lock()` calls revert; existing `lzReceive` messages
  still process (settlement completes in flight)
- Pause is not pausable by the guardian; only the timelock owner can call
  `setPaused(false)` (governance-only unpause)

### 2.4 Monitoring

**On-chain:**
- Subscribe to `PerihelionEscrow.Paused` events
- Alert on every pause (expected only during incidents)
- If pause is called more than once in 7 days without incident acknowledgment,
  escalate

**Off-chain:**
- Guardian key should have no standing balance; fund it per-use if needed
- Monitor hardware wallet for unauthorized transactions

### 2.5 Rotation

**Planned rotation:**
- Recommended cadence: Every 6 months (or per corporate policy; more frequent than
  timelock because it is hotter)
- Process: `timelock.setGuardian(new_address)` via governance vote
  - Public for the timelock delay (48 hours)
  - Unpaused by the timelock owner (no emergency halt needed)
  - Old guardian key can no longer call `pause()` after execution

**Emergency rotation (suspected compromise):**

**Signs of compromise:**
- Repeated unauthorized pauses (more than once without incident)
- Guardian key theft or loss
- Device compromise

**Response steps (IMMEDIATE — within 1 hour):**

1. **Assess impact:**
   - Is the protocol paused? If yes, has it been paused >2 times in the past 7 days?
   - Check `escrow.guardianPauseCooldownUntil`: if non-zero, the key was previously
     considered compromised and is in cooldown (acceptable; automatic protection)

2. **Propose new guardian:**
   - Any timelock owner proposes `setGuardian(new_address)`
   - New address should be a fresh key on a secure device
   - Announce proposal to all owners and monitoring teams

3. **Confirm & wait:**
   - Timelock owners confirm the proposal (M-of-N)
   - Public window for security review: 48 hours

4. **Execute & verify:**
   - Execute after delay
   - Confirm on-chain: `escrow.guardian() == new_address`
   - Old key can no longer pause

5. **Post-rotation:**
   - Disable/destroy the compromised guardian key (do not repurpose)
   - Review pause events from the past 7 days
   - Drill the new guardian key with the on-call team

**Time budget:** Rotation completes in ~**50 hours** (2 hours for proposal + 48
hour timelock delay). During that window, the old key can still pause; if you
suspect imminent abuse, coordinate off-chain with the timelock owners to
expedite.

---

## 3. Soroban Admin (Stellar Settlement)

### 3.1 Generation

**Multisig account setup:**
```bash
stellar account create \
  --secret-key <secret>   # Derived from a Stellar keypair generator or HD wallet
  --testnet | --mainnet
```

**Recommendation:** Use a Stellar multisig with M-of-N signers (e.g., 2-of-3).
The admin set is stored on-chain in the `Perihelion::admin` field.

**HD wallet derivation (for determinism):**
- Use BIP44 path: `m/44'/148'/0'` (standard for Stellar on hardware wallets)
- Each signer derives their key from the same seed phrase (shared) or separate
  seeds (distributed)
- Distributed is preferred for security; shared is acceptable if the seed phrase
  is held only during setup and then destroyed

### 3.2 Storage & Access Control

**Storage:**
- **Private keys:** Held on hardware wallets or encrypted local storage (HSM /
  KMS for production)
- **Admin address:** Published on-chain in the settlement contract
- **Multi-signature:** Require N-of-M signers to submit an admin transaction

**Access control:**
- Each signer controls their own key
- Transactions are signed off-chain (e.g., via a signing service) and then
  submitted to Stellar by any operator

### 3.3 Operational Use

**Admin action (e.g., peer rotation):**

1. **Prepare the transaction:**
   ```bash
   stellar contract invoke --id $SETTLEMENT -- set_peer \
     --eid $EVM_EID --peer $ESCROW_ADDRESS \
     --source-account $ADMIN_ACCOUNT \
     --simulate
   ```

2. **Sign (M signers independently):**
   Each signer signs the transaction envelope:
   ```bash
   stellar tx sign --transaction-envelope $ENVELOPE --secret-key $SIGNER_KEY
   ```

3. **Submit** (any operator, after threshold signatures):
   ```bash
   stellar tx submit $SIGNED_ENVELOPE
   ```

### 3.4 Monitoring

**On-chain (Soroban events):**
- Subscribe to `Perihelion::set_peer` events
- Alert on unexpected peer changes
- Subscribe to `Perihelion::set_admin` events

**Stellar ledger checks:**
- Periodically verify `Perihelion::admin == expected_multisig_address`
- Verify `Perihelion::endpoint == expected_lz_endpoint`

### 3.5 Rotation

**Planned rotation:**
- Recommended cadence: Every 12 months
- Process: `set_admin(new_admin)` via existing admin multisig
  - Immediate (no timelock on Stellar)
  - Old admin loses all powers after execution

**Emergency rotation (suspected compromise):**

**Signs of compromise:**
- Unexpected `set_peer` or `set_endpoint` invocations
- Signer key theft or device compromise
- Unauthorized Stellar transactions from admin account

**Response steps:**

1. **Assess:**
   - Did a bad peer/endpoint get set? Check `Perihelion::peer` and `Perihelion::endpoint`

2. **Propose new admin:**
   - Current admin (with enough uncompromised signers) proposes `set_admin(new_multisig_address)`
   - New multisig should have a fresh set of signers on new keys

3. **Sign & submit:**
   - Uncompromised signers sign the transaction
   - Submit immediately (no delay)

4. **Verify:**
   - Confirm on-chain: `Perihelion::admin == new_address`
   - Compromised keys lose all privileges

5. **Post-rotation:**
   - Audit Stellar transaction history for unauthorized activity
   - Rotate all signer keys to fresh hardware/KMS instances

**Time budget:** Rotation is **immediate** (no timelock); deployment typically
completes in **≤30 minutes** once signers are coordinated.

---

## 4. Relayer Signing Key (Off-chain Message Signing)

### 4.1 Generation

**Stellar keypair for message replay guard:**
```bash
stellar keypair generate
# -> public/secret keypair
```

**Stellar keypair + LayerZero signing (for relayer multi-chain operation):**
- Use the same Stellar keypair (no need for separate keys per chain)
- Relayer configuration binds this key to the relayer's identity

### 4.2 Storage & Access Control

**Storage:**
- **Secret key:** Stored in the relayer process's environment (ENV or secure
  config store; encrypted at rest)
- **Public key:** Published in relayer config for downstream verification
- **Access:** Only the relayer process has access; no human should handle it
  regularly

**Access control:**
- The secret key should never be printed or shared
- Rotate on suspicion of leak or process compromise
- Use a secrets management system (HashiCorp Vault, AWS Secrets Manager) for
  production

### 4.3 Operational Use

**Signing a LayerZero message for delivery:**

The relayer automatically signs outbound messages:
1. Encode the message payload (FillConfirmed, CancelIntent, etc.)
2. Hash the payload with the source/dest EID and nonce
3. Sign with the relayer's secret key
4. Attach signature to the message envelope

(This is done internally by the relayer; no manual step.)

### 4.4 Monitoring

**On-chain (LayerZero):**
- Monitor message delivery logs (LayerZero explorer or events)
- Alert on failed signature verification (indicates corrupted key or message)
- Alert on missing relayer messages (indicates relayer downtime)

**Off-chain:**
- Monitor relayer process logs for signing errors
- Alert on relayer crashes or hangs

### 4.5 Rotation

**Planned rotation:**
- Recommended cadence: Every 3 months (or when relayer software is updated)
- Process:
  1. Generate a new keypair
  2. Update relayer config with new secret key
  3. Restart relayer
  4. Verify messages are signing correctly in logs
  5. Securely destroy the old key

**Emergency rotation (suspected compromise):**

**Signs of compromise:**
- Invalid signature errors in LayerZero logs (relayer key corrupted or leaked)
- Unauthorized LayerZero messages signed with the relayer's key
- Relayer process exploit or compromise

**Response steps:**

1. **Immediate:**
   - Stop the relayer process
   - Revoke the compromised key in any secrets store (Vault, Secrets Manager)
   - Do not restart until the key is rotated

2. **Rotate:**
   - Generate a new keypair on a fresh device or secure generator
   - Update relayer config (encrypted) with the new secret
   - Restart relayer with the new key

3. **Verify:**
   - Check relayer logs for successful message signing with the new key
   - Submit a test transfer and verify it settles

4. **Post-rotation:**
   - Audit LayerZero message history; identify any messages signed with the old key
   - Investigate whether any malicious messages were delivered
   - Review relayer logs and system access logs for signs of compromise

**Time budget:** Rotation is **<15 minutes** (generate key + update config +
restart). Message delivery resume is **immediate** after restart.

---

## 5. Relayer RPC Key (Off-chain RPC Authentication)

### 5.1 Generation & Storage

**API key for RPC access (e.g., Alchemy, Infura):**
- Generated in the RPC provider's dashboard
- Stored in the relayer process's environment (encrypted at rest)

### 5.2 Rotation

**Planned rotation:** Every 6 months
- Disable the old key in the RPC provider dashboard
- Update relayer config with the new key
- Restart relayer and verify RPC calls succeed

**Emergency rotation (suspected abuse):**
- Disable old key immediately
- Check the RPC provider's rate-limit and usage logs for unauthorized calls
- Issue a new key and restart

**Time budget:** **<5 minutes**

---

## 6. Solver Signing Key (Off-chain Fill Instructions)

### 6.1 Generation

**Stellar keypair for settlement signing:**
```bash
stellar keypair generate
```

### 6.2 Storage & Access Control

**Storage:**
- **Secret key:** Held in the solver's local HSM or KMS (e.g., AWS KMS, HashiCorp Vault)
- **Public key:** Public; solver identity is tied to this key
- **Access:** Only the solver process has access

### 6.3 Operational Use

**Signing a fill instruction on Stellar:**
The solver signs all outbound fill/cancel transactions with this key (automatic).

### 6.4 Monitoring

**On-chain (Soroban):**
- Monitor `on_fill_instruction` invocations: verify the solver address matches
- Alert on fill rejections (invalid signature, replay guard hit, stale fill)

### 6.5 Rotation

**Planned rotation:** Every 6 months
- Process: Solver implementation dependent; typically:
  1. Generate new keypair
  2. Update solver config
  3. Restart solver
  4. Drain the old solver's account (refund any pending fills)
  5. Destroy the old key

**Emergency rotation (suspected compromise):**
- Stop solver
- Generate new keypair
- Update config and restart
- Audit the old key's on-chain fills for unauthorized activity

**Time budget:** **<10 minutes**

---

## 7. EVM Deployer Key (One-time Deployment)

### 7.1 Generation

**Deployer account (local mnemonic or hardware wallet):**
```bash
cast wallet new
# or derive from hardware wallet
```

### 7.2 Storage & Access Control

**Storage:**
- **Private key:** Held only during deployment
- **Best practice:** Use a hardware wallet or a mnemonic derived on a fresh,
  air-gapped device
- **Post-deployment:** Key should have no balance and hold no roles

### 7.3 Post-deployment Cleanup

1. **Verify** the deployer has no roles:
   ```bash
   cast call $ESCROW "owner()" # should NOT be the deployer
   cast call $ESCROW "guardian()" # should NOT be the deployer
   cast call $TIMELOCK "owners()" # should NOT include the deployer
   ```

2. **Destroy the key:**
   - If from a hardware wallet: export the mnemonic, verify the addresses, then
     securely erase the device
   - If from local storage: overwrite the mnemonic file and destroy any backups
   - If from a server: securely delete the key from the server's filesystem

3. **Do not reuse** the deployer key for any other purpose

---

## 8. Compromise Incident Playbook (General)

### Priority levels

- **CRITICAL:** Timelock owner or Soroban admin compromised
  - Risk: Full protocol reconfiguration
  - Response time: <4 hours
  - Escalation: All hands on deck

- **HIGH:** Guardian key compromised
  - Risk: Temporary halt (but limited to 72h auto-recovery)
  - Response time: <2 hours
  - Escalation: On-call incident commander + security team

- **MEDIUM:** Relayer or solver key compromised
  - Risk: Liveness issues or failed fills (no funds at risk if key is message-only)
  - Response time: <1 hour
  - Escalation: On-call infrastructure lead

### General response flow

1. **Detect:** Monitoring alerts + manual review
2. **Isolate:** Stop using the compromised key immediately
3. **Assess:** Determine what was accessed/modified with the key
4. **Respond:** Rotate the key per the playbook above
5. **Audit:** Review transaction logs and investigate root cause
6. **Prevent:** Patch the process that led to compromise

---

## 9. Periodic Key Rotation Drill

To ensure rotation procedures are current and practiced, conduct a dry-run
rotation every quarter:

1. **Timelock owner:** One owner follows the rotation procedure (without actually
   submitting the governance vote); verify all steps work
2. **Guardian:** Ops lead generates a new key and verifies the procedure; log
   time to completion
3. **Relayer + solver:** Rotate keys on a staging environment; verify no
   downtime

**Drill cadence:** Every 3 months; log results in the incident log.

---

## 10. References

- [Threat Model](./threat-model.md) — threat context and role-by-role compromises
- [Deployment](./deployment.md) — operational procedures and timelock usage
- [SECURITY.md](../SECURITY.md) — vulnerability reporting and scope
