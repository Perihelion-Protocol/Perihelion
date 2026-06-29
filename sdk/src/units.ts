/**
 * Decimal-aware unit helpers for Perihelion intent amounts.
 *
 * Asset decimal conventions:
 *   - EVM source assets  (e.g. USDC on Base/Ethereum): 6 decimals
 *   - Stellar dest assets (e.g. USDC on Stellar):       7 decimals
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

/**
 * Convert a human-readable amount string to its smallest-unit integer string.
 *
 * @param human    Decimal amount, e.g. `"1.5"` or `"100"`.
 * @param decimals Number of decimal places for the asset (e.g. 6 for EVM USDC, 7 for Stellar USDC).
 * @returns Smallest-unit amount as a decimal string, e.g. `"1500000"`.
 * @throws If `human` is not a valid non-negative decimal number.
 */
export function toSmallestUnits(human: string, decimals: number): string {
  if (!/^\d+(\.\d+)?$/.test(human.trim())) {
    throw new Error(`toSmallestUnits: invalid amount "${human}"`);
  }
  const [whole, frac = ""] = human.trim().split(".");
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
 */
export function fromSmallestUnits(smallest: string, decimals: number): string {
  const n = BigInt(smallest);
  const factor = 10n ** BigInt(decimals);
  const whole = n / factor;
  const frac = (n % factor).toString().padStart(decimals, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}
