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
  requestsReady,
  pageIndex,
  pageSize,
  offset,
  onLocatePage,
  targetToolCallId,
}: {
  sessionId: string;
  /** This page's requests. */
  requests: InteractionSummary[];
  /** Whether `requests` is the settled answer for this page. */
  requestsReady: boolean;
  pageIndex: number;
  pageSize: number;
  offset: number;
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

  const hasNewerPage = offset > 0;
  const newerQuery = useInteractionSummaries({
    sessionId,
    limit: 1,
    offset: Math.max(0, offset - 1),
    sortBy: "createdAt",
    sortDirection: "desc",
    enabled: requestsReady && windowStart !== null && hasNewerPage,
  });
  const newer = hasNewerPage ? newerQuery.data?.data[0] : undefined;
  const windowEnd = newer
    ? new Date(newer.createdAt).getTime() - Math.max(0, newer.durationMs ?? 0)
    : null;

  const windowReady =
    requestsReady &&
    windowStart !== null &&
    (!hasNewerPage || newerQuery.isSuccess);
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
  const [locatedFor, setLocatedFor] = useState<string | null>(null);
  const shouldLocate =
    target !== null &&
    toolCallsQuery.isSuccess &&
    !targetOnPage &&
    locatedFor !== target.id;
  const newerThanTarget = useInteractionSummaries({
    sessionId,
    startDate: target?.createdAt,
    limit: 1,
    enabled: shouldLocate,
  });
  const newerThanTargetCount = shouldLocate
    ? newerThanTarget.data?.pagination.total
    : undefined;
  useEffect(() => {
    if (!target || newerThanTargetCount === undefined) return;
    setLocatedFor(target.id);
    const page = Math.floor(newerThanTargetCount / pageSize);
    if (page !== pageIndex) onLocatePage(page);
  }, [target, newerThanTargetCount, pageSize, pageIndex, onLocatePage]);

  const targetResolved =
    targetToolCallId === null ||
    targetOnPage ||
    targetQuery.isError ||
    (targetQuery.isSuccess && target === null) ||
    (target !== null && locatedFor === target.id && toolCallsQuery.isSuccess);

  return {
    toolCalls,
    isError: toolCallsQuery.isError,
    refetch: toolCallsQuery.refetch,
    /** The window held more calls than one fetch returns. */
    truncated: toolCallsQuery.data?.pagination.hasNext === true,
    targetOnPage,
    /** The URL named a call this page cannot show, and looking is over. */
    targetMissing: targetToolCallId !== null && targetResolved && !targetOnPage,
  };
}

// ============================================================================
// Internal helpers
// ============================================================================

function toIso(ms: number): string {
  return new Date(ms).toISOString();
}
