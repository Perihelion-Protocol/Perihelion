# Mock Mempool Server

A local in-memory REST API for Perihelion intent submission and polling, enabling end-to-end SDK→mempool→solver development without a deployed infrastructure.

## Quick Start

```bash
npm run dev --workspace=@perihelion/mempool
```

The server listens on `http://localhost:3000`.

## Configuration

Set via environment variables. `loadConfig` validates all of them at startup and
reports every problem at once (by variable name) rather than binding a random
port or silently rejecting every submission.

| Variable | Required | Default | Notes |
|----------|----------|---------|-------|
| `PERIHELION_SOURCE_CHAIN_ID` | Yes | — | Positive integer; binds the EIP-712 domain. |
| `PERIHELION_ESCROW_ADDRESS` | Yes | — | `0x`-prefixed 20-byte EVM address; binds the EIP-712 domain. |
| `PORT` | No | `3000` | Integer in `1`–`65535`. |
| `PERIHELION_MEMPOOL_HOST` | No | `localhost` | Non-loopback hosts log a no-auth warning. |
| `PERIHELION_MEMPOOL_STATUS_TOKEN` | No | — | Bearer token required on `PATCH /intents/:hash/status`. |

The CLI installs `SIGINT`/`SIGTERM` handlers that stop the listener and let
in-flight requests drain before the process exits.

## API

See [`docs/api/mempool-api.yaml`](../docs/api/mempool-api.yaml) for the full
OpenAPI contract, including error responses and known gaps between this
reference implementation and the SDK.

- `POST /intents` — Submit a signed intent. Verifies the EIP-712 signature before storing.
- `GET /intents/:hash` — Fetch an intent's current record by hash.
- `GET /intents?status=pending&chainId=8453&limit=20&offset=0` — List intents,
  optionally filtered by status (`pending`, `settled`, `refunded`, `expired`)
  and/or `chainId`, and paginated with `limit`/`offset`.
- `GET /info` — Discover the EIP-712 domain (`name`, `version`, `chainId`,
  `verifyingContract`) this instance verifies signatures against.

## E2E Flow

```ts
import { PerihelionClient, buildIntent } from "@perihelion/sdk";

const client = new PerihelionClient({ mempoolUrl: "http://localhost:3000" });
const intent = buildIntent({ /* ... */ });
const signed = await client.signIntent(wallet, intent);
const hash = await client.submitIntent(signed);
const result = await client.waitForSettlement(hash);
```

## Integration

The server exposes a `MempoolServer` class with a `updateStatus(hash, status)` method, allowing external coordination (solvers, relayers, test harnesses) to advance intent records through their lifecycle.
