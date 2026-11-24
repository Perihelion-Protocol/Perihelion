# Integration Quickstart

This guide takes you from zero to a **tracked, settled intent** in under five
minutes.  You will install the SDK, spin up a local mock mempool, build an
intent with a real Stellar destination, sign it with a local private key, submit
it to the mempool, and poll until it reaches a terminal state.

> **Prerequisites** — Node.js ≥ 20 and the monorepo installed locally:
> ```bash
> git clone https://github.com/Perihelion-Protocol/perihelion.git
> cd perihelion
> npm install
> npm run build
> ```

---

## 0. Stellar destination requirements (read this first)

Before you build an intent, make sure the **Stellar recipient can actually
receive the destination asset**.  The Soroban settlement contract delivers
funds with a classic Stellar Asset Contract `transfer` to the recipient's
`G…` account, and that transfer fails — locking the user's funds until
`deadline + confirmationGrace` — if the recipient is not set up for the asset.

| `destAsset` | Requirement on the recipient `G…` account |
|-------------|-------------------------------------------|
| `CODE:ISSUER` (e.g. `USDC:GA5Z…`) | The account **must exist** and hold an **authorised trustline** for `CODE:ISSUER`. |
| `native` | The account **must exist** (it must be funded with at least the base reserve). |

A fresh, unfunded Stellar account has neither, so bridging USDC to a brand-new
account will fail unless the account is created and its trustline is
established first.

**The SDK can pre-check this for you.**  `buildIntent` accepts an optional
`checkTrustline` flag (and an optional `horizonUrl` / `rpcUrl` to query).  When
enabled, `buildIntent` queries Horizon (or Soroban RPC `getLedgerEntries`) and
throws a `PerihelionTrustlineError` before the intent is ever signed or
submitted if the recipient does not exist or lacks an authorised trustline for
the destination asset:

```js
const intent = buildIntent({
  // …fields as in step 3…
  destAsset: "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
  checkTrustline: true,
  horizonUrl: "https://horizon.stellar.org",
});
// Throws PerihelionTrustlineError if the recipient cannot receive the asset.
```

**Solvers enforce this too.**  Before locking funds on the source chain, a
solver checks the recipient's trustline via Soroban RPC `getLedgerEntries`.  If
the trustline is missing (or the account does not exist for `native`), the
solver **skips the intent terminally** — it will not fill it, so no LayerZero
fee is spent on a lock leg that cannot settle.  This means an intent to a
recipient without a trustline will never be filled, even if it is accepted by
the mempool.  Always pre-check on the client side.

---

## 1. Start the local mock mempool

The `@perihelion/mempool` package ships an in-memory REST server that accepts
intents, verifies EIP-712 signatures, and exposes a `updateStatus` helper so
your test harness can advance intent lifecycle state without a real on-chain
settlement.

```bash
# In a dedicated terminal:
npm run dev --workspace=@perihelion/mempool
# → Mempool server listening on http://localhost:3000
```

The server exposes three endpoints:

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/intents` | Submit a signed intent (signature is verified) |
| `GET`  | `/intents/:hash` | Fetch an intent record by hash |
| `GET`  | `/intents?status=pending` | List intents filtered by lifecycle status |

---

## 2. Install the SDK

```bash
# In your project (or create a temporary one):
npm install @perihelion/sdk viem
```

---

## 3. Build, sign, and submit an intent

The following script is a complete, runnable example.  Copy it to
`quickstart.mjs` and run `node quickstart.mjs` while the mempool server from
step 1 is running.

```js
// quickstart.mjs
import { privateKeyToAccount } from "viem/accounts";
import { createWalletClient, http } from "viem";
import { base } from "viem/chains";
import { PerihelionClient, buildIntent } from "@perihelion/sdk";

// ─── 1. Wallet setup ────────────────────────────────────────────────────────
//
// In production, use a hardware wallet or a key management service.
// For this quickstart, use a well-known Anvil/Hardhat dev key.
const PRIVATE_KEY =
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

const account = privateKeyToAccount(PRIVATE_KEY);
const wallet  = createWalletClient({ account, chain: base, transport: http() });

console.log("Signer address:", account.address);
// → Signer address: 0x70997970C51812dc3A010C7d01b50e0d17dc79C8

// ─── 2. Client setup ────────────────────────────────────────────────────────
//
// Point at the local mock mempool started in step 1.
// chainId + verifyingContract are required for signIntent; they bind the
// EIP-712 domain to a specific chain and escrow deployment.
const ESCROW_ADDRESS = "0x1234567890123456789012345678901234567890";
const CHAIN_ID       = 8453; // Base

const client = new PerihelionClient({
  mempoolUrl:        "http://localhost:3000",
  chainId:           CHAIN_ID,
  verifyingContract: ESCROW_ADDRESS,
});

// ─── 3. Build the intent ─────────────────────────────────────────────────────
//
// buildIntent validates every field and fills in a random nonce and an open
// preferredSolver (zero address → any solver may fill).
//
// checkTrustline: true makes buildIntent query Horizon and throw a
// PerihelionTrustlineError if the recipient does not exist or lacks an
// authorised trustline for destAsset (see step 0).  Omit it (or set it to
// false) to skip the network check.
const intent = buildIntent({
  user:          account.address,
  // Real Stellar account strkey — 56-char G.../C... base32 address.
  // This account must exist and hold a trustline for the destAsset below.
  destination:   "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
  sourceChainId: CHAIN_ID,
  sourceAsset:   "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // USDC on Base
  sourceAmount:  "1000000",    // 1 USDC (6 decimals)
  destAsset:     "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
  minDestAmount: "9900000",    // accept ≥ 0.99 USDC on Stellar (7 decimals)
  deadline:      Math.floor(Date.now() / 1000) + 600, // 10 minutes from now
  checkTrustline: true,
  horizonUrl:    "https://horizon.stellar.org",
});

