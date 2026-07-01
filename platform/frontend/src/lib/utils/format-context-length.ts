/**
 * Formats a context length into a compact human-readable string.
 * e.g. 128000 -> "128K", 1000000 -> "1M", 1048576 -> "1M", 262144 -> "262.1K".
 * A trailing ".0" is dropped so values render consistently ("1M", not "1.0M").
 */
export function formatContextLength(
  contextLength: number | null | undefined,
): string {
  if (contextLength == null) return "-";
  if (contextLength >= 1_000_000) {
    return `${trimTrailingZero(contextLength / 1_000_000)}M`;
  }
  if (contextLength >= 1_000) {
    return `${trimTrailingZero(contextLength / 1_000)}K`;
  }
  return contextLength.toString();
}

/** One decimal place, with a trailing ".0" removed (1.0 -> "1", 1.1 -> "1.1"). */
function trimTrailingZero(value: number): string {
  return value.toFixed(1).replace(/\.0$/, "");
}
