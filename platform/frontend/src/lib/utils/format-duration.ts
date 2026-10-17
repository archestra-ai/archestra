/**
 * How long one request or tool call took: `386ms`, `1.24s`, `18.9s`, and past
 * a minute the same units as {@link formatElapsed}. Untimed records (logged
 * before durations were recorded) read as an em dash.
 */
export function formatLatency(ms: number | null | undefined): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)}s`;
  return formatElapsed(ms);
}

/**
 * A stretch of wall-clock time — an offset into a session, an idle gap — in
 * its two largest units: `420ms`, `4.2s`, `42s`, `3m 5s`, `2h 10m`, `1d 3h`.
 */
export function formatElapsed(ms: number): string {
  const value = Math.max(0, ms);
  if (value < 1000) return `${Math.round(value)}ms`;
  const seconds = value / 1000;
  if (seconds < 60) {
    return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)}s`;
  }
  const totalSeconds = Math.round(seconds);
  const minutes = Math.floor(totalSeconds / 60);
  const remainingSeconds = totalSeconds % 60;
  if (minutes < 60) {
    return remainingSeconds > 0
      ? `${minutes}m ${remainingSeconds}s`
      : `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (hours < 24) {
    return remainingMinutes > 0
      ? `${hours}h ${remainingMinutes}m`
      : `${hours}h`;
  }
  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  return remainingHours > 0 ? `${days}d ${remainingHours}h` : `${days}d`;
}
