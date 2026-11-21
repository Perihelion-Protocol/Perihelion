# Keeper Model and Refund Liveness

## Overview

The Perihelion protocol bridges assets across chains. On both endpoints (Soroban and EVM), expired intents may need to be refunded if the settlement process fails. This document explains who calls the refund functions, how they are incentivized, and what liveness guarantees the protocol provides.

## Two Refund Paths

### Path 1: Cross-Chain Refund (Primary)

1. User locks funds on EVM via `lock(intent, signature)`.
2. FillInstruction is sent to Soroban.
3. Solver fills on Soroban via `fill_intent`, triggering FillConfirmed back to EVM.
4. EVM escrow receives FillConfirmed and releases funds to the solver.

If the settlement succeeds, no refund is needed.

### Path 2: Local Timeout Fallback (Last Resort)

If FillConfirmed never arrives at the EVM escrow:

1. User (or keeper) calls `cancelExpired(intentHash)` on EVM after `deadline + confirmationGrace`.
2. Escrow refunds user's locked funds locally.

If the Stellar-side settlement also fails:

1. User (or keeper) calls `cancel_expired_intent(caller, hash, lz_fee)` on Soroban.
   - **Note**: `lz_fee` must be quoted using `quote_cancel_fee(dst_eid)`. Quoting with an empty payload returns a lower bound that will under-fund the dispatch and cause the cancellation to fail.
2. Stellar settlement sends CancelIntent back to EVM (may race with step 1 above).
3. Both paths converge on a refunded state via idempotency markers.

## Keeper Model

### EVM: `cancelExpired` (issue #175)

**Expected caller**: The user, via the SDK's `waitForSettlement` status query and the on-chain `PerihelionEscrowClient.isRefundable` check.

**Incentive**: None. The user is refunding their own funds, so self-interest is the motivation.

**Liveness guarantee**:

- **Strong**: Exactly one refund path must succeed for the user to recover funds.
- **User-dependent**: Liveness is only guaranteed if the user (or an SDK integration on their behalf) calls `cancelExpired`. The protocol does not monitor or enforce this.

**Operational model**:

- Best practice: Frontend/SDK detects an expired, unrefunded intent via `waitForSettlement` timeout or `record.status === "expired"`.
- Calls `escrowClient.isRefundable(hash)` to check from chain state whether `cancelExpired` would succeed. The mempool-based `client.isRefundable(record, graceMs)` is only a hint: mempool statuses are best-effort and can be wrong or stale.
- Presents a "recover funds" button to the user.
- User clicks to call `escrow.cancelExpired(hash)` (gas cost ~100k units, paid by user).
- Funds are refunded to `l.user`.

**Fallback (keeper, optional)**:

- If the user is offline or unreachable, a keeper can monitor the chain for expired intents and call `cancelExpired` on the user's behalf as a service.
- The keeper pays gas; there is no protocol reward.
- This is best-effort only — do NOT rely on keepers for guaranteed liveness.

### Soroban: `cancel_expired_intent` (issue #173)

**Expected caller**: Anyone (permissionless). Can be the user (self-serve) or a keeper (third-party).

**Incentive**: Optional keeper reward (configurable via `set_keeper_reward`).

- When `keeper_reward > 0`, the contract pays the caller (in stroops) after the cancellation succeeds.
- This compensates the caller for LayerZero fee + operational cost.
- Enables "fire and forget" keeper infrastructure without per-intent monitoring.

**Liveness guarantee**:

- **Conditional**: Liveness is guaranteed only if a keeper incentive exists (i.e., `keeper_reward > 0`).
- **With incentive**: Rational keepers will monitor expired intents and call `cancel_expired_intent` to earn the reward.
- **Without incentive**: Defaults to user self-serve (same as EVM) or best-effort keeper monitoring.

**Operational model**:

1. **Admin setup** (at deployment):

   ```
   set_keeper_reward(keeper_reward_stroops)  // e.g., 1_000_000 stroops (~0.1 XLM)
   ```

   The reward should cover LayerZero fee + keeper operational cost (empirically determined).

2. **Keeper monitoring**:
   - Keeper listens for FillInstruction events on Soroban.
   - If no FillConfirmed is received within `deadline + grace`, calls `cancel_expired_intent`.
   - Receives the keeper reward as compensation.

3. **User self-serve** (if no keeper, or for redundancy):
   - User monitors their own intents via the SDK.
   - If an intent expires, calls `cancel_expired_intent` directly.
   - No reward, but their funds are refunded.

## Trust and Economic Model

### Who Pays?

