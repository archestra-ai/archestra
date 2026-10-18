"use client";

import { useEffect, useState } from "react";
import {
  useInteraction,
  useInteractionSummaries,
} from "@/lib/interactions/interaction.query";
import type { InteractionSummary } from "./session-timeline";

/**
 * When the URL names one request (`?request=`), the page of the session it
 * lives on. Requests are listed newest first, so the requests created at or
 * after it — itself included — are its position plus one.
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
  const targetQuery = useInteraction({
    interactionId: targetRequestId ?? undefined,
    refetchInterval: null,
    enabled: targetRequestId !== null && requestsReady && !targetOnPage,
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
  const atOrAfterTarget = useInteractionSummaries({
    sessionId,
    startDate: target?.createdAt,
    limit: 1,
    enabled: shouldLocate,
  });
  const atOrAfterCount = shouldLocate
    ? atOrAfterTarget.data?.pagination.total
    : undefined;
  useEffect(() => {
    if (!target || atOrAfterCount === undefined) return;
    const page = Math.floor(Math.max(0, atOrAfterCount - 1) / pageSize);
    setLocated({ id: target.id, page });
    if (page !== pageIndex) onLocatePage(page);
  }, [target, atOrAfterCount, pageSize, pageIndex, onLocatePage]);

  const targetResolved =
    targetRequestId === null ||
    targetOnPage ||
    targetQuery.isError ||
    (targetQuery.isSuccess && target === null) ||
    // Settled only on the page it was found on: until the move lands, the
    // previous page's requests are still the ones in hand.
    (target !== null &&
      located?.id === target.id &&
      located.page === pageIndex &&
      requestsReady);

  return {
    targetOnPage,
    /** The URL named a request this page cannot show, and looking is over. */
    targetMissing: targetRequestId !== null && targetResolved && !targetOnPage,
  };
}
