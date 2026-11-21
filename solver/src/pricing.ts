// SPDX-License-Identifier: MIT

/**
 * Operator-supplied pricing for the reference solver.
 *
 * The solver prices fills with a static corridor rate table, read from
 * `PERIHELION_PRICE_RATES`. Each entry is `SOURCE>DEST=RATE`, where RATE is how
 * many destination-asset human units one source-asset human unit is worth, as
 * a positive decimal with at most 18 fractional digits. Entries are separated
 * by commas, for example:
 *
 *   PERIHELION_PRICE_RATES=0xA0b8...>USDC:GA5Z...=1,native>USDC:GA5Z...=0.1234
 *
 * Rates are kept as exact integers scaled by {@link RATE_SCALE}; no floating
 * point is involved. A corridor with no configured rate is refused at quote
 * time, so an operator cannot silently fill at par.
 */

import { RATE_SCALE, type PriceOracle } from "./quote.js";

export const PRICE_RATES_ENV = "PERIHELION_PRICE_RATES";

const RATE_PATTERN = /^(\d+)(?:\.(\d{1,18}))?$/;

/** Canonical key for a corridor in the rate table. */
export function corridorKey(sourceAsset: string, destAsset: string): string {
  return `${sourceAsset}>${destAsset}`;
}

/**
 * Parse a `PERIHELION_PRICE_RATES` value into a map of corridor → scaled rate.
 * Throws a descriptive error listing every malformed entry.
 */
export function parseRateTable(raw: string): Map<string, bigint> {
  const table = new Map<string, bigint>();
  const errors: string[] = [];

  for (const entry of raw.split(",")) {
    const trimmed = entry.trim();
    if (trimmed === "") continue;

    const eq = trimmed.lastIndexOf("=");
    const corridor = eq === -1 ? "" : trimmed.slice(0, eq).trim();
    const rate = eq === -1 ? "" : trimmed.slice(eq + 1).trim();
    const sep = corridor.indexOf(">");
    const source = sep === -1 ? "" : corridor.slice(0, sep).trim();
    const dest = sep === -1 ? "" : corridor.slice(sep + 1).trim();

    if (!source || !dest || sep !== corridor.lastIndexOf(">")) {
      errors.push(`"${trimmed}" must be SOURCE>DEST=RATE`);
      continue;
    }

    const match = RATE_PATTERN.exec(rate);
    if (!match) {
      errors.push(`"${trimmed}" has an invalid rate "${rate}"; use a positive decimal`);
      continue;
    }
    const fraction = (match[2] ?? "").padEnd(18, "0");
    const scaled = BigInt(match[1]!) * RATE_SCALE + BigInt(fraction);
    if (scaled <= 0n) {
      errors.push(`"${trimmed}" has a non-positive rate`);
      continue;
    }

    const key = corridorKey(source, dest);
    if (table.has(key)) {
      errors.push(`corridor ${source} -> ${dest} is configured more than once`);
      continue;
    }
    table.set(key, scaled);
  }

  if (errors.length > 0) {
    throw new Error(`${PRICE_RATES_ENV} is invalid:\n  • ${errors.join("\n  • ")}`);
  }
  return table;
}

/** A {@link PriceOracle} that answers only for corridors in the table. */
export function staticPriceOracle(table: ReadonlyMap<string, bigint>): PriceOracle {
  return async (sourceAsset: string, destAsset: string): Promise<bigint> => {
    const rate = table.get(corridorKey(sourceAsset, destAsset));
    if (rate === undefined) {
      throw new Error(
        `no configured rate for corridor ${sourceAsset} -> ${destAsset} (set ${PRICE_RATES_ENV})`,
      );
    }
    return rate;
  };
}

/**
 * Build the price oracle from `env`. Returns `undefined` when the variable is
 * unset or blank, so callers decide whether pricing is required.
 */
export function priceOracleFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): PriceOracle | undefined {
  const raw = (env[PRICE_RATES_ENV] ?? "").trim();
  if (raw === "") return undefined;
  return staticPriceOracle(parseRateTable(raw));
}
