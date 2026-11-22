import {
  type ConnectionEvent,
  useConnectionLog,
} from "@/lib/connected-client.query";

/**
 * prototype: the backend records only connected/disconnected (plus `via`).
 * The mock carries the unified feed's finer action and the client's version
 * as extra fields; a real page needs both on the record.
 */
export type ConnectionEventRecord = ConnectionEvent & {
  feedAction?:
    | "connected"
    | "first_seen"
    | "authorized"
    | "token_refreshed"
    | "disconnected";
  clientVersion?: string;
};

/**
 * One connection event, and the same member's other events from the same
 * client, newest first.
 */
export function useConnectionEvent(id: string) {
  // prototype: needs GET /api/connected-clients/log/:id. Until then the event
  // is looked up in the newest page of the log.
  const log = useConnectionLog({ limit: LOG_LIMIT });
  const event = (log.data?.data.find((e) => e.id === id) ??
    null) as ConnectionEventRecord | null;

  const history = useConnectionLog({
    limit: LOG_LIMIT,
    ...(event ? { userId: event.userId } : {}),
  });
  const recent = event
    ? ((history.data?.data ?? []) as ConnectionEventRecord[])
        .filter(
          (e) =>
            e.userId === event.userId &&
            e.clientId === event.clientId &&
            e.agentName === event.agentName,
        )
        .slice(0, RECENT_LIMIT)
    : [];

  return {
    event,
    recent,
    recentPending: history.isPending,
    isPending: log.isPending,
    isLoadingError: log.isLoadingError,
    refetch: log.refetch,
  };
}

// ============================================================================
// Internal helpers
// ============================================================================

const LOG_LIMIT = 100;
const RECENT_LIMIT = 12;
