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
}

/** Tracks fill commitments that are in-flight so we don't over-commit. */
export class InFlightTracker {
  private readonly reserved = new Map<string, bigint>();

  /** Reserve `amount` units of `asset` for an in-flight fill. */
  reserve(asset: string, amount: bigint): void {
    this.reserved.set(asset, (this.reserved.get(asset) ?? 0n) + amount);
  }

  /** Release a previously reserved amount (call after fill settles or fails). */
  release(asset: string, amount: bigint): void {
    const current = this.reserved.get(asset) ?? 0n;
    const next = current > amount ? current - amount : 0n;
    if (next === 0n) {
      this.reserved.delete(asset);
    } else {
      this.reserved.set(asset, next);
    }
  }

  /** Total amount currently reserved for `asset`. */
  reservedFor(asset: string): bigint {
    return this.reserved.get(asset) ?? 0n;
  }
}

/** A no-op provider that always reports infinite balance (for testing / stub use). */
export class UnlimitedInventoryProvider implements InventoryProvider {
  async availableBalance(_asset: string): Promise<bigint> {
    return BigInt(Number.MAX_SAFE_INTEGER);
  }
}
