import type { LogSession } from "./logs-table-format";

type StatusCounts = Pick<LogSession, "chatErrorCount">;

/**
 * A session failed when the chat showed an error card. The chat's errors are
 * stored per conversation, apart from the request rows, so a request that died
 * inside Archestra still leaves a row that looks healthy; the chat error count
 * is what says otherwise.
 */
export function describeSessionStatus(counts: StatusCounts): {
  failed: boolean;
  /** "2 failed turns", or null when nothing failed. */
  detail: string | null;
} {
  // A partial session (a test double, an older payload) reads as no failures.
  const count = counts.chatErrorCount ?? 0;
  if (count <= 0) return { failed: false, detail: null };
  return {
    failed: true,
    detail: `${count.toLocaleString()} failed turn${count === 1 ? "" : "s"}`,
  };
}
