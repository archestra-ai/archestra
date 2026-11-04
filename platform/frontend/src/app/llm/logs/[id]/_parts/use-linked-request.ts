"use client";

import { useEffect, useState } from "react";
import {
  useInteraction,
  useInteractionSummaries,
} from "@/lib/interactions/interaction.query";
import type { InteractionSummary } from "./session-timeline";
import { useSettledOnce } from "./use-session-tool-calls";

/**
 * When the URL names one request (`?request=`), the page of the session it
 * lives on. Requests run oldest first, ties broken by id, so its position is
 * the count of requests created up to it, less those that share its moment
 * but sort after it.
 */
export function useLinkedRequest({
  sessionId,
  requests,
  requestsReady,
  pageIndex,
  pageSize,
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

  // The page the linked request was found on, once looked up. Held per
  // request, so a later link is looked up afresh.
  const [located, setLocated] = useState<{ id: string; page: number } | null>(
    null,
  );
  const shouldLocate =
    target !== null &&
    requestsReady &&
    !targetOnPage &&
    located?.id !== target.id;
  // Up to the end of its millisecond (stored times are finer than the ones
  // sent back), newest first in the list's own order: the target's index in
  // these rows is how many of them sort after it.
  const atOrBeforeTarget = useInteractionSummaries({
    sessionId,
    endDate: target
      ? new Date(new Date(target.createdAt).getTime() + 1).toISOString()
      : undefined,
    limit: TIE_WINDOW,
    sortBy: "createdAt",
    sortDirection: "desc",
    enabled: shouldLocate,
  });
  const position =
    shouldLocate && target && atOrBeforeTarget.data
      ? atOrBeforeTarget.data.pagination.total -
        Math.max(
          0,
          atOrBeforeTarget.data.data.findIndex((row) => row.id === target.id),
        )
      : undefined;
  useEffect(() => {
    if (!target || position === undefined) return;
    const page = Math.floor(Math.max(0, position - 1) / pageSize);
    setLocated({ id: target.id, page });
    if (page !== pageIndex) onLocatePage(page);
  }, [target, position, pageSize, pageIndex, onLocatePage]);

  const targetResolved =
    targetRequestId === null ||
    (targetOnPage && requestsReady) ||
    targetQuery.isError ||
    (targetQuery.isSuccess && target === null) ||
    // Settled only on the page it was found on: until the move lands, the
    // previous page's requests are still the ones in hand.
    (target !== null &&
      located?.id === target.id &&
      located.page === pageIndex &&
      requestsReady);

  const settledFor = useSettledOnce(targetRequestId, targetResolved);

  return {
    targetOnPage,
    /** The URL named a request this page cannot show, and looking is over. */
    targetMissing: targetRequestId !== null && targetResolved && !targetOnPage,
    /** A linked request has been found on its page, or found missing. */
    ready: targetRequestId === null || settledFor === targetRequestId,
  };
}

/** Rows read to place the target among requests that share its moment. */
const TIE_WINDOW = 20;
