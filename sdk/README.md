# @perihelion/sdk

TypeScript SDK for building dApps, wallets, and payment products on the
Perihelion intent-based cross-chain bridge. Handles intent construction,
EIP-712 signing, submission, and status tracking — the common case is three
function calls.

## Install

```bash
npm install @perihelion/sdk viem
```

## Quick start

> **Full walkthrough** — for a step-by-step guide that builds, signs, submits,
> and tracks an intent against the local mock mempool, see the
> **[Integration Quickstart](../docs/quickstart.md)**.

```ts
import { PerihelionClient, buildIntent } from "@perihelion/sdk";

const client = new PerihelionClient({
  mempoolUrl: "https://mempool.perihelion.xyz",
});

const intent = buildIntent({
  user: account.address,
  destination: "GUSER...STELLAR",
  sourceChainId: 8453, // Base
  sourceAsset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // USDC on Base
  sourceAmount: "1000000", // 1 USDC (6 decimals)
  destAsset: "USDC:GA5Z...", // USDC on Stellar
  minDestAmount: "9900000", // accept >= 0.99 (7 decimals)
  deadline: Math.floor(Date.now() / 1000) + 600,
});

const signed = await client.signIntent(wallet, intent); // viem WalletClient
const hash = await client.submitIntent(signed);
const result = await client.waitForSettlement(hash);
console.log(result.status); // "settled"
```

## API surface

| Export             | Purpose                                                   |
| ------------------ | --------------------------------------------------------- |
| `buildIntent`      | Construct an `Intent`, defaulting nonce + open solver     |
| `hashIntent`       | EIP-712 hash — the protocol's universal intent id         |
| `verifyIntent`     | Recover and check an intent signature                     |
| `PerihelionClient` | `signIntent`, `submitIntent`, `getIntent`, `waitForSettlement` |
| `INTENT_TYPES` / `PERIHELION_DOMAIN` | EIP-712 type + domain for custom signers |

### Verifying smart-contract wallet signatures

`verifyIntent` accepts EOA (ECDSA) and ERC-1271 smart-contract wallet signatures.
Pass a viem `PublicClient` as the `client` option so the SDK can detect contract
accounts and call `isValidSignature`:

```ts
import { createPublicClient, http } from "viem";

const ok = await verifyIntent(intent, signature, domain, { client: publicClient });
```

Without `client`, contract users fail verification. `isContract` can be passed
instead to skip the `getCode` lookup. The option is `client`; `publicClient` is a
type error.

### Checking refundability

Use `PerihelionEscrowClient.refundStatus(intentHash)` to decide whether to call
`cancelExpired`. It reads the lock, `confirmationGrace()` and `block.timestamp`
at one block and returns `{ refundable, reason }`. `isRefundable(intentHash)` is
the boolean form of the same check. Units are seconds throughout.

`PerihelionClient.isRefundable(record, graceSeconds)` is deprecated. It reads only
the mempool record and the local clock, so use it at most as a UI pre-filter.

See [`../docs/intent-spec.md`](../docs/intent-spec.md) for the full intent
specification, and the
[Intent Lifecycle State Diagram](../docs/TECHNICAL-ARCHITECTURE.md#intent-lifecycle-state-diagram)
for a complete mapping of SDK `IntentStatus` values to the on-chain states on
both the EVM escrow and the Soroban settlement contract, including every
transition, failure path, and race resolution.

## Develop

```bash
npm run build   # tsc -> dist/
npm test        # node:test + tsx
```
