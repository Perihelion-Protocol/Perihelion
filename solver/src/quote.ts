/**
 * Profitability evaluation for the reference solver.
 *
 * A real solver sources live quotes from Stellar's SDEX, external DEXs, and its
 * own inventory. This module defines the decision interface and ships a simple
 * margin-based default so the node is runnable end-to-end; replace
 * {@link priceDestAsset} with real liquidity routing.
 */

import { isExpired, toSmallestUnits, fromSmallestUnits } from "@perihelion/sdk";
import type { Intent } from "@perihelion/sdk";
import type { SolverConfig } from "./config.js";

export interface FillDecision {
  readonly fill: boolean;
  readonly reason: string;
  /** Estimated margin in basis points of the source amount, when computed. */
  readonly marginBps?: number;
}

/**
 * Price how much `destAsset` the solver can deliver for `sourceAmount` of
 * `sourceAsset`, in `destAsset` smallest units.
 *
 * This is a basic implementation: assumes a 1:1 corridor and normalizes for the common
 * decimal gap (EVM stablecoins 6dp → Stellar assets 7dp). In production, override with real
 * routing against SDEX, Stellar DEX aggregators, or external liquidity venues.
 *
 * For now, it queries a fixed oracle rate. A real implementation would integrate with:
 * - Stellar DEX (SDEX) for spot prices
 * - RedStone Oracle (SEP-40 compliant)
 * - External DEX aggregators
 */
// Decimal places for corridor assets.
// EVM stablecoins (USDC, EURC, …) use 6dp; Stellar assets use 7dp.
const SOURCE_DECIMALS = 6;
const DEST_DECIMALS = 7;

export async function priceDestAsset(intent: Intent): Promise<bigint> {
  // Convert source smallest-units → human → dest smallest-units for 1:1 rate.
  // This centralises the 6↔7 decimal corridor rather than baking in * 10n.
  const humanAmount = fromSmallestUnits(intent.sourceAmount, SOURCE_DECIMALS);
  return BigInt(toSmallestUnits(humanAmount, DEST_DECIMALS));

  // In production, fetch live quotes from an oracle or DEX:
  // const rate = await fetchStellarDexRate(intent.sourceAsset, intent.destAsset);
}

/** Decide whether to fill an intent given current config and pricing. */
export async function evaluate(
  intent: Intent,
  config: SolverConfig,
): Promise<FillDecision> {
  if (isExpired(intent)) {
    return { fill: false, reason: "intent expired" };
  }
  if (!config.supportedDestAssets.includes(intent.destAsset)) {
    return { fill: false, reason: `unsupported dest asset ${intent.destAsset}` };
  }
  if (
    intent.preferredSolver !== "0x0000000000000000000000000000000000000000" &&
    intent.preferredSolver.toLowerCase() !== config.solverAddress.toLowerCase()
  ) {
    return { fill: false, reason: "reserved for another solver" };
  }

  const deliverable = await priceDestAsset(intent);
  const minOut = BigInt(intent.minDestAmount);
  if (deliverable < minOut) {
    return { fill: false, reason: "cannot meet minDestAmount" };
  }

  // Margin = (what we can source - what we must deliver) / what we deliver.
  const marginBps = Number(((deliverable - minOut) * 10_000n) / minOut);
  if (marginBps < config.minMarginBps) {
    return { fill: false, reason: `margin ${marginBps}bps below threshold`, marginBps };
  }
  return { fill: true, reason: "profitable", marginBps };
}