| Function                          | Path     | Payer         | Cost                                |
| --------------------------------- | -------- | ------------- | ----------------------------------- |
| `lock` (EVM)                      | Primary  | Solver        | Gas + LayerZero fee                 |
| `fill_intent` (Soroban)           | Primary  | Solver        | Stellar network fee                 |
| `dispatch_confirmation` (Soroban) | Primary  | Relayer/SDK   | LayerZero fee                       |
| `cancelExpired` (EVM)             | Fallback | User / Keeper | Gas (~100k units)                   |
| `cancel_expired_intent` (Soroban) | Fallback | Keeper / User | Stellar network fee + LayerZero fee |

**Key insight**: The EVM fallback is cheaper (local refund, no cross-chain messaging). The Soroban fallback is expensive (must send CancelIntent back to EVM). Operators should ensure the keeper reward on Soroban justifies this cost.

### Who Funds the Keeper Reward?

The keeper reward is paid from the Soroban settlement contract's native (XLM) balance. Typical funding strategies:

1. **Protocol reserve**: Admin pre-deposits XLM via Stellar's native transfer, building a reserve pool.
2. **User-prepaid tips**: Each FillInstruction carries an optional `keeper_tip` (future extension) prepaid by the user.
3. **Hybrid**: Small protocol reserve + optional user tips.

The two keeper paths treat an underfunded reserve differently. Operators must monitor reserves and top up as needed.

