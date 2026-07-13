export interface SampleStats {
  iterations: number;
  meanMs: number;
  stdevMs: number;
  minMs: number;
  maxMs: number;
}

export function summarize(samplesMs: number[]): SampleStats {
  const n = samplesMs.length;
  const meanMs = samplesMs.reduce((a, b) => a + b, 0) / n;
  const variance =
    n > 1 ? samplesMs.reduce((a, b) => a + (b - meanMs) ** 2, 0) / (n - 1) : 0;
  return {
    iterations: n,
    meanMs,
    stdevMs: Math.sqrt(variance),
    minMs: Math.min(...samplesMs),
    maxMs: Math.max(...samplesMs),
  };
}

export function fmt(value: number, digits = 2): string {
  return value.toFixed(digits);
}
