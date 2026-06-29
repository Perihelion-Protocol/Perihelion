# @perihelion/relayer

A lightweight LayerZero message relayer optimized for the Perihelion
**Stellar ↔ EVM** path. Open source and permissionlessly runnable, so the
messaging layer has no single point of failure.

## What it does

The relayer watches the EVM escrow contract for locked-fund commitments, waits
for a configurable confirmation depth, and delivers each verified message to the
Soroban settlement contract's `lz_receive` entrypoint.

```
EVM escrow ──emit MessageSent──► [relayer: confirm N blocks] ──► Soroban settlement
                                                                  (verifies + releases)
```

It is **trust-minimized**: the relayer only transports messages whose
authenticity the destination verifies independently (LayerZero DVN stack, plus
Stellar Protocol 24 ZK proofs where available). A faulty relayer can delay or
censor, but cannot forge a delivery — and anyone can run another.

## Run

```bash
npm install
cp .env.example .env   # then edit
npm run build && npm start
# or, for local development:
npm run dev
```

## Customizing

Three extension points to implement for a live deployment:

1. **`SourceWatcher`** — subscribe to the EVM escrow's `MessageSent` event and
   decode each log into a `PendingMessage`.
2. **`DestinationDelivery`** — submit the message to the Soroban settlement
   contract and expose an `isDelivered` view for the replay guard.
3. **`CheckpointStore`** — persist the cursor durably. `index.ts` ships a
   `FileCheckpointStore` (`PERIHELION_CHECKPOINT_FILE`) by default; inject a
   DB-backed implementation for multi-instance or higher-durability setups.

| Module                     | Responsibility                                     |
| -------------------------- | -------------------------------------------------- |
| `types.ts`                 | `BridgeMessage` / `PendingMessage` / `RelayResult` |
| `config.ts`                | Load config from environment                       |
| `relayer.ts`                | The watch → confirm → deliver loop                 |
| `checkpoint.ts`             | `CheckpointStore` interface + no-op default        |
| `file-checkpoint-store.ts`  | Durable file-backed `CheckpointStore`              |
| `index.ts`                  | CLI entry point + graceful shutdown                |

## Cursor durability

The relayer's cursor is the sole record of relay progress. It is persisted to
the configured `CheckpointStore` after every tick that advances it, and
resumed on `start()` via `CheckpointStore.load()` — falling back to the
configured start block only on first run (no checkpoint yet). This means a
restart never re-scans from genesis and never silently skips messages emitted
while the process was down.

This works *together with*, not instead of, `DestinationDelivery.isDelivered`:
the checkpoint avoids redundant re-scanning, while `isDelivered` is what
actually prevents double-delivery if the same block range is ever reprocessed
(e.g. a checkpoint write that didn't make it to durable storage before a
crash). A `CheckpointStore` implementation must persist `save()` durably
enough to survive a process crash — at minimum an fsync'd file (as
`FileCheckpointStore` does, via write-temp-then-rename) or a transactional DB
write.
