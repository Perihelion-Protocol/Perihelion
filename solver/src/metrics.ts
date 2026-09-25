// SPDX-License-Identifier: MIT

/**
 * P&L and operational metrics for the reference solver.
 *
 * Tracks fills attempted/won/lost, realized profit (in dest-asset smallest
 * units), gas/fee spend, and a skip-reason histogram. Exposes a snapshot
 * suitable for structured logging and a Prometheus-style text render.
 *
 * All bigint amounts are in each asset's own smallest units.
 */

export interface CorridorStats {
  /** Total fills attempted (sent to executor). */
  fillsAttempted: number;
  /** Fills confirmed on-chain. */
  fillsWon: number;
  /** Fills that threw an executor error (lost race or revert). */
  fillsLost: number;
  /**
   * Estimated profit = sum of (deliverable − minDestAmount - fees) for every won fill,
   * in dest-asset smallest units.
   */
  estimatedProfitSmallestUnits: bigint;
  /** Backward-compatible alias for estimatedProfitSmallestUnits. */
  readonly realizedProfitSmallestUnits?: bigint;
}

export interface FillFees {
  /** Gas paid on source chain in wei (gasUsed * effectiveGasPrice). */
  sourceGasWei?: bigint;
  /** LayerZero messaging fee paid in native token (wei). */
  lzFeeWei?: bigint;
  /** Stellar / Soroban transaction fee paid in stroops. */
  stellarFeeStroops?: bigint;
}

export interface MetricsSnapshot {
  /** Per-asset P&L and fill accounting (key = dest asset "CODE:ISSUER"). */
  readonly corridors: Readonly<Record<string, CorridorStats>>;
  /** Total gas/LayerZero fee spend in wei (or whatever unit the executor tracks). */
  readonly totalFeesWei: bigint;
  /** Total gas spent on source chain in wei. */
  readonly sourceGasWei: bigint;
  /** Total LayerZero messaging fees paid in wei. */
  readonly lzFeeWei: bigint;
  /** Total transaction fees paid on Stellar in stroops. */
  readonly stellarFeeStroops: bigint;
  /** Histogram of skip reasons: reason → count. */
  readonly skipReasons: Readonly<Record<string, number>>;
  /** Dedicated counter for implausible profit sanity bound triggers. */
  readonly implausibleProfitTriggers: number;
  /** ISO timestamp of the last reset (or process start). */
  readonly since: string;
}

/** Interface used by Solver to record events without importing the concrete class. */
export interface Metrics {
  recordFillAttempt(destAsset: string): void;
  recordFillWon(
    destAsset: string,
    minDestAmountOrProfit: bigint,
    marginBpsOrFee?: number | bigint,
  ): void;
  recordFillLost(destAsset: string, reason: string): void;
  recordSkip(reason: string): void;
  recordImplausibleProfitTrigger?(): void;
  recordFee(wei: bigint): void;
  recordFees?(fees: FillFees): void;
  snapshot(): MetricsSnapshot;
}

export class SolverMetrics implements Metrics {
  private readonly corridors = new Map<string, CorridorStats>();
  private totalFeesWei = 0n;
  private sourceGasWei = 0n;
  private lzFeeWei = 0n;
  private stellarFeeStroops = 0n;
  private readonly skipReasons = new Map<string, number>();
  private implausibleProfitTriggers = 0;
  private readonly since = new Date().toISOString();

  private corridor(asset: string): CorridorStats {
    let s = this.corridors.get(asset);
    if (!s) {
      s = {
        fillsAttempted: 0,
        fillsWon: 0,
        fillsLost: 0,
        estimatedProfitSmallestUnits: 0n,
        get realizedProfitSmallestUnits() {
          return this.estimatedProfitSmallestUnits;
        },
      };
      this.corridors.set(asset, s);
    }
    return s;
  }

  recordFillAttempt(destAsset: string): void {
    this.corridor(destAsset).fillsAttempted += 1;
  }

  /**
   * Record a successful fill.
   *
   * Supports two signatures:
   * 1. (destAsset, estimatedProfitSmallestUnits, feeSmallestUnits?) - exact profit units.
   * 2. (destAsset, minDestAmount, marginBps) - backward compatibility back-computing against minDestAmount.
   */
  recordFillWon(
    destAsset: string,
    amountOrProfit: bigint,
    bpsOrFee?: number | bigint,
  ): void {
    const c = this.corridor(destAsset);
    c.fillsWon += 1;
    if (typeof bpsOrFee === "number") {
      // Legacy call: recordFillWon(destAsset, minDestAmount, marginBps)
      c.estimatedProfitSmallestUnits += (amountOrProfit * BigInt(bpsOrFee)) / 10_000n;
    } else {
      // Modern call: recordFillWon(destAsset, profitSmallestUnits, feeSmallestUnits)
      c.estimatedProfitSmallestUnits += amountOrProfit;
      if (typeof bpsOrFee === "bigint" && bpsOrFee > 0n) {
        this.recordFee(bpsOrFee);
      }
    }
  }

  recordFillLost(destAsset: string, _reason: string): void {
    this.corridor(destAsset).fillsLost += 1;
  }

  private static readonly MAX_SKIP_REASONS = 100;

  recordSkip(reason: string): void {
    if (!this.skipReasons.has(reason) && this.skipReasons.size >= SolverMetrics.MAX_SKIP_REASONS) {
      // Bound the map cardinality to prevent unbounded growth from arbitrary input
      this.skipReasons.set("other", (this.skipReasons.get("other") ?? 0) + 1);
      return;
    }
    this.skipReasons.set(reason, (this.skipReasons.get(reason) ?? 0) + 1);
  }

  recordImplausibleProfitTrigger(): void {
    this.implausibleProfitTriggers += 1;
  }

