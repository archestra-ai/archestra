/**
 * How long a sync run took, as a compact human duration (`4s`, `47s`, `2m 4s`,
 * `1h 12m`). An unfinished run is measured against now, so a running row reads
 * as elapsed time rather than a blank.
 *
 * Returns null when there is nothing to measure — a queued row with no start
 * time, or clocks that put the end before the beginning.
 */
export function formatRunDuration({
  startedAt,
  completedAt,
  now = Date.now(),
}: {
  startedAt: string | null | undefined;
  completedAt: string | null | undefined;
  /** Injectable for tests; defaults to the current time. */
  now?: number;
}): string | null {
  if (!startedAt) return null;
  const start = new Date(startedAt).getTime();
  if (Number.isNaN(start)) return null;

  const endMs = completedAt ? new Date(completedAt).getTime() : now;
  if (Number.isNaN(endMs)) return null;

  const seconds = Math.round((endMs - start) / 1000);
  if (seconds < 0) return null;
  if (seconds < 60) return `${seconds}s`;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    const remainder = seconds % 60;
    return remainder === 0 ? `${minutes}m` : `${minutes}m ${remainder}s`;
  }

  const hours = Math.floor(minutes / 60);
  const remainderMinutes = minutes % 60;
  return remainderMinutes === 0
    ? `${hours}h`
    : `${hours}h ${remainderMinutes}m`;
}
