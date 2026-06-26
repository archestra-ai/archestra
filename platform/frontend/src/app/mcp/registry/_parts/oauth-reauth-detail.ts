/**
 * Human-readable detail line for an OAuth refresh failure, shown beneath the
 * Re-authenticate button on the connections surface: the sanitized error code
 * and the failure time (e.g. "invalid_grant · failed Jun 25, 2026, 8:36 PM").
 * The error code is the only message material the backend ever persists.
 */
export function formatOAuthFailureDetail(
  errorMessage: string | null | undefined,
  failedAt: string | null | undefined,
): string {
  const reason = errorMessage || "authentication expired";
  if (!failedAt) return reason;
  const date = new Date(failedAt);
  if (Number.isNaN(date.getTime())) return reason;
  return `${reason} · failed ${date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  })}`;
}
