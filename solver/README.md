# @perihelion/solver

Open-source reference implementation of a Perihelion **solver node**. Any
operator can run this to participate in the solver network and earn the spread
on filled intents.

The node polls the intent mempool, evaluates each pending intent for
profitability (using live liquidity from Stellar's SDEX and external venues),
and atomically fills the winners across the EVM escrow and Soroban settlement
contracts.

**New to running a solver?** See the [operator runbook](../docs/running-a-solver.md)
for a step-by-step guide to prerequisites, configuration, monitoring, and troubleshooting.

## Run

```bash
npm install
cp .env.example .env   # then edit
npm run build && npm start
# or, for local development:
npm run dev
```

## How it works

```
poll mempool ──► verify signature ──► evaluate() profitability ──► fill()
                                            │                        │
                                  margin >= threshold?      lock EVM escrow +
                                  asset supported?          release on Stellar
                                  before deadline?
```

| Module        | Responsibility                                                |
| ------------- | ------------------------------------------------------------- |
| `config.ts`   | Load operator config from environment                         |
| `quote.ts`    | Price the destination asset and decide whether to fill        |
| `solver.ts`   | The poll → evaluate → fill loop                                |
| `index.ts`    | CLI entry point + graceful shutdown                            |

## Customizing

The two extension points a real operator must implement:

1. **`priceDestAsset` in `quote.ts`** — replace the stub 1:1 corridor with real
   routing against SDEX / external DEXs and your own inventory.
2. **`Executor` in `solver.ts`** — wire the two settlement legs: lock source
   funds in the EVM escrow against the intent hash, then release destination
   assets via the Soroban settlement contract after LayerZero confirms.

See [`../docs/architecture.md`](../docs/architecture.md) for the settlement flow.
