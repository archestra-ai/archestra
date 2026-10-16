/** Formats stored latency without conflating missing historical data with zero. */
export function formatRequestLatency(latencyMs: number | null | undefined): string {
  if (latencyMs == null) return "—";
  if (latencyMs < 1_000) return `${latencyMs} ms`;
  return `${(latencyMs / 1_000).toFixed(latencyMs < 10_000 ? 2 : 1)} s`;
}
