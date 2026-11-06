import type { InteractionSummary } from "./session-timeline";

/**
 * The time range a page of the session trace covers, in epoch ms: from its
 * oldest request's start to the next page's oldest request's start. Adjacent
 * pages share that boundary exactly, so a record made while the boundary
 * request ran lands on one page, not neither. Null ends are open: the first
 * page has no start, the last no end.
 */
export function pageWindow({
  offset,
  requests,
  nextRequest,
  hasNextPage,
}: {
  offset: number;
  /** This page's requests, oldest first. */
  requests: InteractionSummary[];
  /** The next page's oldest request, once read. */
  nextRequest: InteractionSummary | null;
  hasNextPage: boolean;
}): { startsAt: number | null; endsAt: number | null } {
  const first = requests[0];
  return {
    startsAt: offset > 0 && first ? requestStart(first) : null,
    endsAt: nextRequest
      ? requestStart(nextRequest)
      : // Without the next page's head, this page's last request bounds it.
        hasNextPage && requests.length > 0
        ? Math.max(...requests.map((row) => Date.parse(row.createdAt)))
        : null,
  };
}

// ===

function requestStart(row: InteractionSummary): number {
  return Date.parse(row.createdAt) - Math.max(0, row.durationMs ?? 0);
}
