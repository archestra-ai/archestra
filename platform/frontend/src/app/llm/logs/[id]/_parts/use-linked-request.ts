"use client";

import {
  useInteraction,
  useInteractionSummaries,
} from "@/lib/interactions/interaction.query";
import { usePageSeek } from "./page-seek";
import type { InteractionSummary } from "./session-timeline";
import { useSettledOnce } from "./use-session-tool-calls";

/**
 * When the URL names one request (`?request=`), the page of the session it
 * lives on. Requests run oldest first, ties broken by id: the count of those
 * created up to it is the first page to try, and each landed page's first and
 * last rows say which way to step from there.
 */
export function useLinkedRequest({
  sessionId,
  requests,
  requestsReady,
  pageIndex,
  pageSize,
  lastPageIndex,
  onLocatePage,
  targetRequestId,
}: {
  /** The page's session key. */
  sessionId: string;
  /** This page's requests. */
  requests: InteractionSummary[];
  /** Whether `requests` is the settled answer for this page. */
  requestsReady: boolean;
  pageIndex: number;
  pageSize: number;
  lastPageIndex: number;
  /** Moves to the page that holds the linked request. */
  onLocatePage: (pageIndex: number) => void;
  targetRequestId: string | null;
}) {
  const targetOnPage =
    targetRequestId !== null && requests.some((r) => r.id === targetRequestId);
  // Read alongside the page, not after it: the details pane reads the same
  // record when the request is on this page, so the read is never wasted.
  const targetQuery = useInteraction({
    interactionId: targetRequestId ?? undefined,
    refetchInterval: null,
    enabled: targetRequestId !== null,
  });
  const record = targetQuery.data ?? null;
  // A request of another session is not this page's to show.
  const target =
    record &&
    (record.sessionId === sessionId ||
      (record.sessionId === null && record.id === sessionId))
      ? record
      : null;

  // Up to the end of its millisecond: stored times are finer than the ones
  // sent back.
  const atOrBeforeTarget = useInteractionSummaries({
    sessionId,
    endDate: target
      ? new Date(new Date(target.createdAt).getTime() + 1).toISOString()
      : undefined,
    limit: 1,
    enabled: target !== null && requestsReady && !targetOnPage,
  });
  const count = atOrBeforeTarget.data?.pagination.total;
  const seek = usePageSeek({
    id: target?.id ?? null,
    ready: requestsReady,
    pageIndex,
    lastPageIndex,
    guess:
      count === undefined
        ? undefined
        : Math.floor(Math.max(0, count - 1) / pageSize),
    here: target
      ? whereFrom({ target, requests, targetOnPage, pageIndex })
      : undefined,
    onLocatePage,
  });

  const targetResolved =
    targetRequestId === null ||
    (targetOnPage && requestsReady) ||
    targetQuery.isError ||
    (targetQuery.isSuccess && target === null) ||
    seek.settled;

  const settledFor = useSettledOnce(targetRequestId, targetResolved);

  return {
    targetOnPage,
    /** The URL named a request this page cannot show, and looking is over. */
    targetMissing: targetRequestId !== null && targetResolved && !targetOnPage,
    /** A linked request has been found on its page, or found missing. */
    ready: targetRequestId === null || settledFor === targetRequestId,
  };
}

// ============================================================================
// Internal helpers
// ============================================================================

/** Which way the target lies from this page, in the list's (createdAt, id) order. */
function whereFrom({
  target,
  requests,
  targetOnPage,
  pageIndex,
}: {
  target: { id: string; createdAt: string | Date };
  requests: InteractionSummary[];
  targetOnPage: boolean;
  pageIndex: number;
}): -1 | 0 | 1 {
  if (targetOnPage) return 0;
  const first = requests[0];
  const last = requests[requests.length - 1];
  // An empty page past the end: the rows are all before it.
  if (!first || !last) return pageIndex > 0 ? -1 : 0;
  if (compare(target, first) < 0) return -1;
  if (compare(target, last) > 0) return 1;
  return 0;
}

function compare(
  a: { id: string; createdAt: string | Date },
  b: { id: string; createdAt: string | Date },
): number {
  const byTime =
    new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
  if (byTime !== 0) return byTime;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
