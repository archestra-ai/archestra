"use client";

import { useEffect, useState } from "react";
import { useInteractionSummaries } from "@/lib/interactions/interaction.query";
import {
  useMcpToolCall,
  useSessionMcpToolCalls,
} from "@/lib/mcp/mcp-tool-call.query";
import type { InteractionSummary } from "./session-timeline";

/**
 * The MCP tool calls that belong beside one page of a session's requests,
 * and, when the URL names one tool call, the page it lives on.
 *
 * A call runs after the request that asked for it, so a page owns the calls
 * from its oldest request's start up to the start of the next newer request
 * (the newest row of the previous page). Page one is open-ended: nothing
 * newer exists yet.
 */
export function useSessionToolCalls({
  sessionId,
  requests,
  newerRequest,
  requestsReady,
  pageIndex,
  pageSize,
  onLocatePage,
  targetToolCallId,
}: {
  sessionId: string;
  /** This page's requests. */
  requests: InteractionSummary[];
  /** The newest row of the previous page; null on page one. */
  newerRequest: InteractionSummary | null;
  /** Whether `requests` and `newerRequest` are the settled answer for this page. */
  requestsReady: boolean;
  pageIndex: number;
  pageSize: number;
  /** Moves to the page that holds the linked tool call. */
  onLocatePage: (pageIndex: number) => void;
  /** A tool call the URL points at (`?toolCall=`). */
  targetToolCallId: string | null;
}) {
  const windowStart =
    requests.length > 0
      ? Math.min(
          ...requests.map(
            (row) =>
              new Date(row.createdAt).getTime() -
              Math.max(0, row.durationMs ?? 0),
          ),
        )
      : null;

  const windowEnd = newerRequest
    ? new Date(newerRequest.createdAt).getTime() -
      Math.max(0, newerRequest.durationMs ?? 0)
    : null;

  const windowReady = requestsReady && windowStart !== null;
  const toolCallsQuery = useSessionMcpToolCalls({
    sessionId,
    startDate: windowStart !== null ? toIso(windowStart) : undefined,
    endDate: windowEnd !== null ? toIso(windowEnd) : undefined,
    enabled: windowReady,
  });
  const toolCalls = windowReady ? (toolCallsQuery.data?.data ?? []) : [];

  // Finding the linked call's page: every request created after it sits
  // before it in the newest-first list, so their count is its position.
  const targetQuery = useMcpToolCall({
    mcpToolCallId: targetToolCallId ?? "",
    enabled: targetToolCallId !== null,
  });
  const target =
    targetQuery.data && targetQuery.data.sessionId === sessionId
      ? targetQuery.data
      : null;
  const targetOnPage =
    targetToolCallId !== null &&
    toolCalls.some((call) => call.id === targetToolCallId);
  // Looked up as soon as the call is known, alongside the page's own reads,
  // so a link to another page moves there before this one draws.
  const [located, setLocated] = useState<{ id: string; page: number } | null>(
    null,
  );
  const shouldLocate = target !== null && located?.id !== target.id;
  const newerThanTarget = useInteractionSummaries({
    sessionId,
    startDate: target?.createdAt,
    limit: 1,
    enabled: shouldLocate,
  });
  const newerThanTargetCount = shouldLocate
    ? newerThanTarget.data?.pagination.total
    : undefined;
  // The page's window is the same bound the tool-call read applies, so a call
  // inside it is this page's without waiting for the calls themselves.
  const targetAt = target ? new Date(target.createdAt).getTime() : null;
  const targetInWindow =
    targetAt !== null &&
    windowStart !== null &&
    targetAt >= windowStart &&
    (windowEnd === null || targetAt <= windowEnd);
  useEffect(() => {
    if (!target || located?.id === target.id || !requestsReady) return;
    if (targetInWindow) {
      setLocated({ id: target.id, page: pageIndex });
      return;
    }
    if (newerThanTargetCount === undefined) return;
    const page = Math.floor(newerThanTargetCount / pageSize);
    setLocated({ id: target.id, page });
    if (page !== pageIndex) onLocatePage(page);
  }, [
    target,
    located,
    requestsReady,
    targetInWindow,
    newerThanTargetCount,
    pageSize,
    pageIndex,
    onLocatePage,
  ]);

  const toolCallsSettled =
    requestsReady &&
    (windowStart === null ||
      toolCallsQuery.isSuccess ||
      toolCallsQuery.isError);
  const targetResolved =
    targetToolCallId === null ||
    (targetOnPage && toolCallsSettled) ||
    targetQuery.isError ||
    (targetQuery.isSuccess && target === null) ||
    // Settled only on the page it was found on: until the move lands, the
    // previous page's records are still the ones in hand.
    (target !== null &&
      located?.id === target.id &&
      located.page === pageIndex &&
      toolCallsSettled);
  // Once settled, paging away from the linked call is the viewer's choice.
  const settledFor = useSettledOnce(targetToolCallId, targetResolved);

  return {
    toolCalls,
    isError: toolCallsQuery.isError,
    refetch: toolCallsQuery.refetch,
    /** The window held more calls than one fetch returns. */
    truncated: toolCallsQuery.data?.pagination.hasNext === true,
    targetOnPage,
    /** The URL named a call this page cannot show, and looking is over. */
    targetMissing: targetToolCallId !== null && targetResolved && !targetOnPage,
    /**
     * This page's calls are in, and a linked call has been found on its page
     * (or found missing): what the trace waits for, so it draws once.
     */
    ready:
      toolCallsSettled &&
      (targetToolCallId === null || settledFor === targetToolCallId),
  };
}

// ============================================================================
// Internal helpers
// ============================================================================

/**
 * The linked id once its lookup has settled, kept after: a later page change
 * by the viewer must not send the trace back to loading.
 */
export function useSettledOnce(
  id: string | null,
  settled: boolean,
): string | null {
  const [settledFor, setSettledFor] = useState<string | null>(null);
  useEffect(() => {
    if (id !== null && settled && settledFor !== id) setSettledFor(id);
  }, [id, settled, settledFor]);
  return id !== null && settled ? id : settledFor;
}

function toIso(ms: number): string {
  return new Date(ms).toISOString();
}