  recordFee(wei: bigint): void {
    this.totalFeesWei += wei;
    this.sourceGasWei += wei;
  }

  recordFees(fees: FillFees): void {
    if (fees.sourceGasWei) {
      this.sourceGasWei += fees.sourceGasWei;
      this.totalFeesWei += fees.sourceGasWei;
    }
    if (fees.lzFeeWei) {
      this.lzFeeWei += fees.lzFeeWei;
      this.totalFeesWei += fees.lzFeeWei;
    }
    if (fees.stellarFeeStroops) {
      this.stellarFeeStroops += fees.stellarFeeStroops;
    }
  }

  snapshot(): MetricsSnapshot {
    const corridors: Record<string, CorridorStats> = {};
    for (const [k, v] of this.corridors) {
      corridors[k] = {
        fillsAttempted: v.fillsAttempted,
        fillsWon: v.fillsWon,
        fillsLost: v.fillsLost,
        estimatedProfitSmallestUnits: v.estimatedProfitSmallestUnits,
        realizedProfitSmallestUnits: v.estimatedProfitSmallestUnits,
      };
    }
    const skipReasons: Record<string, number> = {};
    for (const [k, v] of this.skipReasons) {
      skipReasons[k] = v;
    }
    return {
      corridors,
      totalFeesWei: this.totalFeesWei,
      sourceGasWei: this.sourceGasWei,
      lzFeeWei: this.lzFeeWei,
      stellarFeeStroops: this.stellarFeeStroops,
      skipReasons,
      implausibleProfitTriggers: this.implausibleProfitTriggers,
      since: this.since,
    };
  }

  /**
   * Escape label values according to Prometheus text exposition format:
   * backslash (\) -> \\
   * double-quote (") -> \"
   * newline (\n) -> \n
   */
  private escapeLabelValue(val: string): string {
    return val
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      .replace(/\n/g, "\\n");
  }

  /**
   * Render a Prometheus-style plain-text exposition so the metrics endpoint
   * can serve it as `text/plain; version=0.0.4`.
   */
  toPrometheusText(): string {
    const lines: string[] = [];
    const snap = this.snapshot();

    lines.push("# HELP solver_fills_attempted Total fills attempted per destination asset");
    lines.push("# TYPE solver_fills_attempted counter");
    for (const [asset, c] of Object.entries(snap.corridors)) {
      lines.push(`solver_fills_attempted{asset="${this.escapeLabelValue(asset)}"} ${c.fillsAttempted}`);
    }

    lines.push("# HELP solver_fills_won Fills successfully settled on-chain per destination asset");
    lines.push("# TYPE solver_fills_won counter");
    for (const [asset, c] of Object.entries(snap.corridors)) {
      lines.push(`solver_fills_won{asset="${this.escapeLabelValue(asset)}"} ${c.fillsWon}`);
    }

    lines.push("# HELP solver_fills_lost Fills that failed on-chain or threw an executor error per destination asset");
    lines.push("# TYPE solver_fills_lost counter");
    for (const [asset, c] of Object.entries(snap.corridors)) {
      lines.push(`solver_fills_lost{asset="${this.escapeLabelValue(asset)}"} ${c.fillsLost}`);
    }

    lines.push("# HELP solver_estimated_profit_units Estimated profit sum (net of fees) in destination asset smallest units");
    lines.push("# TYPE solver_estimated_profit_units counter");
    for (const [asset, c] of Object.entries(snap.corridors)) {
      lines.push(`solver_estimated_profit_units{asset="${this.escapeLabelValue(asset)}"} ${c.estimatedProfitSmallestUnits}`);
    }

    lines.push("# HELP solver_realized_profit_units Deprecated alias for solver_estimated_profit_units");
    lines.push("# TYPE solver_realized_profit_units counter");
    for (const [asset, c] of Object.entries(snap.corridors)) {
      lines.push(`solver_realized_profit_units{asset="${this.escapeLabelValue(asset)}"} ${c.estimatedProfitSmallestUnits}`);
    }

    lines.push("# HELP solver_fees_total_wei Total fees paid in wei (deprecated: use leg-specific metrics)");
    lines.push("# TYPE solver_fees_total_wei counter");
    lines.push(`solver_fees_total_wei ${snap.totalFeesWei}`);

    lines.push("# HELP solver_implausible_profit_triggers_total Quotes rejected by the implausible-profit sanity bound");
    lines.push("# TYPE solver_implausible_profit_triggers_total counter");
    lines.push(`solver_implausible_profit_triggers_total ${snap.implausibleProfitTriggers}`);

    lines.push("# HELP solver_source_gas_wei Total gas spent on source chain transactions in wei");
    lines.push("# TYPE solver_source_gas_wei counter");
    lines.push(`solver_source_gas_wei ${snap.sourceGasWei}`);

    lines.push("# HELP solver_lz_fee_wei Total LayerZero messaging fees paid in native token wei");
    lines.push("# TYPE solver_lz_fee_wei counter");
    lines.push(`solver_lz_fee_wei ${snap.lzFeeWei}`);

    lines.push("# HELP solver_stellar_fee_stroops Total transaction fees paid on Stellar in stroops");
    lines.push("# TYPE solver_stellar_fee_stroops counter");
    lines.push(`solver_stellar_fee_stroops ${snap.stellarFeeStroops}`);

    lines.push("# HELP solver_skips_total Total intents skipped grouped by reason or code");
    lines.push("# TYPE solver_skips_total counter");
    for (const [reason, count] of Object.entries(snap.skipReasons)) {
      lines.push(`solver_skips_total{reason="${this.escapeLabelValue(reason)}"} ${count}`);
    }

    return lines.join("\n") + "\n";
  }
}
