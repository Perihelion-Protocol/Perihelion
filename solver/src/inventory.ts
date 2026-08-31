// SPDX-License-Identifier: MIT

/**
 * Inventory management for the reference solver.
 *
 * Before committing to a fill the solver must confirm it holds enough of the
 * destination asset and that in-flight commitments won't over-commit that
 * balance. This module defines the injectable InventoryProvider interface and
 * a simple in-memory tracker for in-flight fills.
 */

/** Available balance for a single asset (in that asset's smallest units). */
export interface InventoryProvider {
  /**
   * Return the spendable balance for `asset` in smallest units.
   * `asset` uses the Stellar format "CODE:ISSUER" (e.g. "USDC:GA5Z...").
   */
  availableBalance(asset: string): Promise<bigint>;
  /**
   * Native token balance on the source (EVM) chain, in wei. A fill's payable
   * `PerihelionEscrow.lock` must cover the LayerZero message fee plus the gas
   * to pull the user's tokens and dispatch the cross-chain message; that spend
   * is not drawn from any `destAsset` balance. Optional — when absent,
   * {@link evaluate} skips the source-native funding check.
   */
  nativeBalanceSource?(): Promise<bigint>;
  /**
   * Native XLM balance on Stellar, in stroops. `deliver_intent` and
   * `dispatch_confirmation` both need a funded source account, and
   * `dispatch_confirmation` takes an `lz_fee` the caller supplies. Optional —
   * when absent, {@link evaluate} skips the Stellar-native funding check.
   */
  nativeBalanceDest?(): Promise<bigint>;
}

/** Tracks fill commitments that are in-flight so we don't over-commit. */
export class InFlightTracker {
  private readonly reserved = new Map<string, bigint>();

  /**
   * Post-fill holds: reservations that a *successful* fill has moved here so
   * they are not released until the next tick's `flushHeld()` call.  This
   * keeps the inventory reservation alive across the gap between a fill
   * completing and the balance provider refreshing its cached read.
   *
   * A successful fill spends the capital immediately on-chain, but the
   * InventoryProvider may still report the pre-spend balance for some time
   * (depending on its polling interval).  Keeping the reservation in the
   * `held` bucket during that window prevents a subsequent `evaluate()` call
   * from treating the already-committed capital as still available.
   */
  private readonly held = new Map<string, bigint>();

  /** Reserve `amount` units of `asset` for an in-flight fill. */
  reserve(asset: string, amount: bigint): void {
    this.reserved.set(asset, (this.reserved.get(asset) ?? 0n) + amount);
  }

  /** Release a previously reserved amount (call after a *definite* fill failure). */
  release(asset: string, amount: bigint): void {
    const current = this.reserved.get(asset) ?? 0n;
    const next = current > amount ? current - amount : 0n;
    if (next === 0n) {
      this.reserved.delete(asset);
    } else {
      this.reserved.set(asset, next);
    }
  }

  /**
   * Move a reservation to the `held` bucket after a successful fill.
   *
   * The reservation is *not* released immediately — it survives until the next
   * tick calls {@link flushHeld}, by which point the inventory provider has had
   * at least one full tick to refresh its cached balance.  This prevents the
   * window between a successful fill and the provider reflecting the spend from
   * being exploited by a second intent claiming the same capital.
   *
   * Call this instead of {@link release} when `executor.fill()` resolves
   * successfully.
   */
  holdForRefresh(asset: string, amount: bigint): void {
    // Remove from the active reservation bucket.
    this.release(asset, amount);
    // Park in held until the next tick's flushHeld() drains it.
    this.held.set(asset, (this.held.get(asset) ?? 0n) + amount);
  }

  /**
   * Drain all held amounts back to zero.
   *
   * Call this at the **start** of each {@link Solver.tick} so that reservations
   * for fills that completed in the previous tick are cleared before the new
   * round of `evaluate()` calls.  By the start of the next tick the inventory
   * provider will have had a full polling interval to refresh, so releasing here
   * is safe.
   *
   * @returns The number of assets whose held amounts were flushed.
   */
  flushHeld(): number {
    const count = this.held.size;
    this.held.clear();
    return count;
  }

  /**
   * Total amount currently committed for `asset` — both the active reservation
   * bucket and the post-fill held bucket.  `evaluate()` must subtract this from
   * the provider's reported balance before deciding whether a fill is feasible.
   */
  reservedFor(asset: string): bigint {
    return (this.reserved.get(asset) ?? 0n) + (this.held.get(asset) ?? 0n);
  }
}

/** A no-op provider that always reports infinite balance (for testing / stub use). */
export class UnlimitedInventoryProvider implements InventoryProvider {
  async availableBalance(_asset: string): Promise<bigint> {
    return BigInt(Number.MAX_SAFE_INTEGER);
  }

  async nativeBalanceSource(): Promise<bigint> {
    return BigInt(Number.MAX_SAFE_INTEGER);
  }

  async nativeBalanceDest(): Promise<bigint> {
    return BigInt(Number.MAX_SAFE_INTEGER);
  }
}
