import type { InteractionSummary } from "./session-timeline";

/**
 * Where a page's records end, in epoch ms: the next page's oldest request's
 * start, or without it this page's last request. Null on the last page.
 */
export function pageEndsAt({
  requests,
  nextRequest,
  hasNextPage,
}: {
  /** This page's requests, oldest first. */
  requests: InteractionSummary[];
  /** The next page's oldest request, once read. */
  nextRequest: InteractionSummary | null;
  hasNextPage: boolean;
}): number | null {
  if (nextRequest) {
    return (
      Date.parse(nextRequest.createdAt) -
      Math.max(0, nextRequest.durationMs ?? 0)
    );
  }
  return hasNextPage && requests.length > 0
    ? Math.max(...requests.map((row) => Date.parse(row.createdAt)))
    : null;
}

/**
 * The range of another session's records (a handed-off run's) that join a
 * page, as the logs APIs take it. Pages split the session's requests by
 * `createdAt`, so the range does too: from this page's oldest request to the
 * next page's, which never runs backwards however requests overlap. Adjacent
 * pages share the boundary; the APIs include both ends, so only a record
 * stored at that exact instant shows on both.
 */
export function mergedRecordsQuery({
  offset,
  requests,
  nextRequest,
}: {
  offset: number;
  requests: InteractionSummary[];
  nextRequest: InteractionSummary | null;
}): { startDate?: string; endDate?: string } {
  const first = requests[0];
  return {
    ...(offset > 0 && first ? { startDate: first.createdAt } : {}),
    ...(nextRequest ? { endDate: nextRequest.createdAt } : {}),
  };
}