- **`cancel_expired_intent`**: the reward is a token transfer in the same invocation as the cancellation. If the reserve cannot cover it, the whole call reverts, so the cancellation is rolled back too and the keeper must retry after a top-up.
- **`dispatch_confirmation`** (issue #913): the reward is paid only when the reserve covers `DispatchKeeperReward`. When it does not, the FillConfirmed dispatch and the `ConfirmationSent` marker still go through, and a `keeper_reward_skipped` event is emitted. The reserve is therefore not needed for the solver to be repaid on the source chain, but the keeper goes unpaid until the reserve is topped up.

## Refund Liveness Summary

| Scenario                             | EVM Refund     | Soroban Refund                      | Overall                              |
| ------------------------------------ | -------------- | ----------------------------------- | ------------------------------------ |
| User monitors, calls `cancelExpired` | **Guaranteed** | **Guaranteed** (if keeper calls it) | ✅ User's funds safe if they act     |
| Keeper with incentive watches        | Best-effort    | **Guaranteed**                      | ✅ Strong if keeper incentive is set |
| Keeper without incentive             | Best-effort    | Best-effort                         | ⚠️ Weak — rely on user or luck       |
| No monitoring (user offline)         | ❌ Stuck       | ❌ Stuck                            | ❌ Funds lost after grace expires    |

## Recommendations

### For Protocol Operators

1. **EVM**: Document and surface the `isRefundable` helper in frontends and SDKs. Users must know how to recover their own funds.
2. **Soroban**: Set a keeper reward that covers LayerZero fee + operational cost:
   ```
   set_keeper_reward(estimated_lz_fee + 100_000)  // Stroops
   ```
3. **Both**: Monitor intent expiry rates and keeper-call success rates. Alert if too many intents expire without recovery.

### For SDK / Frontend Integrators

1. **Poll for expiry**: After `lock`, use `waitForSettlement` with a timeout matching the grace period:

   ```ts
   const record = await client.waitForSettlement(hash, {
     timeoutMs: (deadline + confirmationGrace - now) * 1_000,
   });
   ```

2. **Detect refundable intents**: When settlement times out or returns `expired`, check the escrow itself:

   ```ts
   const status = await escrowClient.refundStatus(hash);
   if (status.refundable) {
     // Offer recovery button to user
   } else if (status.reason === "DeadlineNotPassed") {
     // Refundable from status.refundableAt (unix seconds)
   }
   ```

   `client.isRefundable(record, confirmationGraceMs)` reads only the mempool record. Use it at most as a cheap pre-filter, never as the decision to call `cancelExpired`.

3. **Provide recovery flow**:
   - Button: "Recover your funds"
   - Action: Calls `escrow.cancelExpired(hash)` (user pays gas)
   - Confirm: Polls until status === "refunded"

### For Keepers

1. **EVM**: Monitor on-chain for expired intents. Call `cancelExpired` for any `pending` intent past `deadline + grace`. No reward, so not recommended as a primary business.

2. **Soroban**:
   - Monitor FillInstruction events and their lifespans.
   - Call `cancel_expired_intent` for any expired intent past deadline.
   - Earn keeper reward (if configured).
   - Business model: reward covers LayerZero fee + margin.

3. **Coordination**: Multiple keepers can race to refund the same intent (first wins due to idempotency markers). Accept races as part of normal operation.

## Reference Keeper Implementation (Issue #1123)

Perihelion ships a reference keeper across `@perihelion/relayer`, `@perihelion/sdk`, and `@perihelion/solver` covering all three keeper entrypoints (`cancelExpired`, `cancel_expired_intent`, and `dispatch_confirmation`).

### 1. Relayer Keeper Mode (`PERIHELION_RELAYER_MODE=keeper`)

Run `@perihelion/relayer` in keeper mode (`relayer/src/keeper.ts`) by setting `PERIHELION_RELAYER_MODE=keeper`:

```bash
PERIHELION_RELAYER_MODE=keeper \
PERIHELION_EVM_RPC_URL=http://localhost:8545 \
PERIHELION_SOROBAN_RPC_URL=https://soroban-testnet.stellar.org \
PERIHELION_ESCROW_ADDRESS=0x... \
PERIHELION_SETTLEMENT_CONTRACT_ID=C... \
PERIHELION_SOURCE_EID=30101 \
PERIHELION_STELLAR_EID=40161 \
STELLAR_NETWORK="Test SDF Network ; September 2015" \
SIGNER_SECRET=S... \
PERIHELION_EVM_PRIVATE_KEY=0x... \
perihelion-relayer
```

On each polling tick (`Keeper.tick()`), the keeper performs three passes:

1. **EVM `Locked` Scan & `cancelExpired`**:
   - Scans EVM `Locked` (and terminal `Released` / `Refunded` / `RefundedLocalTimeout`) logs up to the confirmed head.
   - For any lock past `deadline + confirmationGrace`, verifies on-chain `refundStatus(intentHash).refundable`, evaluates the EVM gas/cost guard (`evaluateEvmCancelCostGuard`), and calls `cancelExpired(intentHash)`.
2. **Soroban `registered` Scan & `cancel_expired_intent`**:
   - Scans Soroban `registered` (and lifecycle) events for intents still in `Locked` status past `deadline`.
   - Quotes `quote_cancel_fee(src_eid)` plus `PERIHELION_KEEPER_LZ_FEE_BUFFER_STROOPS`, reads `keeper_reward()`, estimates the Soroban inclusion fee, evaluates `evaluateSorobanKeeperProfitability`, and submits `cancel_expired_intent(caller, intent_hash, lz_fee)`.
3. **Soroban `list_undispatched_intents` & `dispatch_confirmation`**:
   - Polls `list_undispatched_intents` in chunks of `MAX_LIST_BATCH = 100` to discover intents in `Filled` status (`Settled` marker set, `ConfirmationSent` marker absent).
   - Verifies the ledger timestamp has not passed `dispatchCutoff(deadline)` (`deadline + MIN_DISPATCH_WINDOW - CROSS_CHAIN_LATENCY_BUDGET`), checks whether `DISPATCH_REWARD_GRACE_LEDGERS` (`360` ledgers) has elapsed for third-party `dispatch_keeper_reward` eligibility, evaluates profitability, and submits `dispatch_confirmation(caller, intent_hash, lz_fee)`.

#### Keeper Configuration Variables

| Variable                                    | Default    | Description                                                                      |
| ------------------------------------------- | ---------- | -------------------------------------------------------------------------------- |
| `PERIHELION_RELAYER_MODE`                   | `dev`      | Set to `keeper` to run the reference keeper daemon                               |
| `PERIHELION_EVM_PRIVATE_KEY`                | (optional) | `0x`-prefixed 32-byte EVM key for submitting `cancelExpired`                     |
| `PERIHELION_KEEPER_DRY_RUN`                 | `false`    | When `true`, scans and logs candidate actions without sending transactions       |
| `PERIHELION_KEEPER_ENFORCE_PROFITABILITY`   | `true`     | Only submit Soroban actions when `reward >= lz_fee + inclusion_fee + min_profit` |
| `PERIHELION_KEEPER_MIN_PROFIT_STROOPS`      | `0`        | Minimum net profit in stroops required per Soroban action                        |
| `PERIHELION_KEEPER_MAX_GAS_PRICE_WEI`       | (unset)    | Maximum EVM gas price in wei allowed for `cancelExpired`                         |
| `PERIHELION_KEEPER_MAX_EVM_CANCEL_COST_WEI` | (unset)    | Maximum total native gas cost (`gas * gasPrice`) in wei per `cancelExpired`      |
| `PERIHELION_KEEPER_LZ_FEE_BUFFER_STROOPS`   | `0`        | Safety buffer in stroops added to quoted LayerZero fees on Soroban               |

#### Prometheus Metrics (`renderKeeperPrometheusMetrics`)

- `keeper_ticks_total`
- `keeper_evm_scans_total`
- `keeper_soroban_scans_total`
- `keeper_evm_cancelled_total`
- `keeper_soroban_cancelled_total`
- `keeper_confirmations_dispatched_total`
- `keeper_dry_run_actions_total`
- `keeper_skipped_unprofitable_total`
- `keeper_skipped_awaiting_grace_total`
- `keeper_skipped_expired_window_total`
- `keeper_failed_actions_total`
- `keeper_evm_gas_spent_wei`
- `keeper_soroban_fees_spent_stroops`
- `keeper_soroban_rewards_earned_stroops`
- `keeper_evm_cursor_block`
- `keeper_soroban_cursor_ledger`
- `keeper_last_tick_timestamp_seconds`

### 2. SDK Keeper & Recovery Helpers (`@perihelion/sdk`)

- **EVM Batch Discovery & Refund (`PerihelionEscrowClient` in `sdk/src/escrow-client.ts`)**:
  - `escrowClient.findExpiredLocks({ fromBlock, toBlock, user, solver, maxBlockRange })`: scans `Locked` logs in chunks and verifies on-chain refundability at a pinned block.
  - `escrowClient.cancelExpiredLocks({ fromBlock, user, dryRun, maxGasPriceWei, maxCancelCostWei })`: finds expired locks and calls `cancelExpired` for each lock passing dry-run and gas guards.
- **Soroban Settlement Keeper Client (`PerihelionSettlementClient` in `sdk/src/keeper.ts`)**:
  - Views: `status(hash)`, `getIntent(hash)`, `keeperReward()`, `dispatchKeeperReward()`, `quoteCancelFee(dstEid)`, `quoteFillConfirmedFee(dstEid)`, `listUndispatchedIntents(hashes)` (chunked by `MAX_LIST_BATCH = 100`), `scanIntentEvents(fromLedger, toLedger)`.
  - Writes: `cancelExpiredIntent(hash, lzFeeStroops?)`, `dispatchConfirmation(hash, lzFeeStroops?)` with automatic footprint restoration and inclusion fee escalation.
  - Pure evaluators: `dispatchCutoff(deadline)`, `evaluateSorobanKeeperProfitability(input)`, `evaluateEvmCancelCostGuard(input)`.

### 3. Solver Split-Path Confirmation Recovery (`@perihelion/solver`)

`Executor` (`solver/src/executor.ts`) exposes split-path delivery and confirmation-recovery methods so a solver (or recovery job) can separate token delivery from LayerZero confirmation dispatch:

- `executor.deliverIntent(signedIntent)`: invokes `deliver_intent(solver, solver_evm, intent_hash, fill_amount)`.
- `executor.dispatchConfirmation(intentHash, srcEid)`: quotes `quote_fill_confirmed_fee(srcEid)` (+ `lzFeeBufferStroops`) and invokes `dispatch_confirmation(caller, intent_hash, lz_fee)`.
- `executor.listUndispatchedIntents(intentHashes)`: queries `list_undispatched_intents` in batches of `MAX_LIST_BATCH = 100`.
- `executor.recoverUndispatchedConfirmations(candidates)`: filters `candidates` via `listUndispatchedIntents` and calls `dispatchConfirmation` for each stalled fill.

## Architecture Links

- **Threat model**: `docs/threat-model.md` (section on liveness assumptions)
- **Intent lifecycle**: `docs/TECHNICAL-ARCHITECTURE.md` §2 (state machine & edge cases)
- **Technical architecture**: `docs/TECHNICAL-ARCHITECTURE.md` (idempotency & reentrancy invariants)
- **EVM contract**: `contracts/evm/src/PerihelionEscrow.sol` (NatSpec on `cancelExpired`)
- **Soroban contract**: `contracts/soroban/settlement/src/lib.rs` (NatSpec on `cancel_expired_intent`, `dispatch_confirmation`, `list_undispatched_intents`, `set_keeper_reward`, `set_dispatch_keeper_reward`)
- **SDK**: `sdk/src/escrow-client.ts` (methods: `isRefundable`, `refundStatus`, `cancelExpired`, `findExpiredLocks`, `cancelExpiredLocks`); `sdk/src/keeper.ts` (`PerihelionSettlementClient`, `evaluateSorobanKeeperProfitability`, `evaluateEvmCancelCostGuard`); `sdk/src/client.ts` (methods: `waitForSettlement`, mempool-hint `isRefundable`)
- **Relayer Keeper**: `relayer/src/keeper.ts` (`Keeper`, `ViemEvmKeeperAdapter`, `StellarSorobanKeeperAdapter`, `renderKeeperPrometheusMetrics`)
- **Solver Recovery**: `solver/src/executor.ts` (`deliverIntent`, `dispatchConfirmation`, `listUndispatchedIntents`, `recoverUndispatchedConfirmations`)