console.log("Intent nonce:", intent.nonce);
// → Intent nonce: <random 256-bit decimal string>

// ─── 4. Sign ─────────────────────────────────────────────────────────────────
//
// signIntent calls wallet.signTypedData (EIP-712) via viem and returns a
// { intent, signature, hash } bundle.
const signed = await client.signIntent(wallet, intent);
console.log("Intent hash:", signed.hash);
// → Intent hash: 0x<32-byte EIP-712 keccak256>

// ─── 5. Submit ───────────────────────────────────────────────────────────────
//
// submitIntent POSTs to /intents, verifying the server echoes the same hash.
const hash = await client.submitIntent(signed);
console.log("Submitted:", hash);
// → Submitted: 0x<same hash>

// ─── 6. Poll to settlement ───────────────────────────────────────────────────
//
// waitForSettlement polls /intents/:hash every 3 s and resolves once the
// intent reaches a terminal state: "settled", "refunded", or "expired".
//
// The mock mempool never auto-advances status, so in this quickstart the poll
// will time out after 30 s (demonstrating the timeout path).
// In a real integration, a solver / relayer calls updateStatus(hash, "settled").
//
// The onStatus callback lets you log every transition:
const result = await client.waitForSettlement(hash, {
  intervalMs: 3_000,
  timeoutMs:  30_000,
  onStatus: (status) => console.log("Status →", status),
}).catch((err) => {
  // PerihelionTimeoutError is thrown when the intent does not settle in time.
  console.log("Timed out (expected for mock):", err.message);
  return null;
});

if (result) {
  console.log("Final status:", result.status); // "settled" | "refunded" | "expired"
}
```

Expected output (with the mock mempool running):

```
Signer address: 0x70997970C51812dc3A010C7d01b50e0d17dc79C8
Intent nonce: 48193...
Intent hash:  0x7b3f...
Submitted:    0x7b3f...
Status → pending
Timed out (expected for mock): [Perihelion] waitForSettlement timed out for 0x7b3f... (last status: pending)
```

> **Note on `checkTrustline`** — the trustline pre-check queries a live Horizon
> endpoint, so it is skipped automatically when the mock mempool is used without
> a `horizonUrl`.  In production, always pass `checkTrustline: true` so a
> misconfigured destination is caught before the EVM lock.

---

## 4. Advance the intent in tests (mock-mempool API)

The `MempoolServer` class exposes an `updateStatus(hash, status)` method for
test harnesses that need to drive intent state without real on-chain
infrastructure:

```js
// In your test / integration harness (Node.js):
import { MempoolServer } from "@perihelion/mempool";

// chainId and verifyingContract are required and must match the domain
// used to sign intents (see CHAIN_ID / ESCROW_ADDRESS above).
const server = new MempoolServer({ port: 3001, chainId: CHAIN_ID, verifyingContract: ESCROW_ADDRESS });
await server.start();

// … submit an intent via the client …

// Advance the intent to "settled" to unblock waitForSettlement:
server.updateStatus(hash, "settled");
```

This pattern is used in `sdk/test/client.test.ts` and lets you write fast,
deterministic end-to-end tests with no network dependency.

---

## 5. Verify a signature off-chain

```js
import { verifyIntent, perihelionDomain } from "@perihelion/sdk";

const domain = perihelionDomain(CHAIN_ID, ESCROW_ADDRESS);
const valid  = await verifyIntent(intent, signed.signature, domain);
console.log("Signature valid:", valid); // true
```

---

## 6. Track multiple intents

```js
// List all pending intents from the mempool:
const pending = await client.listPending("pending");
console.log("Pending:", pending.length);

// Fetch a single intent by hash:
const record = await client.getIntent(hash);
console.log("Record:", record.status, record.intent.deadline);
```

---

## What's next?

| Resource | Description |
|----------|-------------|
| [Intent Specification](./intent-spec.md) | Full field-level spec, encoding, and EIP-712 domain |
| [Architecture](./architecture.md) | Settlement flow and trust model |
| [Technical Architecture](./TECHNICAL-ARCHITECTURE.md) | Full production spec |
| [Running a Solver](./running-a-solver.md) | How to run a reference solver node |
| [FAQ](./faq.md) | Common questions, including trustline troubleshooting |
| [sdk/README.md](../sdk/README.md) | Full SDK API reference |
| [mempool/README.md](../mempool/README.md) | Mock mempool server docs |

---

## Keeping this guide in sync

The `quickstart.mjs` snippet above uses only the public SDK API surface
(`buildIntent`, `signIntent`, `submitIntent`, `waitForSettlement`,
`verifyIntent`, `perihelionDomain`, `listPending`, `getIntent`).  If any of
those signatures change, the TypeScript compiler will flag the mismatch in
`sdk/test/client.test.ts` (which exercises the same call path) before it can
silently break this guide.