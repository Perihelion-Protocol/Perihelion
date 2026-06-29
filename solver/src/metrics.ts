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
   * Realized profit = sum of (deliverable − minDestAmount) for every won fill,
   * in dest-asset smallest units.
   */
  realizedProfitSmallestUnits: bigint;
}

export interface MetricsSnapshot {
  /** Per-asset P&L and fill accounting (key = dest asset "CODE:ISSUER"). */
  readonly corridors: Readonly<Record<string, CorridorStats>>;
  /** Total gas/LayerZero fee spend in wei (or whatever unit the executor tracks). */
  readonly totalFeesWei: bigint;
  /** Histogram of skip reasons: reason → count. */
  readonly skipReasons: Readonly<Record<string, number>>;
  /** ISO timestamp of the last reset (or process start). */
  readonly since: string;
}

/** Interface used by Solver to record events without importing the concrete class. */
export interface Metrics {
  recordFillAttempt(destAsset: string): void;
  recordFillWon(destAsset: string, minDestAmount: bigint, marginBps: number): void;
  recordFillLost(destAsset: string, reason: string): void;
  recordSkip(reason: string): void;
  recordFee(wei: bigint): void;
  snapshot(): MetricsSnapshot;
}

export class SolverMetrics implements Metrics {
  private readonly corridors = new Map<string, CorridorStats>();
  private totalFeesWei = 0n;
  private readonly skipReasons = new Map<string, number>();
  private readonly since = new Date().toISOString();

  private corridor(asset: string): CorridorStats {
    let s = this.corridors.get(asset);
    if (!s) {
      s = {
        fillsAttempted: 0,
        fillsWon: 0,
        fillsLost: 0,
        realizedProfitSmallestUnits: 0n,
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
   * @param destAsset    The destination asset key.
   * @param minDestAmount The user's minimum accepted amount (our cost to fill).
   * @param marginBps    Margin in basis points of minDestAmount — used to back-compute profit.
   */
  recordFillWon(destAsset: string, minDestAmount: bigint, marginBps: number): void {
    const c = this.corridor(destAsset);
    c.fillsWon += 1;
    // profit = minDestAmount * marginBps / 10_000
    c.realizedProfitSmallestUnits += (minDestAmount * BigInt(marginBps)) / 10_000n;
  }

  recordFillLost(destAsset: string, _reason: string): void {
    this.corridor(destAsset).fillsLost += 1;
  }

  recordSkip(reason: string): void {
    this.skipReasons.set(reason, (this.skipReasons.get(reason) ?? 0) + 1);
  }

  recordFee(wei: bigint): void {
    this.totalFeesWei += wei;
  }

  snapshot(): MetricsSnapshot {
    const corridors: Record<string, CorridorStats> = {};
    for (const [k, v] of this.corridors) {
      corridors[k] = { ...v };
    }
    const skipReasons: Record<string, number> = {};
    for (const [k, v] of this.skipReasons) {
      skipReasons[k] = v;
    }
    return {
      corridors,
      totalFeesWei: this.totalFeesWei,
      skipReasons,
      since: this.since,
    };
  }

  /**
   * Render a Prometheus-style plain-text exposition so the metrics endpoint
   * can serve it as `text/plain; version=0.0.4`.
   */
  toPrometheusText(): string {
    const lines: string[] = [];
    const snap = this.snapshot();

    for (const [asset, c] of Object.entries(snap.corridors)) {
      const label = `asset="${asset}"`;
      lines.push(`solver_fills_attempted{${label}} ${c.fillsAttempted}`);
      lines.push(`solver_fills_won{${label}} ${c.fillsWon}`);
      lines.push(`solver_fills_lost{${label}} ${c.fillsLost}`);
      lines.push(`solver_realized_profit_units{${label}} ${c.realizedProfitSmallestUnits}`);
    }

    lines.push(`solver_fees_total_wei ${snap.totalFeesWei}`);

    for (const [reason, count] of Object.entries(snap.skipReasons)) {
      lines.push(`solver_skips_total{reason="${reason}"} ${count}`);
    }

    return lines.join("\n") + "\n";
  }
}
