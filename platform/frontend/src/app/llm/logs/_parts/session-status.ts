import type { LogSession } from "./logs-table-format";

type StatusCounts = Pick<LogSession, "failedRequestCount" | "chatErrorCount">;

/**
 * A session failed when the chat showed an error card or a request failed.
 * The chat's errors are stored per conversation, apart from the request rows,
 * so a request that died inside Archestra still leaves a row that looks
 * healthy; the chat error count is what says otherwise.
 */
export function describeSessionStatus(counts: StatusCounts): {
  failed: boolean;
  /** "2 chat errors · 1 failed request", or null when nothing failed. */
  detail: string | null;
} {
  const parts = [
    plural(counts.chatErrorCount, "chat error"),
    plural(counts.failedRequestCount, "failed request"),
  ].filter((part): part is string => part !== null);
  return {
    failed: parts.length > 0,
    detail: parts.length > 0 ? parts.join(" · ") : null,
  };
}

function plural(count: number, noun: string): string | null {
  if (count <= 0) return null;
  return `${count.toLocaleString()} ${noun}${count === 1 ? "" : "s"}`;
}
