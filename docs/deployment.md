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

| Role             | Held by                                  | Powers                                                                 |
| ---------------- | ---------------------------------------- | --------------------------------------------------------------------- |
| **owner** (EVM)  | `PerihelionTimelock` (M-of-N + delay)    | All config: `setPeer`, `setConfirmationGrace`, `setGuardian`, `setPaused` (unpause), two-step ownership |
| **guardian** (EVM) | A hot key or small Safe                 | `pause()` only — instant emergency halt. Cannot unpause or reconfigure |
| **admin** (Soroban) | A Stellar multisig account             | `set_endpoint`, `set_peer`, `set_admin`, `set_paused`                  |
| **endpoint**     | LayerZero V2 endpoint                     | Sole caller of `lzReceive` / `lz_receive`                             |

The asymmetry is deliberate: the **owner is slow** (timelocked, multi-party) so
users get a public window before any config change takes effect, while the
**guardian is fast** (single tx) so an incident can be halted immediately. A
compromised guardian can at worst pause the protocol — it can never move funds,
unpause, or change configuration.

---

## 2. Prerequisites

- [Foundry](https://book.getfoundry.sh) and the [Stellar CLI](https://developers.stellar.org/docs/tools/stellar-cli).
- The LayerZero V2 endpoint address and endpoint id (EID) for each chain.
- A funded deployer key per chain (used only for deployment; it ends up holding
  no privileged role).
- The owner set, threshold, and delay decided in advance (see §7).

Build and test first:

```bash
( cd contracts/evm && forge build && forge test )
( cd contracts/soroban && cargo test )
```

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

```bash
export PERIHELION_ENDPOINT=0xLZEndpoint
export PERIHELION_STELLAR_EID=30316        # Stellar settlement EID
export PERIHELION_STELLAR_PEER=0x...        # 32-byte Soroban peer (optional now; can set later)
export PERIHELION_GUARDIAN=0xGuardian       # emergency-pause key
export PERIHELION_OWNER=$TIMELOCK           # initiates two-step handover to the timelock
forge script script/Deploy.s.sol --rpc-url "$RPC" --broadcast
# -> note the deployed PerihelionEscrow address as $ESCROW
```

At this point `pendingOwner == $TIMELOCK`, `guardian == $PERIHELION_GUARDIAN`,
and `owner` is still the deployer until the handover completes.

### 4.3 Complete the ownership handover (timelock governance)

The timelock must call `escrow.acceptOwnership()` through its own flow. Encode
the call, then `propose → confirm (×M) → wait delay → execute`:

```bash
ACCEPT=$(cast calldata "acceptOwnership()")
SALT=0x0000000000000000000000000000000000000000000000000000000000000001

# Owner 1 proposes (auto-confirms):
cast send $TIMELOCK "propose(address,uint256,bytes,bytes32)" $ESCROW 0 $ACCEPT $SALT --private-key $OWNER1
# Owner 2 confirms (reaches threshold, starts the 48h clock):
ID=$(cast call $TIMELOCK "hashOperation(address,uint256,bytes,bytes32)" $ESCROW 0 $ACCEPT $SALT)
cast send $TIMELOCK "confirm(bytes32)" $ID --private-key $OWNER2
# ...wait out PERIHELION_TL_DELAY...
cast send $TIMELOCK "execute(address,uint256,bytes,bytes32)" $ESCROW 0 $ACCEPT $SALT --private-key $OWNER1
# -> escrow.owner() == $TIMELOCK
```

Any subsequent EVM admin change (peer rotation, grace, unpause) follows this
same four-step pattern, just with different calldata.

---

## 5. Soroban deployment

```bash
cd contracts/soroban
cargo build --target wasm32-unknown-unknown --release
stellar contract deploy --wasm target/wasm32-unknown-unknown/release/perihelion_settlement.wasm ...
# -> $SETTLEMENT

# Initialize with the admin multisig account and the LayerZero endpoint:
stellar contract invoke --id $SETTLEMENT -- initialize --admin $ADMIN --endpoint $LZ_ENDPOINT
```

---

## 6. Wire peers & verify

Register each side as the other's trusted peer (32-byte LayerZero addresses):

```bash
# Soroban: trust the EVM escrow on the source EID
stellar contract invoke --id $SETTLEMENT -- set_peer --eid $EVM_EID --peer <escrow-as-32-bytes>

# EVM: trust the Soroban settlement (via the timelock if ownership already moved,
# otherwise the deployer before handover).
cast send $ESCROW "setPeer(bytes32)" <settlement-as-32-bytes> ...
```

Configure the LayerZero send/receive libraries and the DVN set per chain
(LayerZero-specific; out of scope here).

**Post-deploy checklist:**

- [ ] `escrow.owner() == $TIMELOCK`, `escrow.pendingOwner() == 0`
- [ ] `escrow.guardian() == $PERIHELION_GUARDIAN`
- [ ] `escrow.stellarPeer()` and `escrow.stellarEid()` correct
- [ ] `escrow.paused() == false`
- [ ] `timelock.threshold()` / `delay()` / `owners()` as intended
- [ ] Soroban `is_paused() == false`, peer registered for the EVM EID
- [ ] LayerZero DVN set and libraries configured both directions
- [ ] One small end-to-end test transfer settles, and a deliberately-expired one refunds

---

## 7. Recommended production parameters

| Parameter             | Recommendation                                               |
| --------------------- | ------------------------------------------------------------ |
| Timelock owners       | ≥ 3 hardware-wallet keys held by distinct people             |
| Timelock threshold    | A true majority (e.g. 2-of-3, 3-of-5)                        |
| Timelock delay        | 24–48h in guarded beta; long enough for users to exit        |
| Timelock grace period | Fixed on-chain at `GRACE_PERIOD` (14 days) after `readyAt`; a confirmed op not executed within that window expires and must be re-proposed — cancel stale ops explicitly rather than relying on expiry as the primary control |
| Guardian              | A separate hot key (or 1-of-n Safe) for fast incident pause  |
| `confirmationGrace`   | A few hours; must exceed worst-case LayerZero delivery time. Hard-capped at `MAX_CONFIRMATION_GRACE` (7 days) |

---

## 8. Operations

### Routine admin change (peer rotation, grace tuning, guardian change)

Use the timelock four-step flow from §4.3 with the appropriate calldata, e.g.
`cast calldata "setConfirmationGrace(uint256)" 7200`. The change is public the
moment it is proposed and only takes effect after the delay.

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

| Situation                          | First action                                  | Follow-up                                  |
| ---------------------------------- | --------------------------------------------- | ------------------------------------------ |
| Suspected exploit / bad messages   | Guardian `pause()` (EVM) + admin `set_paused` (Soroban) | Investigate; rotate peer/endpoint via timelock |
| Compromised guardian key           | Timelock `setGuardian(new)`                   | Treat protocol as still safe (guardian can't move funds) |
| Compromised single timelock owner  | Timelock `removeOwner` + `addOwner` (threshold protects you below M) | Audit all pending operations, `cancel` any unknown ones |
| Stuck/expired intent               | Anyone calls `cancelExpired` / `cancel_expired_intent` after the window | None — permissionless                      |

`PerihelionTimelock.cancel` is deliberately 1-of-N (any single owner, not a
threshold) — see [the threat matrix](./TECHNICAL-ARCHITECTURE.md#61-detailed-mitigations-for-high-impact-attacks)
for the trade-off. In practice this means a dissenting owner can repeatedly
cancel an operation the rest of the multisig wants; if that happens, treat it
as an owner-coordination problem (escalate off-chain, or remove the owner via
governance) rather than a contract bug.
