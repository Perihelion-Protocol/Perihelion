# Mock Mempool Server

A local in-memory REST API for Perihelion intent submission and polling, enabling end-to-end SDK→mempool→solver development without a deployed infrastructure.

## Quick Start

```bash
npm run dev --workspace=@perihelion/mempool
```

The server listens on `http://localhost:3000`.

## API

See [`docs/api/mempool-api.yaml`](../docs/api/mempool-api.yaml) for the full
OpenAPI contract, including error responses and known gaps between this
reference implementation and the SDK.

- `POST /intents` — Submit a signed intent. Verifies the EIP-712 signature before storing.
- `GET /intents/:hash` — Fetch an intent's current record by hash. The `:hash`
  is normalised to lower case and rejected with `400` if it is not a
  `0x`-prefixed 32-byte hex string.
- `GET /intents?status=pending&chainId=8453&limit=20&cursor=0x…` — List intents,
  optionally filtered by status (`pending`, `settled`, `refunded`, `expired`)
  and/or `chainId`, and paginated with `limit` plus an opaque `cursor` (the
  `nextCursor` from the previous page). A cursor that no longer resolves to a
  record — because it was evicted, or a status change moved it out of a
  status-filtered set — returns `400` with `code: "unresolvable_cursor"`
  rather than silently restarting from the first page.
- `PATCH /intents/:hash/status` — Report a lifecycle transition. Requires the
  shared bearer token when `statusToken` is configured. Applies the same
  `:hash` normalisation and validation as `GET /intents/:hash`.
- `GET /info` — Discover the EIP-712 domain (`name`, `version`, `chainId`,
  `verifyingContract`) this instance verifies signatures against.

## Deployment notes

- **Reverse proxies / load balancers.** The per-IP rate limiter on
  `POST /intents` keys on `req.ip`. With no proxy in front, leave
  `PERIHELION_MEMPOOL_TRUST_PROXY` unset. Behind one or more proxies, set it to
  the number of proxy hops (`PERIHELION_MEMPOOL_TRUST_PROXY=1`), a preset
  (`loopback`), or a comma-separated subnet list — otherwise every request
  appears to originate from the proxy and the limiter collapses to a single
  global bucket. The value maps directly onto Express's
  [`trust proxy`](https://expressjs.com/en/guide/behind-proxies.html) setting.
- **Rate-limiter memory.** Entries are pruned on a 30-second sweep once their
  most recent hit ages past the 60-second window, and the map is capped at
  10,000 distinct source IPs (LRU eviction) as a backstop.

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
