// SPDX-License-Identifier: MIT

/**
 * Decimal-aware unit helpers for Perihelion intent amounts.
 *
 * Asset decimal conventions are defined in docs/assets.md. In short, listed
 * EVM stablecoin source assets use 6 decimals, ETH-like ERC-20 assets commonly
 * use 18 decimals, and Stellar destination assets use 7 decimals.
 *
 * Use these helpers to convert human-readable amounts ("1.5") to/from the
 * smallest-unit decimal strings required by {@link Intent} fields, so callers
 * never need to reason about the 6↔7 decimal gap manually.
 *
 * @example
 * // 1 USDC on Base (6dp) → "1000000"
 * toSmallestUnits("1", 6)
 * // 0.99 USDC on Stellar (7dp) → "9900000"
 * toSmallestUnits("0.99", 7)
 */

/** Upper bound on `decimals`, generous for any real asset but small enough to rule out unbounded BigInt exponentiation. */
const MAX_DECIMALS = 36;

/** Reject a `decimals` argument that is not a small non-negative integer. */
function assertValidDecimals(decimals: number, fn: string): void {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > MAX_DECIMALS) {
    throw new Error(
      `${fn}: decimals must be an integer between 0 and ${MAX_DECIMALS}, got ${decimals}`,
    );
  }
}

/**
 * Convert a human-readable amount string to its smallest-unit integer string.
 *
 * @param human    Decimal amount, e.g. `"1.5"` or `"100"`.
 * @param decimals Number of decimal places for the asset (e.g. 6 for EVM USDC, 7 for Stellar USDC).
 * @returns Smallest-unit amount as a decimal string, e.g. `"1500000"`.
 * @throws If `human` is not a valid non-negative decimal number, or `decimals` is not an integer in `[0, 36]`.
 */
export function toSmallestUnits(human: string, decimals: number): string {
  assertValidDecimals(decimals, "toSmallestUnits");
  if (!/^\d+(\.\d+)?$/.test(human.trim())) {
    throw new Error(`toSmallestUnits: invalid amount "${human}"`);
  }
  const parts = human.trim().split(".");
  const whole = parts[0] ?? "0";
  const frac = parts[1] ?? "";
  if (frac.length > decimals) {
    throw new Error(
      `toSmallestUnits: "${human}" has more than ${decimals} decimal places`,
    );
  }
  const padded = frac.padEnd(decimals, "0");
  const raw = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(padded || "0");
  return raw.toString();
}

/**
 * Convert a smallest-unit integer string back to a human-readable decimal.
 *
 * @param smallest Smallest-unit amount string, e.g. `"1500000"`.
 * @param decimals Number of decimal places for the asset.
 * @returns Human-readable string, e.g. `"1.5"`.
 * @throws If `decimals` is not an integer in `[0, 36]`.
 */
export function fromSmallestUnits(smallest: string, decimals: number): string {
  assertValidDecimals(decimals, "fromSmallestUnits");
  const n = BigInt(smallest);
  const factor = 10n ** BigInt(decimals);
  const whole = n / factor;
  const frac = (n % factor).toString().padStart(decimals, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}
