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
- Calls `escrowClient.isRefundable(hash)` to check from chain state whether `cancelExpired` would succeed. The mempool-based `client.isRefundable(record, graceSeconds)` (deprecated) is only a hint: mempool statuses are best-effort and can be wrong or stale.
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

| Function | Path | Payer | Cost |
|----------|------|-------|------|
| `lock` (EVM) | Primary | Solver | Gas + LayerZero fee |
| `fill_intent` (Soroban) | Primary | Solver | Stellar network fee |
| `dispatch_confirmation` (Soroban) | Primary | Relayer/SDK | LayerZero fee |
| `cancelExpired` (EVM) | Fallback | User / Keeper | Gas (~100k units) |
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

| Scenario | EVM Refund | Soroban Refund | Overall |
|----------|-----------|----------------|---------|
| User monitors, calls `cancelExpired` | **Guaranteed** | **Guaranteed** (if keeper calls it) | ✅ User's funds safe if they act |
| Keeper with incentive watches | Best-effort | **Guaranteed** | ✅ Strong if keeper incentive is set |
| Keeper without incentive | Best-effort | Best-effort | ⚠️ Weak — rely on user or luck |
| No monitoring (user offline) | ❌ Stuck | ❌ Stuck | ❌ Funds lost after grace expires |

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
     timeoutMs: (deadline + confirmationGrace - now) * 1_000
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
   `client.isRefundable(record, confirmationGraceSeconds)` (deprecated) reads only the mempool record. Use it at most as a cheap pre-filter, never as the decision to call `cancelExpired`.

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

## Architecture Links

- **Threat model**: `docs/threat-model.md` (section on liveness assumptions)
- **Intent lifecycle**: `docs/TECHNICAL-ARCHITECTURE.md` §2 (state machine & edge cases)
- **Technical architecture**: `docs/TECHNICAL-ARCHITECTURE.md` (idempotency & reentrancy invariants)
- **EVM contract**: `contracts/evm/src/PerihelionEscrow.sol` (NatSpec on `cancelExpired`)
- **Soroban contract**: `contracts/soroban/settlement/src/lib.rs` (NatSpec on `cancel_expired_intent`, `set_keeper_reward`)
- **SDK**: `sdk/src/escrow-client.ts` (methods: `isRefundable`, `refundStatus`, `cancelExpired`); `sdk/src/client.ts` (methods: `waitForSettlement`, mempool-hint `isRefundable`)
