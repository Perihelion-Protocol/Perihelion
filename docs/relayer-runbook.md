# Relayer Operator Runbook

This document covers every operational aspect of the **Perihelion LayerZero
relayer** — from first deployment through incident response. The relayer
implementation lives in [`relayer/`](../relayer/).

> ⚠️ **Unaudited.** The relayer and the contracts it bridges are under active
> development. Do not relay real-value traffic until the [phased-rollout audit
> gate](./TECHNICAL-ARCHITECTURE.md#8-phased-rollout) clears.

> 🚧 **Development-only stand-in.** The reference relayer in
> [`relayer/`](../relayer/) is **not** a production LayerZero executor. It
> impersonates the LayerZero endpoint: it signs `lz_receive` on the Soroban
> settlement contract with its own Stellar key, so the settlement contract's
> `Endpoint` must be configured to the relayer's account. In that mode the
> relayer key is fully trusted — it can register any intent with any recipient,
> amount and deadline, and can inject cancellations. No DVN verifies anything.
> Production must run a real LayerZero endpoint/adapter on Stellar and a
> permissionless executor (see [§1.2](#12-development-mode-vs-production)).
> The CLI refuses to start in this mode against Pubnet unless
> `PERIHELION_RELAYER_MODE=dev` is set explicitly (see [§4.1](#41-all-environment-variables)).

---

## Table of Contents

- [1. What the relayer does](#1-what-the-relayer-does)
- [2. Prerequisites](#2-prerequisites)
- [3. Key management](#3-key-management)
- [4. Configuration](#4-configuration)
- [5. Startup and readiness](#5-startup-and-readiness)
- [6. Monitoring and alerting](#6-monitoring-and-alerting)
- [7. Crash recovery and cursor persistence](#7-crash-recovery-and-cursor-persistence)
- [8. Reorg handling](#8-reorg-handling)
- [9. Incident playbooks](#9-incident-playbooks)
- [10. Related reliability issues](#10-related-reliability-issues)

---

## 1. What the relayer does

### 1.1 Current implementation (development mode)

```
EVM escrow ──emit MessageSent──► [relayer: confirm N blocks] ──► Soroban settlement
                                                                  (lz_receive, signed by relayer key)

Soroban settlement ──emit outbound──► [relayer: follow events] ──► EVM escrow
                                                                    (lzReceive via mock endpoint)
```

The relayer is a **stateful daemon** that runs one loop per direction, each
with its own checkpoint:

1. **EVM → Soroban leg.** Watches the EVM escrow contract for `MessageSent`
   events, waits for `PERIHELION_CONFIRMATIONS` blocks before treating a
   message as final, then delivers each confirmed message to the Soroban
   settlement contract's `lz_receive` entrypoint.
2. **Soroban → EVM leg.** Watches the settlement contract for outbound
   messages (`FillConfirmed`, `CancelIntent`) and delivers them to the EVM
   escrow's `lzReceive` entrypoint through a mock endpoint on development
   networks.
3. Persists a cursor checkpoint per direction after every successful tick so a
   restart resumes without re-scanning from genesis or silently skipping
   messages.

> ⚠️ **Trust model in this mode.** The relayer signs `lz_receive` as the
> trusted endpoint, so the settlement contract's `Endpoint` must be the
> relayer's account, and the relayer sets `Origin.sender` by echoing the
> contract's own `get_peer(srcEid)` back. The peer check is therefore
> self-fulfilling. Whoever holds `SIGNER_SECRET` can register any intent with
> any recipient, amount and deadline, and can inject cancellations. This is a
> **development shim**, not the LayerZero/DVN trust model described in
> [TECHNICAL-ARCHITECTURE.md](./TECHNICAL-ARCHITECTURE.md).

### 1.2 Development mode vs production

| Aspect | Development mode (this relayer) | Production design |
|--------|--------------------------------|-------------------|
| Endpoint | Relayer's Stellar account is configured as the settlement `Endpoint` | Real LayerZero endpoint/adapter deployed on Stellar |
| Message authentication | Relayer key signature; peer check self-fulfilling | DVN verifier set attests the packet; endpoint enforces peer |
| Relayer authority | Full — can forge or cancel any message | None — executor is permissionless |
| Outbound leg | Relayer calls a mock endpoint on the EVM escrow | LayerZero executor delivers the verified packet |
| Network gate | Refuses Pubnet unless `PERIHELION_RELAYER_MODE=dev` | N/A — no impersonation |

In production the relayer acts **only as a permissionless executor**: it calls
the real endpoint's delivery function with a packet that the endpoint has
already verified against the DVN set. The relayer key carries no authority; a
faulty or censoring executor can **delay** delivery but cannot forge one, and
anyone can run a competing instance. Both legs (EVM → Stellar and
Stellar → EVM) are carried by LayerZero executors in production.

---

## 2. Prerequisites

| Requirement | Notes |
|-------------|-------|
| **Node.js ≥ 20** | Same constraint as the solver and SDK |
| **EVM RPC endpoint** | Archival preferred; must support `eth_getLogs` and `eth_getBlockByNumber` |
| **Stellar / Soroban RPC endpoint** | Horizon or a Soroban RPC that exposes `simulateTransaction` and `sendTransaction` |
| **Deployed contracts** | EVM escrow address + Soroban settlement contract ID — both must be live and peered before the relayer starts |
| **Signer key** | A Stellar secret key that pays for delivery transactions on the destination side. In development mode this key is also the trusted endpoint — see [§3.1](#31-what-keys-the-relayer-holds) |
| **Checkpoint storage** | Writable filesystem path (default) or a database-backed `CheckpointStore` for multi-instance deployments |

Build and verify before running:

```bash
npm install
npm run build          # compiles relayer/ with its workspace dependencies
```

---

## 3. Key management

### 3.1 What keys the relayer holds

| Key | Variable | Role | Sensitivity |
|-----|----------|------|-------------|
| Stellar signer secret | `SIGNER_SECRET` | Signs Soroban delivery transactions | **High** — loss means the relayer cannot deliver; **in development mode, compromise means full forgery authority** (see below) |

The relayer does **not** hold an EVM private key. Source-chain watching is
read-only (`eth_getLogs`).

> ⚠️ **Development mode only.** Because the relayer signs `lz_receive` as the
> trusted endpoint, the settlement contract's `Endpoint` must be the relayer's
> account, and the relayer key can forge or cancel any message. Treat
> `SIGNER_SECRET` in development mode as equivalent to the settlement
> contract's admin key. In the production design the relayer key carries no
> authority — it only pays fees for a permissionless executor call against a
> packet the real endpoint has already verified.

### 3.2 Storing the signer key

**Never commit keys to source control or `.env` files tracked by git.**

Recommended storage options in descending order of preference:

1. **Secrets manager** (AWS Secrets Manager, HashiCorp Vault, GCP Secret
   Manager) — inject the secret at runtime as an environment variable.
2. **Encrypted `.env` file** decrypted at deploy time by CI/CD; the plaintext
   file lives only in memory.
3. **Docker / Kubernetes secret** mounted as an environment variable.

For a standalone server, a minimal `systemd` unit with `EnvironmentFile=` is
acceptable provided the file is `chmod 600` and owned by the service account.

### 3.3 Key rotation

1. Generate a new Stellar keypair:
   ```bash
   stellar keys generate relayer-new
   stellar keys show relayer-new  # get the public key
   ```
2. Fund the new key with XLM for fees.
3. Update the secrets manager / environment with the new `SIGNER_SECRET`.
4. Restart the relayer. The old key may be retired once the new process is
   confirmed healthy.

In development mode the signer key **is** registered on-chain: it must be the
settlement contract's configured `Endpoint`. Rotating it therefore requires
updating the contract's endpoint configuration (via the timelock) in addition
to the environment. In the production design there is no on-chain registration
of the executor key — the relayer's identity is its source-chain cursor and its
delivery record, not a registered key.

### 3.4 EVM RPC credentials

If your EVM RPC requires an API key (Alchemy, Infura, etc.), store the full
URL (including the key) in `PERIHELION_EVM_RPC_URL` and protect it with the
same secrets management as the Stellar key. Rotate it by updating the
environment variable and restarting.

---

## 4. Configuration

Copy `.env.example` and fill in every value before starting:

```bash
cp relayer/.env.example relayer/.env
```

### 4.1 All environment variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PERIHELION_RELAYER_MODE` | No | — | Set to `dev` to acknowledge development-mode endpoint impersonation. **Required** to start against Pubnet — see §4.1.1 |
| `PERIHELION_ESCROW_ADDRESS` | **Yes** | — | `0x`-prefixed 20-byte EVM escrow contract address |
| `PERIHELION_SETTLEMENT_CONTRACT` | **Yes** | — | Soroban settlement contract ID (`C…`, 56 chars) |
| `PERIHELION_EVM_RPC_URL` | No | `http://localhost:8545` | EVM source-chain RPC |
| `PERIHELION_STELLAR_RPC_URL` | No | `https://soroban-testnet.stellar.org` | Stellar/Soroban RPC |
| `PERIHELION_CONFIRMATIONS` | No | `6` | Block confirmations before relaying (see §4.2) |
| `PERIHELION_POLL_INTERVAL_MS` | No | `5000` | How often to poll for new messages (ms) |
| `PERIHELION_CHECKPOINT_FILE` | No | `./.perihelion-relayer-checkpoint.json` | Cursor persistence path (see §7) |
| `SIGNER_SECRET` | **Yes** | — | Stellar secret key used to sign delivery transactions |
| `STELLAR_NETWORK` | No | `Test SDF Network ; September 2015` | Stellar network passphrase |
| `PERIHELION_HEALTH_PORT` | No | `8080` | HTTP port for `/healthz`, `/readyz`, `/metrics` |
| `PERIHELION_HEALTH_HOST` | No | `127.0.0.1` | Bind address for the health server — see [§5.3](#53-readiness-check) before widening |
| `PERIHELION_METRICS_TOKEN` | No | — | If set, `/metrics` requires `Authorization: Bearer <token>`; `/healthz`/`/readyz` stay open |

The config loader validates all values at startup and exits with a descriptive
error list if anything is missing or malformed — fix every reported error
before retrying.

#### 4.1.1 The `PERIHELION_RELAYER_MODE` gate

The reference relayer impersonates the LayerZero endpoint (see
[§1.1](#11-current-implementation-development-mode)). To make that impossible
to do by accident against a public network, the CLI refuses to start when
`STELLAR_NETWORK` is the Stellar Pubnet passphrase
(`Public Global Stellar Network ; September 2015`) unless
`PERIHELION_RELAYER_MODE=dev` is set explicitly:

```
[ERROR] Refusing to start: endpoint-impersonation mode is not permitted on Pubnet.
        Set PERIHELION_RELAYER_MODE=dev only if you understand that the relayer
        key becomes the trusted endpoint and can forge or cancel any message.
```

- **Testnet / local / Futurenet** — the gate does not apply; the relayer runs
  in development mode by default.
- **Pubnet** — set `PERIHELION_RELAYER_MODE=dev` only for a deliberate,
  audited development exercise. Never set it for production traffic: the
  production design uses a real LayerZero endpoint and a permissionless
  executor, not this relayer.

### 4.2 Choosing confirmation depth

`PERIHELION_CONFIRMATIONS` determines the finality guarantee before the relayer
delivers a message. Too low risks relaying a message that gets orphaned by a
reorg; too high delays user settlement.

| Chain | Safe minimum | Notes |
|-------|-------------|-------|
| Ethereum mainnet | 12–20 | ~2–4 min; chain rarely reorgs beyond 2 |
| Base | 10–15 | Fast blocks; L2 reorgs track L1 finality |
| Arbitrum | 20–40 | Sequencer fast, but challenge period matters |
| Testnet (any) | 3–6 | Lower for faster iteration |

The value must satisfy:

```
CONFIRMATIONS × avg_block_time < escrow.confirmationGrace
```

so that the delivery window does not close before the relayer acts. The
`confirmationGrace` is configured on the EVM escrow contract (see the
[deployment runbook](./deployment.md#7-recommended-production-parameters)).

### 4.3 Poll interval

`PERIHELION_POLL_INTERVAL_MS` controls how often the relayer scans for new
events. 5 000 ms is a safe default. Reducing it increases RPC call frequency
and associated costs. Increasing it delays initial pickup of new messages.

---

## 5. Startup and readiness

### 5.1 Start the relayer

```bash
# Build first (only needed after code changes)
npm run build --workspace=relayer

# Production
node relayer/dist/cli.js

# Development (watch + reload)
npm run dev --workspace=relayer
```

As a long-running daemon, manage it with a process supervisor:

```ini
# systemd example: /etc/systemd/system/perihelion-relayer.service
[Unit]
Description=Perihelion LayerZero Relayer
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=relayer
WorkingDirectory=/opt/perihelion
EnvironmentFile=/etc/perihelion/relayer.env
ExecStart=/usr/local/bin/node relayer/dist/cli.js
Restart=on-failure
RestartSec=10
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

Or with Docker:

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY . .
RUN npm ci && npm run build
CMD ["node", "relayer/dist/cli.js"]
```

### 5.2 Expected startup output

A healthy start looks like:

```
[INFO]  Perihelion relayer starting
[INFO]  Loaded config: escrow=0x… settlement=C… confirmations=12 poll=5000ms
[INFO]  Mode: development (endpoint impersonation) — not for production use
[INFO]  Checkpoint loaded: evm=21045678 soroban=… (or "no checkpoint — starting from 0")
[INFO]  Relayer loops started: evm→soroban, soroban→evm
```

If config validation fails, the process exits immediately with a list of errors
before any network calls are made. Fix the reported variables and restart.

### 5.3 Readiness check

The relayer exposes an HTTP server (`HealthServer`, `relayer/src/health-server.ts`)
with three endpoints on `PERIHELION_HEALTH_PORT` (default `8080`):

| Path | Purpose |
|------|---------|
| `/healthz` | Liveness — always `200` while the process is alive |
| `/readyz` | Readiness — `200` when a recent tick succeeded and cursor lag is within bounds, `503` otherwise, with a `reasons` array explaining why |
| `/metrics` | Prometheus-style delivery/failure/dead-letter counters and cursor lag |

**Network exposure model.** `/readyz` and `/metrics` disclose operational
detail — how far behind the relayer is and why — that is useful reconnaissance
to an attacker timing a censorship or delay window. The server therefore binds
to `PERIHELION_HEALTH_HOST=127.0.0.1` by default; a log warning is emitted at
startup if bound anywhere else. Widen it only deliberately:

- **Kubernetes**: the readiness/liveness probe reaches the pod IP directly, so
  set `PERIHELION_HEALTH_HOST=0.0.0.0` in the pod spec — this is the expected,
  safe case (traffic stays inside the cluster network).
- **External scraping** (e.g. a Prometheus server outside the pod network): set
  `PERIHELION_METRICS_TOKEN` to a random secret and configure the scraper with
  `Authorization: Bearer <token>`. `/healthz` and `/readyz` remain
  unauthenticated (orchestrators need them to be) — do not widen the bind
  address for these without also putting a network policy or reverse proxy in
  front of them.

Fallback if you need to check readiness without curl access to the bind
address:

- **Process liveness**: check the process is running (`systemctl is-active
  perihelion-relayer`, or container health check on exit code).
- **Lag liveness**: monitor `latestProcessedBlock` in the checkpoint file
  against `eth_blockNumber` — lag greater than
  `(CONFIRMATIONS + POLL_INTERVAL_MS / avg_block_time_ms)` blocks indicates a
  stall.

---

## 6. Monitoring and alerting

### 6.1 Key signals to track

| Signal | How to observe | Alert threshold |
|--------|---------------|-----------------|
| **Relay lag** | `eth_blockNumber` minus checkpoint `latestBlock` | > 2× `CONFIRMATIONS` |
| **Delivery failure rate** | `ERROR` log lines mentioning `RelayResult.delivered=false` | Any sustained failures |
| **Dead-letter depth** | `DEAD_LETTER` structured log entries | > 0 |
| **Process crash / restart** | Supervisor restart counter | Any unexpected restart |
| **RPC error rate** | `ERROR` log lines mentioning RPC | > N per minute |
| **Signer balance** | Out-of-band Stellar account query | < threshold XLM |

### 6.2 Structured log fields

The relayer emits structured JSON logs. Key fields:

| Field | Meaning |
|-------|---------|
| `level` | `info` / `warn` / `error` |
| `msg` | Human-readable summary |
| `intentHash` | EIP-712 intent identifier |
| `srcEid` / `dstEid` | LayerZero endpoint IDs |
| `nonce` | Per-source monotonic counter |
| `attempts` | Retry count (present on errors) |
| `lastError` | Error message from the last attempt |

### 6.3 Dead-letter alerts

When a message exhausts its retry budget, the relayer emits an `error`-level
structured log with `msg=DEAD_LETTER`:

```json
{
  "level": "error",
  "msg": "DEAD_LETTER",
  "intentHash": "0x…",
  "messageType": "FillInstruction",
  "srcEid": 30101,
  "dstEid": 30316,
  "nonce": 42,
  "attempts": 5,
  "lastError": "contract revert: already settled"
}
```

Wire your log aggregator (CloudWatch, Datadog, Loki, etc.) to fire an alert on
`level=error msg=DEAD_LETTER`. See [§9.1](#91-stuck--dead-lettered-message) for
the response playbook.

### 6.4 Recommended Datadog / CloudWatch query patterns

```
# Dead-letter alert
filter level="error" and msg="DEAD_LETTER"

# Delivery failure rate
stats count() as failures by bin(5min)
filter level="error" and msg like /deliver/
```

---

## 7. Crash recovery and cursor persistence

### 7.1 How the cursor works

The relayer maintains **one cursor per direction** — the last EVM block it has
fully processed for the EVM → Soroban leg, and the last Soroban ledger/event
position for the Soroban → EVM leg. After every tick that advances a cursor, it
writes the new value to `PERIHELION_CHECKPOINT_FILE` using a
write-temp-then-rename strategy (atomic on POSIX filesystems). On restart, both
cursors are loaded from the checkpoint file. If no checkpoint exists (first
run), scanning begins from block 0 / the contract's deployment ledger.

This means:

- **A crash between ticks** — the relayer resumes from the last successfully
  checkpointed block. At most one tick's worth of messages is re-scanned.
- **Re-scanning the same block range** is safe — `DestinationDelivery.isDelivered`
  is checked before every delivery and prevents double-delivery even if a block
  range is reprocessed.
- **The checkpoint file is critical** — losing it forces a full re-scan from
  genesis. Back it up, or use a DB-backed `CheckpointStore` for higher
  durability.

### 7.2 Restart procedure

```bash
# If using systemd:
sudo systemctl restart perihelion-relayer

# Manual:
node relayer/dist/cli.js
```

The relayer handles `SIGTERM` and `SIGINT` with a graceful shutdown: the
current tick completes, the cursor is written, then the process exits. Avoid
`kill -9` where possible.

### 7.3 Recovering a lost or corrupt checkpoint

If the checkpoint file is lost or its JSON is corrupt:

1. Stop the relayer.
2. Find the EVM block at which the escrow was deployed (call it `$DEPLOY_BLOCK`).
3. Write a minimal checkpoint manually (one cursor per direction):
   ```bash
   echo '{"evm":{"latestBlock": <DEPLOY_BLOCK>},"soroban":{"latestLedger": <DEPLOY_LEDGER>}}' \
     > .perihelion-relayer-checkpoint.json
   ```
4. Restart. The relayer re-scans from `$DEPLOY_BLOCK` / `$DEPLOY_LEDGER`.
   Re-delivered messages are idempotently rejected by the settlement
   contract's `isDelivered` guard and the escrow's replay guard.

For multi-instance or cloud deployments, use a database-backed `CheckpointStore`
(inject a custom implementation via the `Relayer` constructor) backed by a
transactional store (PostgreSQL, DynamoDB) rather than the default file store.

---

## 8. Reorg handling

Each `PendingMessage` records the source block hash (`srcBlockHash`) at
observation time. Before delivering a confirmed message, the relayer should
re-read the block at `srcBlock` and compare hashes. If they differ, a reorg
occurred:

1. **Discard** the pending message — the originating transaction may have been
   re-ordered or dropped.
2. **Roll back** the cursor to `srcBlock - 1` so the reorged range is
   re-scanned on the next tick.
3. The settlement contract's replay guard prevents double-delivery even if the
   same message is re-observed in the canonical chain.

**Chain-specific guidance:**

| Chain | Typical reorg depth | Action |
|-------|--------------------|----|
| Ethereum mainnet | 0–2 blocks | `CONFIRMATIONS ≥ 12` makes reorgs extremely rare |
| Base | Follows L1 finality | Set confirmations to cover the L1 checkpoint period |
| Arbitrum | Sequencer reorgs possible | Set confirmations to cover the challenge window |

If you observe repeated reorg events at the same block range, check your RPC
provider — stale or inconsistent responses can mimic reorg behavior.

---

## 9. Incident playbooks

### 9.1 Stuck / dead-lettered message

**Symptoms:** `DEAD_LETTER` alert fires; one or more intents have not settled;
user funds are in the escrow waiting for delivery confirmation.

**Steps:**

1. Read the `lastError` from the alert or log aggregator.

2. **Diagnose by error type:**

   | `lastError` pattern | Likely cause | Action |
   |---------------------|-------------|--------|
   | `already settled` / `already delivered` | Message was delivered by a competing relayer or a previous retry that succeeded after the dead-letter threshold | Safe to `discard` — no user impact |
   | `contract revert` (non-duplicate) | Misconfigured peer, bad payload, or contract paused | Check peer config (§4.1); check `escrow.paused()` and `settlement.is_paused()` |
   | `ECONNREFUSED` / RPC timeout | RPC outage | Resolve RPC (§9.2), then `drain()` |
   | `insufficient funds` | Signer key out of XLM | Top up signer balance, then `drain()` |
   | `LayerZero: invalid nonce` | Out-of-order delivery | Check `nonce` ordering; `drain()` in correct order |

3. **Requeue dead-lettered messages** once root cause is resolved:
   - At the code level, `deadLetterStore.drain()` moves all entries back to
     the retry queue and the next tick retries them.
   - For a running relayer, trigger a graceful restart after fixing the
     environment — the in-memory dead-letter store is cleared on restart
     and messages will be re-observed from the checkpoint.

4. **Discard** a message only after confirming the underlying intent has
   reached a terminal on-chain state (settled or expired with refund issued).

5. **Escalate** to the protocol team with `intentHash`, `srcTxHash`, and
   `lastError` if the same message dead-letters repeatedly after a drain.

### 9.2 EVM RPC outage

**Symptoms:** `ERROR` log lines showing RPC errors; relay lag growing; no new
messages being picked up.

**Steps:**

1. Confirm the outage is provider-side:
   ```bash
   curl -X POST $PERIHELION_EVM_RPC_URL \
     -H 'Content-Type: application/json' \
     -d '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}'
   ```
2. If the provider is down, switch to a backup RPC:
   - Update `PERIHELION_EVM_RPC_URL` in the environment / secrets manager.
   - Restart the relayer. The checkpoint is intact; scanning resumes from
     the last processed block with no message loss.
3. Once the primary RPC recovers, rotate back if preferred.

**Prevention:** Configure at least two RPC endpoints and use a load-balancing
proxy (e.g. Alchemy's transport fallback or a custom `eth_rpc_fallback` list).

### 9.3 Soroban / Stellar RPC outage

**Symptoms:** Delivery failures; `RelayResult.delivered=false`; messages
accumulating in the retry queue.

**Steps:**

1. Test connectivity:
   ```bash
   curl "$PERIHELION_STELLAR_RPC_URL/health"
   ```
2. If down, switch `PERIHELION_STELLAR_RPC_URL` to a backup Soroban RPC and
   restart.
3. Messages already in the retry queue will be retried on the next tick once
   the RPC recovers. Dead-lettered messages need a `drain()` call (restart).

### 9.4 LayerZero DVN outage or path degradation

**Symptoms:** Messages are relayed (delivery transactions succeed on Stellar)
but the settlement contract's `lz_receive` rejects them; or LayerZero itself
reports degradation on the relevant path.

**Steps:**

1. Check the [LayerZero status page](https://layerzero.network) and the DVN
   operator dashboards for the configured verifier set.
2. The relayer has no control over the DVN set — this is a protocol-level
   issue. Do **not** lower `CONFIRMATIONS` to compensate.
3. If messages are being rejected by the destination, check that `srcEid`,
   `dstEid`, and peer addresses match the deployed contracts exactly
   (`escrow.stellarPeer()`, `settlement.get_peer(eid)`).
4. If the path is genuinely degraded and user funds are at risk of expiring in
   the escrow, coordinate with the protocol team to evaluate an emergency pause
   (see the [deployment runbook §8](./deployment.md#8-operations)) and extend
   `confirmationGrace` via the timelock if possible.

### 9.5 Signer key compromise

**Symptoms:** Unexpected delivery transactions from the relayer key that you did
not initiate, or a security alert from your key management system.

**Steps:**

1. Immediately generate a new Stellar keypair and fund it.
2. Update `SIGNER_SECRET` in the secrets manager with the new key.
3. **Development mode:** the compromised key is the settlement contract's
   trusted `Endpoint` and can forge or cancel any message. Pause the
   settlement contract via the timelock, rotate the endpoint configuration to
   the new key, then unpause. Treat any message delivered by the old key as
   suspect and reconcile against the EVM escrow.
4. **Production design:** the executor key carries no authority — it can only
   pay fees for a permissionless delivery call against a packet the real
   endpoint has already verified. The worst case is wasted XLM fees.
5. Restart the relayer — it picks up the new key on startup.
6. Revoke/archive the old key in your key management system.

### 9.6 Peer rotation (contract redeployment)

If the EVM escrow or Soroban settlement contract is redeployed to a new address:

1. Update `PERIHELION_ESCROW_ADDRESS` and/or `PERIHELION_SETTLEMENT_CONTRACT` in
   the environment.
2. Reset the checkpoint to the new contract's deployment block / ledger:
   ```bash
   echo '{"evm":{"latestBlock": <NEW_DEPLOY_BLOCK>},"soroban":{"latestLedger": <NEW_DEPLOY_LEDGER>}}' \
     > .perihelion-relayer-checkpoint.json
   ```
3. Restart the relayer.

Messages emitted by the old contract address will no longer be picked up. If
any old messages need to be delivered, run a one-off backfill scan against the
old escrow address in a separate relayer instance.

---

## 10. Related reliability issues

The following open issues track reliability improvements that affect this
runbook. When they land, update the relevant sections:

- **Health endpoint** — adds an HTTP `/health` and `/ready` endpoint; update
  §5.3 once merged.
- **Metrics emission** — structured Prometheus/StatsD metrics for lag, delivery
  rate, and dead-letter depth; update §6.1 once merged.
- **Cursor persistence hardening** — DB-backed `CheckpointStore`; update §7.3
  once merged.
- **Solver runbook** (issue #9) — the companion document to this one; cross-reference
  for shared deployment patterns. See [`docs/running-a-solver.md`](./running-a-solver.md).
- **Trust-model labelling** (issue #938) — labels this relayer as a
  development-only stand-in for the LayerZero executor, adds the
  `PERIHELION_RELAYER_MODE=dev` gate and Pubnet refusal, and documents the
  production permissionless-executor design. See [§1.2](#12-development-mode-vs-production)
  and [§4.1.1](#411-the-perihelion_relayer_mode-gate).
- **Bidirectional relaying** (issue #941) — adds the Soroban → EVM leg
  (`FillConfirmed`, `CancelIntent`) with a separate checkpoint. See
  [§1.1](#11-current-implementation-development-mode) and [§7.1](#71-how-the-cursor-works).

---

## See also

- [Deployment & Operations](./deployment.md) — contract deployment, timelock multisig, emergency pause
- [Running a Solver](./running-a-solver.md) — solver operator runbook (mirror structure)
- [Architecture Overview](./architecture.md) — high-level settlement flow and trust model
- [Technical Architecture](./TECHNICAL-ARCHITECTURE.md) — full production spec including LayerZero V2 and the DVN trust model
- [Relayer README](../relayer/README.md) — implementation details and extension points
