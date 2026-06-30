# Architecture

Perihelion is an **intent + solver** bridge. Users express _what_ they want;
a competitive solver network figures out _how_ to deliver it, and the protocol
guarantees that settlement is atomic — the user is made whole or refunded, never
left mid-bridge.

## Actors

| Actor       | Role                                                                  |
| ----------- | -------------------------------------------------------------------- |
| **User**    | Signs an intent off-chain; spends on a source EVM chain, receives on Stellar |
| **Solver**  | Competes to fill intents; fronts liquidity, earns the spread          |
| **Relayer** | Carries LayerZero messages along the Stellar ↔ EVM path (permissionless) |
| **Contracts** | EVM escrow (source) + Soroban settlement (destination)             |

## Happy-path flow

```
1. User signs Intent (EIP-712)         off-chain, no gas
        │
2. Intent enters the mempool           open, permissionless
        │
3. Solver evaluates + wins             quote.ts: margin >= threshold
        │
4. Solver calls escrow.lock(intent)    EVM: pulls user funds, emits Locked
        │
5. Relayer observes Locked, waits N    confirmations for finality
        │
6. Relayer delivers to lz_receive      Soroban: verifies, releases to user
        │   ── user has funds on Stellar ✓
        │
7. Settlement confirmation relayed     back to EVM escrow
        │
8. escrow.release(intentHash)          pays the solver its locked funds
```

If step 6 never lands and the deadline passes, anyone may call
`escrow.refund(intentHash)` to return the user's funds. Because the solver
fronts its own liquidity on the destination side, the user's risk is bounded:
they are either settled on Stellar or refunded on the source chain.

## Commitment binding

A single value ties every leg together: the **intent hash**, the EIP-712 hash of
the user's intent.

- The SDK computes it (`hashIntent`) when the user signs.
- The EVM escrow recomputes it (`hashIntent`) and keys the lock on it.
- The relayer carries it in the `BridgeMessage`.
- The Soroban contract records it to prevent double-settlement (`is_settled`).

The EVM `DOMAIN_SEPARATOR` / `INTENT_TYPEHASH` and the SDK
`PERIHELION_DOMAIN` / `INTENT_TYPES` are kept byte-for-byte identical, so the
hash is stable across off-chain and on-chain code.

## Trust model

- **Messaging** rides LayerZero's DVN verification (the current and sole
  verification mechanism). Stellar Protocol 24 ZK proofs are a planned future
  enhancement (see the Phase-3 roadmap in
  [TECHNICAL-ARCHITECTURE.md §8.3](./TECHNICAL-ARCHITECTURE.md#83-phase-3--trust-minimized-verification-zk-proposed))
  that would allow the destination to verify source-chain state directly,
  removing trust in the relayer entirely. They are not yet integrated.
- **Relayers are permissionless.** A faulty relayer can delay or censor, but
  cannot forge a delivery — the settlement contract authorizes only its
  configured endpoint and verifies the message independently.
- **Solvers are permissionless.** They are economically motivated by the spread
  and bounded by `minDestAmount`; they cannot deliver less than the user
  accepted.
- **No custodial bridge.** There is no lock-and-mint wrapper asset; users receive
  canonical Stellar assets sourced from solver liquidity.

## Pricing

Settlement amounts respect the intent's `minDestAmount` (the user's slippage
floor). Solvers price the destination leg against Stellar's SDEX and external
venues; the Soroban contract can consult a SEP-40 oracle (e.g. RedStone) to
sanity-check pricing at settlement time.
