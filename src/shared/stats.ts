// Latency statistics shared by the dashboard, the eval and the benchmark scripts.
// Percentiles use nearest-rank on the sorted sample, so p99 of fewer than 100 samples is the max.

export function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
}

export interface Summary {
  n: number;
  min: number | null;
  p50: number | null;
  p95: number | null;
  p99: number | null;
  max: number | null;
  mean: number | null;
}

export function summarize(values: (number | null | undefined)[]): Summary {
  const v = values.filter((x): x is number => typeof x === "number" && Number.isFinite(x)).sort((a, b) => a - b);
  const mean = v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
  return {
    n: v.length,
    min: v[0] ?? null,
    p50: percentile(v, 50),
    p95: percentile(v, 95),
    p99: percentile(v, 99),
    max: v.length ? v[v.length - 1] : null,
    mean: mean === null ? null : Math.round(mean),
  };
}
