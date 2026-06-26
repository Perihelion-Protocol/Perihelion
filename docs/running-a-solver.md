# Running a Solver — Operator Runbook

This document walks a new operator through setting up and running a **Perihelion solver node**. The reference solver implementation lives in [`solver/`](../solver/).

## Table of Contents

- [Prerequisites](#prerequisites)
- [Environment Setup](#environment-setup)
- [Configuration](#configuration)
- [Starting the Solver](#starting-the-solver)
- [Monitoring](#monitoring)
- [Troubleshooting](#troubleshooting)

## Prerequisites

- **Node.js** ≥ 20 (for the solver, SDK, and mempool client)
- **A Stellar account** with sufficient XLM for transaction fees and locking liquidity on Stellar
- **An EVM account** (private key) with sufficient balance on the source chain (e.g., Base, Ethereum) to participate in the escrow
- **RPC endpoints**:
  - Soroban RPC URL (e.g., `https://soroban-testnet.stellar.org`)
  - EVM RPC URL (e.g., Base, Arbitrum; any chain the escrow is deployed on)
- **Perihelion mempool** URL (e.g., `http://localhost:8080` for local testnet, or a remote instance)
- **Deployed contracts**:
  - EVM escrow contract address and ABI (Solidity-based)
  - Soroban settlement contract ID (on Stellar)

## Environment Setup

### 1. Clone the repository and install dependencies

```bash
git clone https://github.com/Perihelion-Protocol/perihelion.git
cd perihelion

npm install
npm run build
```

### 2. Generate or import accounts

**Stellar account (keypair for fill_intent signature):**
Generate a new keypair or use an existing one:
```bash
# Generate new keypair (save the secret key securely)
npm --prefix sdk exec -- soroban keys generate solver

# Or import an existing key
export PERIHELION_SOROBAN_SECRET_KEY=S...
```

**EVM account (private key for source chain lock signature):**
Export your EVM private key as a hex string:
```bash
# For testnet, use your MetaMask or wallet seed phrase derivation
# Store securely in environment or secrets manager
export PERIHELION_EVM_PRIVATE_KEY=0x...
```

### 3. Fund accounts

**Stellar account:**
- Obtain testnet XLM from the [Stellar Friendbot](https://developers.stellar.org/docs/tools/stellar-cli) or a faucet
- On mainnet, acquire XLM through an exchange

**EVM account:**
- Bridge or acquire the source chain asset (USDC, ETH, etc.)
- Obtain testnet gas (e.g., Base Sepolia ETH from a faucet)

## Configuration

Create a `.env` file in the `solver/` directory by copying and editing `.env.example`:

```bash
cp solver/.env.example solver/.env
# Edit solver/.env with your values
```

### Key Configuration Parameters

| Parameter | Example | Notes |
|-----------|---------|-------|
| `PERIHELION_MEMPOOL_URL` | `http://localhost:8080` | Mempool API endpoint (local or remote) |
| `PERIHELION_SOLVER_ADDRESS` | `0x1234...` | Your EVM address (for preferredSolver reserves) |
| `PERIHELION_MIN_MARGIN_BPS` | `15` | Minimum profit margin in basis points (15 bps = 0.15%) |
| `PERIHELION_POLL_INTERVAL_MS` | `2000` | Mempool poll interval in milliseconds |
| `PERIHELION_SUPPORTED_ASSETS` | `native,USDC:GA5Z...` | Comma-separated assets you provide liquidity for |
| `PERIHELION_EVM_RPC_URL` | `https://base-mainnet.g.alchemy.com/v2/...` | EVM chain RPC endpoint |
| `PERIHELION_SOROBAN_RPC_URL` | `https://soroban-testnet.stellar.org` | Soroban RPC endpoint |
| `PERIHELION_EVM_PRIVATE_KEY` | `0x...` | EVM private key (keep secure) |
| `PERIHELION_SOROBAN_SECRET_KEY` | `S...` | Stellar secret key (keep secure) |
| `PERIHELION_ESCROW_ADDRESS` | `0x5678...` | Deployed escrow contract address |
| `PERIHELION_SETTLEMENT_CONTRACT_ID` | `ABC123...` | Soroban settlement contract ID |
| `PERIHELION_SOURCE_CHAIN_ID` | `8453` | LayerZero EID of the source chain |

### Customization Points

For production use, you likely need to customize:

1. **`quote.ts:priceDestAsset()`** — Replace the stub 1:1 pricing with real routing logic:
   - Query SDEX for XLM/asset trading pairs
   - Integrate external DEX pricing (e.g., CoinGecko, Uniswap, 1inch)
   - Account for your own inventory levels and risk

2. **Executor configuration** — Wire real settlement legs:
   - Ensure your EVM account can sign transactions on the source chain
   - Verify Stellar keypair has funds for transaction fees
   - Test the integration against a testnet first (see [Deployment & Operations](./deployment.md))

## Starting the Solver

### Development mode (with auto-reload)

```bash
cd solver
npm run dev
```

### Production mode

```bash
cd solver
npm run build
npm start
```

### Expected startup output

```
Perihelion Solver v0.1.0
Connected to mempool: http://localhost:8080
Solver address: 0x123...
Supported assets: native, USDC:GA5Z...
Min margin: 15 bps
Poll interval: 2000 ms
Starting solver loop...
```

## Monitoring

### Key Metrics to Track

1. **Intent poll frequency** — Normally every 2 seconds (or your `POLL_INTERVAL_MS`)
   - If this slows down, check mempool connectivity and RPC latency

2. **Fill success rate** — Track fills vs. considers:
   - High rejection rate → repricing logic issue, or insufficient margin
   - Low fill rate → margins too aggressive, or competing solvers faster

3. **Balance monitoring** — Watch fee drain and liquidity:
   - Monitor your Stellar asset holdings for depletion
   - Monitor EVM chain gas costs and escrow balance
   - Alert if balance drops below a threshold

4. **Latency** — Time from intent registration to fill:
   - Measure end-to-end settlement time (ideally < 30 seconds for single corridor)
   - Monitor RPC response times to both chains

### Logs to watch

The solver logs to `stdout`. Look for:

```
[2026-06-25T16:35:00Z] Evaluating intent hash=0x123... margin=50 bps [PROFITABLE]
[2026-06-25T16:35:01Z] Filled intent hash=0x123... amount=1000000
[2026-06-25T16:35:02Z] Confirmed on source chain, solver repaid
[2026-06-25T16:35:03Z] ERROR: InsufficientLiquidity for USDC
```

### External monitoring

Set up alerts for:
- **Process crash** — solver exits unexpectedly
- **Connection loss** — mempool unreachable, RPC timeout
- **Fill failure** — transaction reverts on either chain
- **Low balance** — Stellar or EVM account balance below threshold

## Troubleshooting

### Solver won't start

**Error: `Cannot find module 'dotenv'`**
```bash
npm install
npm run build
```

**Error: `ECONNREFUSED` (mempool/RPC)**
- Verify `PERIHELION_MEMPOOL_URL`, `PERIHELION_EVM_RPC_URL`, `PERIHELION_SOROBAN_RPC_URL` are reachable
- Check firewall, proxy, or VPN settings
- Try pinging the endpoints:
  ```bash
  curl http://localhost:8080/status
  ```

### Intents not being filled

**Solver sees intents but rejects them**
1. Check `PERIHELION_MIN_MARGIN_BPS` — too high?
   - Lower to 10–15 bps if margins are thin
2. Check `priceDestAsset()` — returning valid quote?
   - Add debug logging to see quoted price vs. intent slippage
3. Check `PERIHELION_SUPPORTED_ASSETS` — intent asset included?
   - Ensure format matches: `native` or `CODE:ISSUER`

**Solver sees no intents**
1. Verify mempool is running and populated
   - Check `/intents` endpoint: `curl http://localhost:8080/intents`
2. Check `PERIHELION_SOLVER_ADDRESS` — is it reserved by any intents?
   - If solver address not set or wrong, only open intents will be visible
3. Check deadline — intent must not be expired
   - Solver rejects intents with `deadline < now`

### Transactions fail on settlement

**"Insufficient fill amount"**
- Your quoted price dropped between quote and fill
- Check slippage tolerance; consider tighter pricing or pre-reserving liquidity

**"Intent not found" on Soroban**
- Intent was cancelled or expired before you called `fill_intent`
- Increase timeout or lower `PERIHELION_MIN_MARGIN_BPS` to compete faster

**"EVM transaction reverted"**
- Check escrow balance and allowances
- Verify EVM contract is not paused
- Check RPC is synced and not returning stale data

### High gas costs or slow fills

**EVM gas too expensive**
- Reduce frequency: increase `PERIHELION_POLL_INTERVAL_MS`
- Batch operations: consider multi-intent settlements (Phase 2)

**Slow fill times**
- Check RPC latency: time a simple `eth_blockNumber` call
- Consider a faster or local RPC endpoint
- Check Stellar ledger close times (normally ~5 seconds)

### Reputation not updating (Phase 3)

If you expect solver reputation tracking (Phase 3+):
- Ensure `dispatch_confirmation` is called after `deliver_intent`
- Wait for confirmation message to settle (LayerZero transport delay)

## Performance Tips

1. **Pre-fetch quotes** — Batch asset pricing to reduce latency
2. **Keep liquidity warm** — Hold small reserves of supported assets to respond faster
3. **Optimize RPC** — Use high-uptime, low-latency endpoints (Alchemy, Infura, etc.)
4. **Monitor competition** — Track other solvers' fill rates and adjust your margin strategy
5. **Test locally first** — Always validate on testnet before mainnet

## See Also

- [Deployment & Operations](./deployment.md) — Production setup with multisig and timelock
- [Architecture Overview](./architecture.md) — High-level flow
- [Technical Architecture](./TECHNICAL-ARCHITECTURE.md) — Detailed specs (§5.4 solver economics, §7.4 operations)
- [Solver Reference Code](../solver/README.md) — Implementation details
