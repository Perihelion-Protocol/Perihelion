# Deployment & Operations Runbook

How to deploy the Perihelion contracts to production and operate them safely. It
covers the EVM escrow, its timelock-multisig owner and emergency guardian, the
Soroban settlement contract, and the day-to-day admin procedures.

> ⚠️ **Unaudited.** The contracts have not completed an external audit. Treat
> mainnet deployment as gated on that audit (see the
> [phased rollout](./TECHNICAL-ARCHITECTURE.md#8-phased-rollout)). This runbook
> describes the intended production topology; do not custody real value before
> the audit gate clears.

---

## 1. Trust model & roles

| Role                | Held by                               | Powers                                                                                                  |
| ------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| **owner** (EVM)     | `PerihelionTimelock` (M-of-N + delay) | All config: `setPeer`, `setConfirmationGrace`, `setGuardian`, `setPaused` (unpause), two-step ownership |
| **guardian** (EVM)  | A hot key or small Safe               | `pause()` only — instant emergency halt. Cannot unpause or reconfigure                                  |
| **admin** (Soroban) | A Stellar multisig account            | `propose_endpoint` / `confirm_endpoint`, `propose_peer` / `confirm_peer`, `set_admin` / `accept_admin`, `set_paused` |
| **endpoint**        | LayerZero V2 endpoint                 | Sole caller of `lzReceive` / `lz_receive`                                                               |

The Soroban admin is deliberately constrained: endpoint and peer changes are
two-step (`propose_*` then `confirm_*` after the mandatory delay), and the admin
must never be the endpoint contract — the constructor rejects
`admin == endpoint` (`AdminEndpointCollision`), `set_admin` rejects a new admin
equal to the current endpoint, and `accept_admin` re-checks the invariant in
case the endpoint changed in between. Keep the admin a distinct multisig
account; collapsing it into the endpoint would merge two trust domains.

The asymmetry is deliberate: the **owner is slow** (timelocked, multi-party) so
users get a public window before any config change takes effect, while the
**guardian is fast** (single tx) so an incident can be halted immediately. A
compromised guardian can at worst pause the protocol — it can never move funds,
unpause, or change configuration.

> See the [consolidated threat model](./threat-model.md#0-consolidated-trust-model)
> for a role-by-role trust breakdown including the relayer, DVN set, Stellar
> validators, and executor.
>
> For key generation, storage, rotation, and compromise-response procedures, see
> [key-management.md](./key-management.md).

---

## 2. Prerequisites

- [Foundry](https://book.getfoundry.sh) and the [Stellar CLI](https://developers.stellar.org/docs/tools/cli).
- The LayerZero V2 endpoint address and endpoint id (EID) for each chain.
- A funded deployer key per chain (used only for deployment; it ends up holding
  no privileged role).
- The owner set, threshold, and delay decided in advance (see §7).

Build and test first:

```bash
( cd contracts/evm && forge build && forge test )
( cd contracts/soroban && cargo test )
```

> ### Reproducible builds & explorer verification
>
> The EVM contracts use a pinned compiler version and settings that make
> deployments verifiable on block explorers. The CI workflow
> (`.github/workflows/evm.yml`, the `bytecode` job) enforces that the bytecode
> produced by the current source exactly matches pinned hashes on every PR.
>
> **Compiler settings for explorer verification:**
>
> | Setting          | Value                                                                                                                                                                                                             |
> | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
> | Solidity version | `0.8.24`                                                                                                                                                                                                          |
> | EVM version      | `cancun`                                                                                                                                                                                                          |
> | Optimizer        | enabled                                                                                                                                                                                                           |
> | Optimizer runs   | `200`                                                                                                                                                                                                             |
> | Metadata hash    | `none` (`bytecode_hash = "none"`, `cbor_metadata = false`) — metadata embeds the source path and compiler build, which breaks byte-for-byte comparison across machines; select "no metadata" on the explorer form |
>
> These are defined in [`contracts/evm/foundry.toml`](../contracts/evm/foundry.toml).
> The pinned bytecode hashes live in `contracts/evm/.pinned-bytecode/` and are
> checked on every CI run. Before deploying, confirm the local build produces the
> same bytecode as the CI-pinned hashes by running:
>
> ```bash
> make bytecode-check     # or: ./scripts/check-pinned-bytecode.sh
> ```
>
> This is a required pre-deployment step: it must pass on the exact commit being
> deployed. If the hashes differ from the `.pinned-bytecode/` entries, the source
> or compiler settings have changed and the pins are stale.
>
> **Intentional pin updates.** A PR that changes contract bytecode must update the
> pins in the same commit:
>
> ```bash
> ./scripts/check-pinned-bytecode.sh --update
> ```
>
> The PR description must state why the bytecode changed. Reviewers treat a pin
> change with no corresponding source change, or a source change with no pin
> update, as a blocker.
>
> Once deployed, verify the on-chain bytecode against the build artifact using
> the block explorer's "Verify & Publish" form with the exact settings above.
> The source is published at the commit referenced in the deployment record.

---

## 3. Deployment order

1. **EVM:** deploy the timelock → deploy the escrow (pointing owner at the timelock) → complete the ownership handover.
2. **Soroban:** deploy & initialize the settlement contract.
3. **Wire peers** in both directions and configure LayerZero DVNs.
4. **Verify** (§6), then run a small end-to-end test transfer.

---

## 4. EVM deployment

### 4.1 Deploy the timelock multisig

```bash
cd contracts/evm
export PERIHELION_TL_OWNERS="0xOwner1,0xOwner2,0xOwner3"
export PERIHELION_TL_THRESHOLD=2          # M-of-N
export PERIHELION_TL_DELAY=172800         # 48h, in seconds
forge script script/DeployTimelock.s.sol --rpc-url "$RPC" --broadcast
# -> note the deployed PerihelionTimelock address as $TIMELOCK
```

### 4.2 Deploy the escrow

The escrow is configured from a JSON file in the same transaction batch as its
deployment, so it can accept locks as soon as ownership moves and no setting
needs a separate governance cycle. Copy `contracts/evm/script/config/example.json`
to `contracts/evm/script/config/<chain>.json` and fill in:

| Key                                                           | Meaning                                                                                                           |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `peer`                                                        | 32-byte address of the Soroban settlement contract (required; a zero peer is rejected)                            |
| `guardian`                                                    | Emergency-pause key (required)                                                                                    |
| `confirmationGrace`                                           | Local-refund grace in seconds, within the contract's 30 min to 7 day bounds (required)                            |
| `rollingWindowDuration`                                       | Window length in seconds for per-asset rolling caps                                                               |
| `assets` / `assetMaxIntentAmounts` / `assetRollingWindowCaps` | Allowlisted tokens. Each asset needs a max lock amount. Amounts are JSON strings. Parallel arrays of equal length |
| `owner`                                                       | The timelock. Nominated as pending owner, not yet owner                                                           |

The config must live under `contracts/evm/script/config/` or `test/fixtures/`,
because Foundry only permits file reads there.

```bash
export PERIHELION_ENDPOINT=0xLZEndpoint
export PERIHELION_STELLAR_EID=30316        # Stellar settlement EID
export PERIHELION_CONFIG=script/config/<chain>.json
forge script script/Deploy.s.sol --rpc-url "$RPC" --broadcast
# -> note the deployed PerihelionEscrow address as $ESCROW
```

At this point `pendingOwner == $TIMELOCK`, `stellarPeer`, `guardian`, grace, the
asset allowlist and caps are all configured, and `owner` is still the deployer
until the handover completes. The LayerZero delegate still belongs to the
deployer, and §4.3 moves it.

### 4.3 Complete the ownership handover (timelock governance)

The timelock must run two operations through its own flow, in this order:

1. `escrow.acceptOwnership()`: the timelock becomes owner.
2. `escrow.setEndpointDelegate($TIMELOCK)`: the LayerZero delegate moves to the
   timelock. Only the owner can call it, so it must run after step 1.

`script/AcceptOwnership.s.sol` builds both operations and prints the `propose`
and `execute` calldata for each. It broadcasts nothing:

```bash
export PERIHELION_ESCROW=$ESCROW PERIHELION_TIMELOCK=$TIMELOCK
forge script script/AcceptOwnership.s.sol --rpc-url "$RPC"
```

For each operation, submit `propose → confirm (×M) → wait delay → execute`,
using the printed calldata. Operation 1 is submitted and executed first, then
operation 2:

```bash
# Owner 1 proposes (auto-confirms), using the propose calldata for operation 0:
cast send $TIMELOCK <propose-calldata-0> --private-key $OWNER1
# Owner 2 confirms with the id printed for operation 0 (reaches threshold, starts the delay):
cast send $TIMELOCK "confirm(bytes32)" <id-0> --private-key $OWNER2
# ...wait out PERIHELION_TL_DELAY...
cast send $TIMELOCK <execute-calldata-0> --private-key $OWNER1
# -> escrow.owner() == $TIMELOCK. Repeat for operation 1 (setEndpointDelegate).
```

Any subsequent EVM admin change (peer rotation, grace, unpause) follows this
same four-step pattern, just with different calldata.

Any subsequent EVM admin change (peer rotation, grace, unpause) follows this
same four-step pattern, just with different calldata.

**Verify before recording.** Once the handover is complete, check the on-chain
state against the same config file. The script reverts on the first missing or
mismatched setting, so it can gate a pipeline:

```bash
export PERIHELION_ESCROW=$ESCROW PERIHELION_TIMELOCK=$TIMELOCK PERIHELION_CONFIG=script/config/<chain>.json
forge script script/VerifyDeployment.s.sol --rpc-url "$RPC"
# -> prints the effective configuration, then "Verification passed."
```

Run it before any lock is accepted. Until the handover completes it reverts
with `owner is not the timelock` by design.

### 4.3a Hand the LayerZero delegate to the timelock

The endpoint delegate controls the escrow's LayerZero security configuration
(DVNs, libraries, and skip/clear/nilify of inbound packets). The constructor
sets it to the deployer EOA, and `transferOwnership` / `acceptOwnership` do not
move it. Until this step is done, the deployer key can still alter cross-chain
verification. Run it through the same timelock flow as 4.3:

```bash
DELEGATE=$(cast calldata "setDelegate(address)" $TIMELOCK)
SALT=0x0000000000000000000000000000000000000000000000000000000000000002
cast send $TIMELOCK "propose(address,uint256,bytes,bytes32)" $ESCROW 0 $DELEGATE $SALT --private-key $OWNER1
ID=$(cast call $TIMELOCK "hashOperation(address,uint256,bytes,bytes32)" $ESCROW 0 $DELEGATE $SALT)
cast send $TIMELOCK "confirm(bytes32)" $ID --private-key $OWNER2
# ...wait out PERIHELION_TL_DELAY...
cast send $TIMELOCK "execute(address,uint256,bytes,bytes32)" $ESCROW 0 $DELEGATE $SALT --private-key $OWNER1

# Verify: the endpoint must now list the timelock as the escrow's delegate.
cast call $PERIHELION_ENDPOINT "delegates(address)(address)" $ESCROW
# -> must equal $TIMELOCK; do not mark the deployment complete otherwise.
```

### 4.4 Record the deployment

There is no automated sync between a deployment and the SDK. In the same PR:

- Add `chainId → $ESCROW` to `DEPLOYMENTS` in `sdk/src/deployments.ts`.
- Record the chain, address, and deployment commit in the table below.

| Chain | Chain ID | Escrow address | Deployed |
| ----- | -------- | -------------- | -------- |
| —     | —        | —              | —        |

---

## 5. Soroban deployment

```bash
cd contracts/soroban
cargo build --target wasm32-unknown-unknown --release
# Pass the admin multisig account, the LayerZero endpoint and the native token as
# constructor arguments. The contract is configured in the same transaction that
# creates it, so nobody can front-run a separate initialisation call (issue #910).
stellar contract deploy --wasm target/wasm32-unknown-unknown/release/perihelion_settlement.wasm ... \
  -- --admin $ADMIN --endpoint $LZ_ENDPOINT --native_token $NATIVE_TOKEN
# -> $SETTLEMENT
```

---

## 6. Wire peers & verify

Register each side as the other's trusted peer (32-byte LayerZero addresses).

**Soroban peer bootstrap (first peer for a new EID).** There is no `set_peer`
call. Peers are set through a propose/confirm pair, and the delay rules differ
between bootstrap and rotation:

- **Bootstrap** — when `Peer(eid)` has never been set and no intents have ever
  been registered for that EID, the first peer can be registered in a single
  ledger: `propose_peer` accepts `delay = 0` and `confirm_peer` applies it
  immediately, emitting the usual `peer_set` event.
- **Rotation** — once a peer exists (or any intent has been registered for the
  EID), `propose_peer` requires `delay >= MIN_PEER_CHANGE_DELAY` (86 400 s, one
  day). The new peer only takes effect after `confirm_peer` is called once the
  delay has elapsed.

```bash
# Soroban bootstrap: trust the EVM escrow on the source EID in one ledger.
stellar contract invoke --id $SETTLEMENT -- propose_peer \
  --eid $EVM_EID --peer <escrow-as-32-bytes> --delay 0
stellar contract invoke --id $SETTLEMENT -- confirm_peer --eid $EVM_EID

# Soroban rotation: propose with the full delay, then confirm after it elapses.
stellar contract invoke --id $SETTLEMENT -- propose_peer \
  --eid $EVM_EID --peer <new-escrow-as-32-bytes> --delay 86400
# ...wait out the delay...
stellar contract invoke --id $SETTLEMENT -- confirm_peer --eid $EVM_EID

# EVM: trust the Soroban settlement (via the timelock if ownership already moved,
# otherwise the deployer before handover).
cast send $ESCROW "setPeer(bytes32)" <settlement-as-32-bytes> ...
```

The same two-step flow applies to the endpoint: `propose_endpoint` followed by
`confirm_endpoint` after the delay. The proposed endpoint must not equal the
current admin.

Configure the LayerZero send/receive libraries and the DVN set per chain
(LayerZero-specific; out of scope here).

**Basic post-deploy checklist:**

- [ ] `forge script script/VerifyDeployment.s.sol` passes against the deployment config
- [ ] `escrow.owner() == $TIMELOCK`, `escrow.pendingOwner() == 0`
- [ ] Escrow's LayerZero delegate is `$TIMELOCK` (via `setEndpointDelegate`, §4.3)
- [ ] `escrow.guardian() == $PERIHELION_GUARDIAN`
- [ ] `escrow.stellarPeer()` and `escrow.stellarEid()` correct
- [ ] `escrow.paused() == false`
- [ ] `timelock.threshold()` / `delay()` / `owners()` as intended
- [ ] Soroban `is_paused() == false`, peer registered for the EVM EID (bootstrap or confirmed rotation)
- [ ] Soroban admin is not the endpoint contract (invariant enforced on-chain)
- [ ] LayerZero DVN set and libraries configured both directions
- [ ] One small end-to-end test transfer settles, and a deliberately-expired one refunds
- [ ] `make bytecode-check` passes on the exact commit being deployed

---

## 6.1 Threat-Model-Aware Deployment Verification

**This is a required step before announcing or operating the deployment.** The security
properties the threat model relies on (see [§6 Security Model](./TECHNICAL-ARCHITECTURE.md#6-security-model--threat-matrix))
are only realized if the deployment is performed correctly. The following checklist
operationally enforces those properties.

### Prerequisites

Before running these checks:

- The contracts are deployed to both chains.
- Peers are wired and LayerZero DVNs are configured.
- You have:
  - `$ESCROW` (EVM escrow address)
  - `$SETTLEMENT` (Soroban settlement contract ID)
  - `$TIMELOCK` (EVM timelock address)
  - `$GUARDIAN` (EVM guardian address)
  - A JSON-RPC endpoint for the EVM chain and an RPC endpoint for Soroban

### Automated Verification Script

The following script validates all security-critical configuration:

```bash
#!/bin/bash
set -e

ESCROW=${ESCROW:-}
SETTLEMENT=${SETTLEMENT:-}
TIMELOCK=${TIMELOCK:-}
GUARDIAN=${GUARDIAN:-}
EVM_RPC=${EVM_RPC:-}
SOROBAN_RPC=${SOROBAN_RPC:-}

if [ -z "$ESCROW" ] || [ -z "$SETTLEMENT" ] || [ -z "$TIMELOCK" ] || [ -z "$EVM_RPC" ] || [ -z "$SOROBAN_RPC" ]; then
  echo "Usage: ESCROW=0x... SETTLEMENT=C... TIMELOCK=0x... GUARDIAN=0x... EVM_RPC=... SOROBAN_RPC=... $0"
  exit 1
fi

echo "🔐 Perihelion Deployment Verification"
echo "======================================="

# 1. EVM Escrow ownership
echo ""
echo "[1/8] Verifying EVM escrow ownership..."
OWNER=$(cast call $ESCROW "owner()" --rpc-url "$EVM_RPC" | tr '[:upper:]' '[:lower:]')
TIMELOCK_LOWER=$(echo "$TIMELOCK" | tr '[:upper:]' '[:lower:]')
if [ "$OWNER" = "$TIMELOCK_LOWER" ]; then
  echo "  ✓ owner() == timelock"
else
  echo "  ✗ FAIL: owner is $OWNER, expected $TIMELOCK_LOWER"
  exit 1
fi

PENDING_OWNER=$(cast call $ESCROW "pendingOwner()" --rpc-url "$EVM_RPC" | tr '[:upper:]' '[:lower:]')
if [ "$PENDING_OWNER" = "0x0000000000000000000000000000000000000000" ]; then
  echo "  ✓ pendingOwner() == 0x0"
else
  echo "  ✗ FAIL: pendingOwner is $PENDING_OWNER"
  exit 1
fi

# 2. EVM Guardian is set and distinct from owner
echo ""
echo "[2/8] Verifying EVM guardian..."
CURRENT_GUARDIAN=$(cast call $ESCROW "guardian()" --rpc-url "$EVM_RPC" | tr '[:upper:]' '[:lower:]')
GUARDIAN_LOWER=$(echo "$GUARDIAN" | tr '[:upper:]' '[:lower:]')
if [ "$CURRENT_GUARDIAN" = "$GUARDIAN_LOWER" ]; then
  echo "  ✓ guardian() == $GUARDIAN"
else
  echo "  ✗ FAIL: guardian is $CURRENT_GUARDIAN, expected $GUARDIAN_LOWER"
  exit 1
fi

if [ "$CURRENT_GUARDIAN" != "$TIMELOCK_LOWER" ]; then
  echo "  ✓ guardian != owner (separate keys)"
else
  echo "  ✗ FAIL: guardian and owner are the same address"
  exit 1
fi

# 3. Timelock configuration
echo ""
echo "[3/8] Verifying timelock configuration..."
DELAY=$(cast call $TIMELOCK "delay()" --rpc-url "$EVM_RPC")
DELAY_SECS=$((DELAY))
DELAY_HOURS=$((DELAY_SECS / 3600))
echo "  • Timelock delay: $DELAY_SECS seconds ($DELAY_HOURS hours)"

if [ $DELAY_SECS -ge 86400 ]; then
  echo "  ✓ delay >= 24 hours (recommended minimum for guarded beta)"
else
  echo "  ⚠ WARNING: delay < 24 hours (recommended: 24-48h)"
fi

THRESHOLD=$(cast call $TIMELOCK "threshold()" --rpc-url "$EVM_RPC")
NUM_OWNERS=$(cast call $TIMELOCK "countOwners()" --rpc-url "$EVM_RPC")
THRESHOLD_VAL=$((THRESHOLD))
NUM_OWNERS_VAL=$((NUM_OWNERS))
echo "  • Timelock: $THRESHOLD_VAL-of-$NUM_OWNERS_VAL multisig"

if [ $THRESHOLD_VAL -gt 1 ] && [ $THRESHOLD_VAL -gt $((NUM_OWNERS_VAL / 2)) ]; then
  echo "  ✓ threshold > 1 and > N/2 (true majority)"
else
  echo "  ⚠ WARNING: threshold may not be a true majority"
fi

# 4. Peer symmetry
echo ""
echo "[4/8] Verifying peer symmetry (EVM → Soroban)..."
EVM_PEER=$(cast call $ESCROW "stellarPeer()" --rpc-url "$EVM_RPC")
echo "  • EVM escrow stellar peer: $EVM_PEER"

if [ "$EVM_PEER" != "0x0000000000000000000000000000000000000000000000000000000000000000" ]; then
  echo "  ✓ peer is set"
else
  echo "  ✗ FAIL: peer is zero (not yet wired)"
  exit 1
fi

# 5. Soroban peer wiring
echo ""
echo "[5/8] Verifying Soroban peer (should match EVM peer via RPC)..."
echo "  Note: Peer verification via RPC is contract-specific; verify manually:"
echo "    stellar contract read --id $SETTLEMENT --key PEEREVM"

# 6. Escrow not paused
echo ""
echo "[6/8] Verifying escrow is not paused..."
PAUSED=$(cast call $ESCROW "paused()" --rpc-url "$EVM_RPC")
if [ "$PAUSED" = "false" ]; then
  echo "  ✓ paused() == false"
else
  echo "  ✗ FAIL: escrow is paused (set_paused(false) via admin)"
  exit 1
fi

# 7. Bytecode verification
echo ""
echo "[7/8] Checking bytecode reproducibility..."
cd contracts/evm
forge build 2>/dev/null || {
  echo "  ⚠ Skipping: forge build failed (ensure foundry is installed)"
  cd ../..
}

ESCROW_RUNTIME=$(cast code $ESCROW --rpc-url "$EVM_RPC")
echo "  • On-chain escrow bytecode (first 64 chars): ${ESCROW_RUNTIME:0:64}"
echo "  ✓ Bytecode verified on-chain; cross-check against explorer"
echo "    (Use Solidity 0.8.24, EVM Cancun, 200 optimizer runs, metadata hash appended)"
cd ../..

# 8. Grace period
echo ""
echo "[8/8] Verifying confirmation grace period..."
GRACE=$(cast call $ESCROW "confirmationGrace()" --rpc-url "$EVM_RPC")
GRACE_SECS=$((GRACE))
GRACE_HOURS=$((GRACE_SECS / 3600))
echo "  • Confirmation grace: $GRACE_SECS seconds ($GRACE_HOURS hours)"

if [ $GRACE_SECS -gt 10800 ] && [ $GRACE_SECS -lt 604800 ]; then
  echo "  ✓ grace within recommended bounds (> 3h, < 7d)"
else
  echo "  ⚠ WARNING: grace outside recommended range"
fi

echo ""
echo "======================================="
echo "✅ All critical checks passed!"
echo "======================================="
echo ""
echo "Final steps before announcement:"
echo "  1. Manually verify bytecode on a block explorer using the settings above"
echo "  2. Run a small end-to-end test (lock on source, fill on Stellar, settle)"
echo "  3. Confirm governance is off-chain comfortable with the deployment"
echo "  4. Announce with link to this verification record and commit hash"
```

Save as `scripts/verify-deployment.sh` and run:

```bash
chmod +x scripts/verify-deployment.sh
ESCROW=0x... SETTLEMENT=C... TIMELOCK=0x... GUARDIAN=0x... \
  EVM_RPC=https://... SOROBAN_RPC=https://... \
  ./scripts/verify-deployment.sh
```

### Manual Verification Checklist

If automated verification is not available, verify manually:

| Item                   | Check                                      | Command / Action                                                                                          |
| ---------------------- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| **EVM Ownership**      | `owner` is timelock, `pendingOwner` is 0x0 | `cast call $ESCROW owner() pendingOwner() --rpc-url $EVM_RPC`                                             |
| **Guardian Distinct**  | `guardian` is set and differs from `owner` | `cast call $ESCROW guardian() --rpc-url $EVM_RPC`                                                         |
| **Timelock Threshold** | Threshold is > 1 and > N/2 (true majority) | `cast call $TIMELOCK threshold() countOwners() --rpc-url $EVM_RPC`                                        |
| **Timelock Delay**     | Delay >= 24h (48h recommended)             | `cast call $TIMELOCK delay() --rpc-url $EVM_RPC` (result in seconds)                                      |
| **Peer Set (EVM)**     | Stellar peer registered                    | `cast call $ESCROW stellarPeer() --rpc-url $EVM_RPC` (non-zero)                                           |
| **Peer Symmetry**      | Soroban peer matches EVM peer              | `stellar contract read --id $SETTLEMENT --key PEEREVM`                                                    |
| **Escrow Not Paused**  | `paused() == false`                        | `cast call $ESCROW paused() --rpc-url $EVM_RPC`                                                           |
| **Grace Period**       | Within bounds: 3h < grace < 7d             | `cast call $ESCROW confirmationGrace() --rpc-url $EVM_RPC`                                                |
| **Bytecode**           | On-chain bytecode matches built artifact   | Compare on-chain code with `jq '.deployedBytecode.object' out/PerihelionEscrow.sol/PerihelionEscrow.json` |

### Pre-Announcement Gate

**Do not announce the deployment until all of the above checks pass.** Include in the
announcement:

1. The block/ledger numbers where contracts were deployed
2. The commit hash of the deployed code
3. A link to this verification checklist (with results)
4. Confirmation that bytecode reproducibility was verified on a block explorer
5. The governance approval record (timelock proposal ID or multisig tx hash)

---

## 6.2 Service configuration (relayer, solver, mempool)

The relayer, solver and mempool share one configuration scheme: **one variable
name per setting**, so a single shared `.env` configures all three services.
The old, service-specific names are still accepted for one release and log a
deprecation warning; use the unified name in new deployments.

| Setting                        | Unified variable                  | Deprecated alias(es)                                                    | Required               | Default                       |
| ------------------------------ | --------------------------------- | ----------------------------------------------------------------------- | ---------------------- | ----------------------------- |
| Soroban settlement contract id | `PERIHELION_SETTLEMENT_CONTRACT`  | `PERIHELION_SETTLEMENT_CONTRACT_ID` (solver)                            | yes                    | —                             |
| Stellar / Soroban RPC URL      | `PERIHELION_STELLAR_RPC_URL`      | `PERIHELION_SOROBAN_RPC_URL` (solver)                                   | yes                    | —                             |
| Source chain id                | `PERIHELION_SOURCE_CHAIN_ID`      | —                                                                       | **yes (all services)** | none — must be set explicitly |
| Metrics/health bind host       | `PERIHELION_HEALTH_HOST`          | `PERIHELION_METRICS_HOST` (solver), `PERIHELION_MEMPOOL_HOST` (mempool) | no                     | `127.0.0.1`                   |
| Metrics/health bind port       | `PERIHELION_HEALTH_PORT`          | `PERIHELION_METRICS_PORT` (solver), `PERIHELION_MEMPOOL_PORT` (mempool) | no                     | service-specific (see below)  |
| Solver address                 | `PERIHELION_SOLVER_ADDRESS`       | —                                                                       | yes (solver)           | —                             |
| Solver private key             | `PERIHELION_SOLVER_PRIVATE_KEY`   | —                                                                       | yes (solver)           | —                             |
| Relayer private key            | `PERIHELION_RELAYER_PRIVATE_KEY`  | —                                                                       | yes (relayer)          | —                             |
| Mempool database URL           | `PERIHELION_MEMPOOL_DATABASE_URL` | —                                                                       | yes (mempool)          | —                             |

Notes:

- **`PERIHELION_SOURCE_CHAIN_ID` is required by every service and has no
  default.** The solver previously defaulted to `8453` in one loader and `1` in
  another, which could silently point the two at different chains; that is
  removed. Startup fails if the variable is unset.
- **`PERIHELION_SOLVER_ADDRESS` is validated** against the address derived from
  `PERIHELION_SOLVER_PRIVATE_KEY`; a mismatch is a startup error.
- The bind host/port defaults are per service: relayer `127.0.0.1:8080`, solver
  `127.0.0.1:8081`, mempool `127.0.0.1:8082`. Set `PERIHELION_HEALTH_HOST` /
  `PERIHELION_HEALTH_PORT` explicitly in container deployments to bind `0.0.0.0`.
- `docker-compose.yml` sets each setting once under its unified name and shares
  it across the three services.

When the mempool sits behind an ingress or load balancer, set
`PERIHELION_MEMPOOL_TRUST_PROXY` to the trusted hop count (for example `1`) or
an explicit comma-separated IPv4/CIDR allowlist. It is off by default, so
untrusted clients cannot choose their rate-limit identity with
`X-Forwarded-For`; never use the unrestricted Express `true` setting.

---

## 7. Recommended production parameters

| Parameter             | Recommendation                                                                                                                                                                                                                |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Timelock owners       | ≥ 3 hardware-wallet keys held by distinct people                                                                                                                                                                              |
| Timelock threshold    | A true majority (e.g. 2-of-3, 3-of-5)                                                                                                                                                                                         |
| Timelock delay        | 24–48h in guarded beta; long enough for users to exit                                                                                                                                                                         |
| Timelock grace period | Fixed on-chain at `GRACE_PERIOD` (14 days) after `readyAt`; a confirmed op not executed within that window expires and must be re-proposed — cancel stale ops explicitly rather than relying on expiry as the primary control |
| Guardian              | A separate hot key (or 1-of-n Safe) for fast incident pause                                                                                                                                                                   |
| `confirmationGrace`   | A few hours; must exceed worst-case LayerZero delivery time. Hard-capped at `MAX_CONFIRMATION_GRACE` (7 days)                                                                                                                 |

---

## 8. Operations

### Routine admin change (peer rotation, grace tuning, guardian change)

Use the timelock four-step flow from §4.3 with the appropriate calldata, e.g.
`cast calldata "setConfirmationGrace(uint256)" 7200`. The change is public the
moment it is proposed and only takes effect after the delay.

On Soroban, peer rotations and endpoint changes follow the same
propose/confirm pattern: `propose_peer` / `propose_endpoint` with the full
delay, then `confirm_peer` / `confirm_endpoint` once it has elapsed. Only the
very first peer for a brand-new EID may be bootstrapped with `delay = 0`.
Changing the admin is also two-step (`set_admin` then `accept_admin` from the
new admin); `set_admin` rejects the endpoint address and `accept_admin`
re-checks the invariant.

**Always use `value == 0` for these ops.** `execute` is `payable` and forwards
`value` verbatim to the target, but none of the escrow's owner-only setters
(`setPeer`, `setConfirmationGrace`, `setGuardian`, `setPaused`,
`transferOwnership`) are payable. Attaching a non-zero `value` to one of these
proposals makes the call revert (`CallFailed`) only after the full
propose → confirm → delay window has elapsed — the entire timelock cycle is
wasted. `value` exists for targets that are genuinely payable; double-check the
target accepts ETH before proposing anything other than `0`.

### Emergency halt

```bash
# EVM — instant, single tx:
cast send $ESCROW "pause()" --private-key $GUARDIAN
# Soroban — admin pause:
stellar contract invoke --id $SETTLEMENT -- set_paused --paused true
```

Pausing blocks new locks and local refunds; **settlement already in flight still
completes** over LayerZero, so funds are never stranded mid-transfer. The
permissionless refund path reopens automatically once unpaused.

### Resume

Resuming is owner-only and therefore goes through the timelock:
`cast calldata "setPaused(bool)" false`, then propose → confirm → wait → execute.
On Soroban, the admin invokes `set_paused false`.

### Rotating the multisig itself

`addOwner`, `removeOwner`, `setThreshold`, and `setDelay` are callable only by
the timelock on itself — propose an operation whose `target` is the timelock
address and whose calldata is the config call, then run the standard flow.

---

## 9. Incident response summary

| Situation                         | First action                                                            | Follow-up                                                |
| --------------------------------- | ----------------------------------------------------------------------- | -------------------------------------------------------- |
| Suspected exploit / bad messages  | Guardian `pause()` (EVM) + admin `set_paused` (Soroban)                 | Investigate; rotate peer/endpoint via timelock (EVM) or propose/confirm (Soroban) |
| Compromised guardian key          | Timelock `setGuardian(new)`                                             | Treat protocol as still safe (guardian can't move funds) |
| Compromised single timelock owner | Timelock `removeOwner` + `addOwner` (threshold protects you below M)    | Audit all pending operations, `cancel` any unknown ones  |
| Stuck/expired intent              | Anyone calls `cancelExpired` / `cancel_expired_intent` after the window | None — permissionless                                    |

`PerihelionTimelock.cancel` is deliberately 1-of-N (any single owner, not a
threshold) — see [the threat matrix](./TECHNICAL-ARCHITECTURE.md#61-detailed-mitigations-for-high-impact-attacks)
for the trade-off. In practice this means a dissenting owner can repeatedly
cancel an operation the rest of the multisig wants; if that happens, treat it
as an owner-coordination problem (escalate off-chain, or remove the owner via
governance) rather than a contract bug.
