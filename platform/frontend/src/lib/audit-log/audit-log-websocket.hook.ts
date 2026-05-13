import type { AuditLogMessage } from "@shared";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import websocketService from "@/lib/websocket/websocket";
import { AUDIT_LOG_QUERY_KEY } from "./audit-log.query";

/**
 * Subscribes to live `audit_log` WebSocket messages pushed from the server to
 * clients that hold `auditLog:read`.
 *
 * Behaviour:
 * - If the caller is on page 1 with no `startDate` filter active, each new
 *   event immediately invalidates the TanStack Query cache so the table
 *   refreshes in-place.
 * - Otherwise the event is counted and exposed via `newEventCount` so the UI
 *   can render a "N new events — refresh" indicator without disrupting the
 *   current view.
 *
 * Call `resetNewEventCount()` after the user acts on the indicator (e.g.
 * navigates to page 1 / clears the date filter).
 */
export function useAuditLogWebsocket({
  isFirstPage,
  hasStartDateFilter,
  enabled = true,
}: {
  isFirstPage: boolean;
  hasStartDateFilter: boolean;
  enabled?: boolean;
}) {
  const queryClient = useQueryClient();
  const [newEventCount, setNewEventCount] = useState(0);

  // Keep the flags in a ref so the stable effect closure always reads the
  // current values without needing to re-subscribe on every render.
  const isFirstPageRef = useRef(isFirstPage);
  const hasStartDateFilterRef = useRef(hasStartDateFilter);
  isFirstPageRef.current = isFirstPage;
  hasStartDateFilterRef.current = hasStartDateFilter;

  useEffect(() => {
    if (!enabled) return;

    websocketService.connect();

    const unsubscribe = websocketService.subscribe(
      "audit_log",
      (_message: AuditLogMessage) => {
        if (isFirstPageRef.current && !hasStartDateFilterRef.current) {
          void queryClient.invalidateQueries({
            queryKey: AUDIT_LOG_QUERY_KEY,
          });
        } else {
          setNewEventCount((n) => n + 1);
        }
      },
    );

    return unsubscribe;
  }, [enabled, queryClient]);

  const resetNewEventCount = useCallback(() => {
    setNewEventCount(0);
  }, []);

  return { newEventCount, resetNewEventCount };
}
