"use client";

import { useEffect, useState } from "react";
import { useInteractionSummaries } from "@/lib/interactions/interaction.query";
import {
  useMcpToolCall,
  useSessionMcpToolCalls,
} from "@/lib/mcp/mcp-tool-call.query";
import { usePageSeek } from "./page-seek";
import type { InteractionSummary } from "./session-timeline";

/**
 * The MCP tool calls that belong beside one page of a session's requests,
 * and, when the URL names one tool call, the page it lives on.
 *
 * A call runs after the request that asked for it, so a page owns the calls
 * from its oldest request's start up to the start of the next page's oldest
 * request. The last page is open-ended: nothing newer exists yet.
 */
export function useSessionToolCalls({
  sessionId,
  requests,
  nextRequest,
  boundary,
  requestsReady,
  pageIndex,
  pageSize,
  lastPageIndex,
  onLocatePage,
  targetToolCallId,
}: {
  sessionId: string;
  /** This page's requests. */
  requests: InteractionSummary[];
  /** The oldest row of the next page; null on the last page. */
  nextRequest: InteractionSummary | null;
  /**
   * The read of `nextRequest`. When it failed, this page's window has no end
   * and its calls are not read: an open window would pull in later pages'.
   */
  boundary: { failed: boolean; retry: () => void };
  /** Whether `requests` and `nextRequest` are the settled answer for this page. */
  requestsReady: boolean;
  pageIndex: number;
  pageSize: number;
  lastPageIndex: number;
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

  const windowEnd = nextRequest
    ? new Date(nextRequest.createdAt).getTime() -
      Math.max(0, nextRequest.durationMs ?? 0)
    : null;

  const windowReady = requestsReady && windowStart !== null && !boundary.failed;
  const toolCallsQuery = useSessionMcpToolCalls({
    sessionId,
    startDate: windowStart !== null ? toIso(windowStart) : undefined,
    endDate: windowEnd !== null ? toIso(windowEnd) : undefined,
    enabled: windowReady,
  });
  const toolCalls = windowReady ? (toolCallsQuery.data?.data ?? []) : [];

  // Finding the linked call's page: the count of requests created before it
  // is the first page to try; each page's window then says which way to step
  // (a request that overlaps the call can sort past it).
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
  const olderThanTarget = useInteractionSummaries({
    sessionId,
    endDate: target?.createdAt,
    limit: 1,
    enabled: target !== null,
  });
  const olderCount = olderThanTarget.data?.pagination.total;
  // The page's window is the same bound the tool-call read applies, so where
  // a call falls is known without waiting for the calls themselves.
  const targetAt = target ? new Date(target.createdAt).getTime() : null;
  const seek = usePageSeek({
    id: target?.id ?? null,
    ready: requestsReady && !boundary.failed,
    pageIndex,
    lastPageIndex,
    guess:
      olderCount === undefined
        ? undefined
        : Math.floor(Math.max(0, olderCount - 1) / pageSize),
    here:
      targetAt === null || windowStart === null
        ? undefined
        : targetAt < windowStart
          ? -1
          : windowEnd !== null && targetAt > windowEnd
            ? 1
            : 0,
    onLocatePage,
  });

  const toolCallsSettled =
    requestsReady &&
    (windowStart === null ||
      boundary.failed ||
      toolCallsQuery.isSuccess ||
      toolCallsQuery.isError);
  const targetResolved =
    targetToolCallId === null ||
    (targetOnPage && toolCallsSettled) ||
    targetQuery.isError ||
    (targetQuery.isSuccess && target === null) ||
    // Settled only on the page the walk ended on: until a move lands, the
    // previous page's records are still the ones in hand.
    (seek.settled && toolCallsSettled);
  // Once settled, paging away from the linked call is the viewer's choice.
  const settledFor = useSettledOnce(targetToolCallId, targetResolved);

  return {
    toolCalls,
    isError: boundary.failed || toolCallsQuery.isError,
    refetch: boundary.failed ? boundary.retry : toolCallsQuery.refetch,
    /** The window held more calls than one fetch returns. */
    truncated: toolCallsQuery.data?.pagination.hasNext === true,
    targetOnPage,
    /** The URL named a call this page cannot show, and looking is over. */
    targetMissing: targetToolCallId !== null && targetResolved && !targetOnPage,
    /**
     * This page's calls are in, and a linked call has been found on its page
     * (or found missing): what the trace waits for, so it draws once. A failed
     * boundary draws the page with its error; the link waits for a retry.
     */
    ready:
      toolCallsSettled &&
      (targetToolCallId === null ||
        settledFor === targetToolCallId ||
        boundary.failed),
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
