# @perihelion/relayer

> **⚠️ Development-only stand-in.** The reference relayer in this directory is
> **not** a production LayerZero executor. It impersonates the LayerZero
> endpoint on Stellar: it signs `lz_receive` with its own Stellar key, so the
> relayer account must be configured as the settlement contract's `Endpoint`,
> and the relayer key therefore carries full authority to deliver arbitrary
> messages. No DVN verifies anything on this path. See
> [Trust model](#trust-model-development-shim) below. Production must use a
> real LayerZero endpoint/adapter on Stellar.

A lightweight reference relayer for the Perihelion **Stellar ↔ EVM** path. It
exists to exercise the full message flow in local development and test
networks; it is not the production messaging layer.

## What it does

The relayer runs **one loop per direction**, each with its own checkpoint:

```
EVM escrow ──emit MessageSent──► [EVM→Soroban loop: confirm N blocks] ──► Soroban settlement
                                                                           (lz_receive)
Soroban settlement ──emit outbound──► [Soroban→EVM loop] ──► EVM escrow
                                                              (lzReceive: Released / Refunded)
```

- **EVM → Soroban** (`EVMSourceWatcher` + `SorobanDestinationDelivery`): watches
  the EVM escrow for `Locked` commitments, waits for a configurable confirmation
  depth, and delivers each message to the settlement contract's `lz_receive`.
- **Soroban → EVM** (`SorobanSourceWatcher` + `EvmDestinationDelivery`): follows
  the settlement contract's outbound messages (`FillConfirmed`, `CancelIntent`)
  and delivers them to the EVM escrow's `lzReceive`, so a fill releases the
  solver's payment (`Released`) and a Stellar-side cancellation refunds the user
  (`Refunded`).

Each direction keeps a separate cursor in the `CheckpointStore`, so a restart
resumes both legs independently.

## Trust model (development shim)

In the architecture this code implements, the relayer is **trusted**:

- `SorobanDestinationDelivery` calls `lz_receive` directly in a transaction
  signed by `SIGNER_SECRET`. For delivery to succeed, that account must be the
  settlement contract's configured `Endpoint`, i.e. the relayer impersonates
  the endpoint.
- The relayer also sets `Origin.sender` from the contract's own
  `get_peer(srcEid)`, so the peer check is self-fulfilling.
- Consequently, whoever holds the relayer's Stellar secret can register any
  intent with any recipient, amount and deadline, and can inject cancellations.
  No DVN verifies anything.

This is acceptable **only** as a development shim. The key is an ordinary
environment variable and must never be used against a public network.

### Production design

In production, the relayer is a **permissionless executor** with no authority of
its own:

- It calls the real LayerZero endpoint/adapter on Stellar with a verified
  packet; the endpoint (with its independent multi-DVN verifier set) performs
  authentication, and the relayer key carries no authority.
- The same applies in the other direction: delivery to the EVM escrow goes
  through the real LayerZero endpoint on EVM.
- Production relies on LayerZero executors for **both** legs. Anyone can run an
  executor; a faulty one can delay or censor, but cannot forge a delivery.

## Run

The relayer refuses to start unless `PERIHELION_RELAYER_MODE=dev` is set, and
it refuses to start against Pubnet in this mode regardless. This gate exists
because the reference relayer impersonates the endpoint (see above).

```bash
npm install
cp .env.example .env   # then edit
export PERIHELION_RELAYER_MODE=dev
npm run build && npm start
# or, for local development:
npm run dev
```

| Variable                     | Meaning                                                        |
| ---------------------------- | -------------------------------------------------------------- |
| `PERIHELION_RELAYER_MODE`    | Must be `dev`; any other value (or unset) refuses to start.    |
| `PERIHELION_STELLAR_NETWORK` | Stellar network; `pubnet`/`public` is refused in `dev` mode.   |

## Customizing

Three extension points to implement for a live deployment:

1. **`SourceWatcher`** — subscribe to the EVM escrow's `MessageSent` event and
   decode each log into a `PendingMessage`.
2. **`DestinationDelivery`** — submit the message to the Soroban settlement
   contract and expose an `isDelivered` view for the replay guard.
3. **`CheckpointStore`** — persist the cursor durably. `cli.ts` ships a
   `FileCheckpointStore` (`PERIHELION_CHECKPOINT_FILE`) by default; inject a
   DB-backed implementation for multi-instance or higher-durability setups.

| Module                     | Responsibility                                     |
| -------------------------- | -------------------------------------------------- |
| `types.ts`                 | `BridgeMessage` / `PendingMessage` / `RelayResult` |
| `config.ts`                | Load config from environment, enforce `dev` mode gate |
| `relayer.ts`                | The watch → confirm → deliver loop (one per direction) |
| `evm-watcher.ts`            | `EVMSourceWatcher` — EVM escrow → Soroban leg      |
| `soroban-delivery.ts`       | `SorobanDestinationDelivery` — delivers to `lz_receive` |
| `soroban-watcher.ts`        | `SorobanSourceWatcher` — Soroban settlement → EVM leg |
| `evm-delivery.ts`           | `EvmDestinationDelivery` — delivers to escrow `lzReceive` |
| `checkpoint.ts`             | `CheckpointStore` interface + no-op default        |
| `file-checkpoint-store.ts`  | Durable file-backed `CheckpointStore`              |
| `index.ts`                  | Library entry point — re-exports only, no side effects |
| `cli.ts`                    | CLI entry point (`perihelion-relayer`) + graceful shutdown |

## Cursor durability

Each direction's cursor is the sole record of that leg's relay progress. It is
persisted to the configured `CheckpointStore` after every tick that advances it,
and resumed on `start()` via `CheckpointStore.load()` — falling back to the
configured start position only on first run (no checkpoint yet). This means a
restart never re-scans from genesis and never silently skips messages emitted
while the process was down, on either leg.

This works *together with*, not instead of, `DestinationDelivery.isDelivered`:
the checkpoint avoids redundant re-scanning, while `isDelivered` is what
actually prevents double-delivery if the same block range is ever reprocessed
(e.g. a checkpoint write that didn't make it to durable storage before a
crash). A `CheckpointStore` implementation must persist `save()` durably
enough to survive a process crash — at minimum an fsync'd file (as
`FileCheckpointStore` does, via write-temp-then-rename) or a transactional DB
write.
