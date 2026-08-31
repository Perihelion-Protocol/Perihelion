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
 * Accepts an optional leading `-` for negative deltas (e.g. refund/adjustment
 * amounts); the sign is handled explicitly rather than left to `BigInt`'s `%`,
 * which retains the sign of the dividend and would otherwise produce a
 * malformed result like `fromSmallestUnits("-1500000", 6)` -> `"1.-5"` (issue #533).
 *
 * @param smallest Smallest-unit amount string, e.g. `"1500000"` or `"-1500000"`.
 * @param decimals Number of decimal places for the asset.
 * @returns Human-readable string, e.g. `"1.5"` or `"-1.5"`.
 * @throws If `smallest` is not a valid (optionally negative) integer string,
 *   or `decimals` is not an integer in `[0, 36]`.
 */
export function fromSmallestUnits(smallest: string, decimals: number): string {
  assertValidDecimals(decimals, "fromSmallestUnits");
  const trimmed = smallest.trim();
  if (!/^-?\d+$/.test(trimmed)) {
    throw new Error(`fromSmallestUnits: invalid amount "${smallest}"`);
  }
  const negative = trimmed.startsWith("-");
  const abs = negative ? BigInt(trimmed.slice(1)) : BigInt(trimmed);
  const factor = 10n ** BigInt(decimals);
  const whole = abs / factor;
  const frac = (abs % factor).toString().padStart(decimals, "0").replace(/0+$/, "");
  // Only prepend the sign if the magnitude is actually nonzero — avoids "-0".
  const sign = negative && (whole !== 0n || frac !== "") ? "-" : "";
  return frac ? `${sign}${whole}.${frac}` : `${sign}${whole}`;
}
