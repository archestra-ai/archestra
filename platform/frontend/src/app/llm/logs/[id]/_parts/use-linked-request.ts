"use client";

import { useEffect, useState } from "react";
import type { InteractionSummary } from "@/components/log-detail/session-timeline";
import {
  useInteraction,
  useInteractionSummaries,
} from "@/lib/interactions/interaction.query";
import { useSettledOnce } from "./use-session-tool-calls";

/**
 * When the URL names one request (`?request=`), the page of the session it
 * lives on. Requests run oldest first, ties broken by id; the backend counts
 * the rows before it at the stored precision, which the API's millisecond
 * timestamps cannot.
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
  const before = useInteractionSummaries({
    sessionId,
    beforeId: target?.id,
    limit: 1,
    enabled: shouldLocate,
  });
  const position = shouldLocate ? before.data?.pagination.total : undefined;
  useEffect(() => {
    if (!target || located?.id === target.id) return;
    // Found where the page opened: paging away later is the viewer's choice.
    if (targetOnPage && requestsReady) {
      setLocated({ id: target.id, page: pageIndex });
      return;
    }
    if (position === undefined) return;
    const page = Math.floor(position / pageSize);
    setLocated({ id: target.id, page });
    if (page !== pageIndex) onLocatePage(page);
  }, [
    target,
    located,
    targetOnPage,
    requestsReady,
    position,
    pageSize,
    pageIndex,
    onLocatePage,
  ]);
  // The lookup failed, which says nothing about whether the request is here.
  const rankFailed = shouldLocate && before.isError;

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
    /** Finding the linked request's page failed; `retry` tries again. */
    rankFailed,
    retry: () => before.refetch(),
    /**
     * A linked request has been found on its page, or found missing, or
     * looking failed (the page draws with that error).
     */
    ready:
      targetRequestId === null || settledFor === targetRequestId || rankFailed,
  };
}
