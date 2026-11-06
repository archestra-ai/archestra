"use client";

import {
  archestraApiSdk,
  type archestraApiTypes,
  type ClientFilter,
  type InteractionSource,
  isUuid,
} from "@archestra/shared";
import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
} from "@tanstack/react-query";
import { useEffect, useMemo } from "react";
import { toast } from "sonner";
import { DEFAULT_TABLE_LIMIT } from "@/consts";
import { handleApiError, throwOnApiError, toApiError } from "@/lib/utils/api";

const {
  getLlmProxyLog,
  getLlmProxyLogSummaries,
  getLlmProxyLogs,
  getLlmProxyLogSessionLineage,
  getLlmProxyLogSessions,
  getLlmProxyLogExternalAgentIds,
  getLlmProxyLogUserIds,
} = archestraApiSdk;

/**
 * Returns true when `value` is a full session ID: a bare `<UUID>`, a
 * `scheduled-<UUID>`, or an OpenCode `ses_…` ID. The search box in logs
 * supports only session-ID lookups. Callers use this function to decide
 * whether a search term filters the table or is ignored.
 */
export const isSessionId = (value: string): boolean => {
  const openCodeSessionIdRegex = /^ses_[0-9a-z]{20,40}$/i;
  const uuid = value.startsWith("scheduled-")
    ? value.slice("scheduled-".length)
    : value;
  return isUuid(uuid) || openCodeSessionIdRegex.test(value);
};

export function useInteractions({
  profileId,
  externalAgentId,
  userId,
  sessionId,
  startDate,
  endDate,
  limit = DEFAULT_TABLE_LIMIT,
  offset = 0,
  sortBy,
  sortDirection = "desc",
  initialData,
  enabled = true,
  refetchInterval,
}: {
  profileId?: string;
  externalAgentId?: string;
  userId?: string;
  sessionId?: string;
  startDate?: string;
  endDate?: string;
  limit?: number;
  offset?: number;
  sortBy?: NonNullable<
    archestraApiTypes.GetLlmProxyLogsData["query"]
  >["sortBy"];
  sortDirection?: NonNullable<
    archestraApiTypes.GetLlmProxyLogsData["query"]
  >["sortDirection"];
  initialData?: archestraApiTypes.GetLlmProxyLogsResponses["200"];
  enabled?: boolean;
  refetchInterval?: number | false;
} = {}) {
  return useQuery({
    queryKey: [
      "interactions",
      profileId,
      externalAgentId,
      userId,
      sessionId,
      startDate,
      endDate,
      limit,
      offset,
      sortBy,
      sortDirection,
    ],
    queryFn: async () => {
      const response = await getLlmProxyLogs({
        query: {
          ...(profileId ? { profileId } : {}),
          ...(externalAgentId ? { externalAgentId } : {}),
          ...(userId ? { userId } : {}),
          ...(sessionId ? { sessionId } : {}),
          ...(startDate ? { startDate } : {}),
          ...(endDate ? { endDate } : {}),
          limit,
          offset,
          ...(sortBy ? { sortBy } : {}),
          sortDirection,
        },
      });
      const emptyResponse = {
        data: [],
        pagination: {
          currentPage: 1,
          limit,
          total: 0,
          totalPages: 0,
          hasNext: false,
          hasPrev: false,
        },
      };
      throwOnApiError(response.error);
      return response.data ?? emptyResponse;
    },
    enabled,
    // Only use initialData for the first page (offset 0) with default sorting and default limit
    initialData:
      offset === 0 &&
      limit === DEFAULT_TABLE_LIMIT &&
      sortBy === "createdAt" &&
      sortDirection === "desc" &&
      !profileId &&
      !externalAgentId &&
      !userId &&
      !sessionId &&
      !startDate &&
      !endDate
        ? initialData
        : undefined,
    ...(refetchInterval ? { refetchInterval } : {}),
  });
}

/**
 * The requests of a session that asked for some tool calls, found by reading
 * the session backwards from `endDate`. A client runs such a tool, so only
 * the asking request's stored preview knows the call id; previews are
 * decrypted on read, so the match happens here. Reading stops once every id
 * is found or the session's start is reached: rows without recorded call ids
 * (older, or written mid-deploy) can sit between ones that have them.
 */
export function useSessionToolCallAskers({
  sessionId,
  callIds,
  endDate,
}: {
  sessionId: string;
  callIds: string[];
  endDate: string | null;
}): {
  byCallId: Map<string, { requestId: string; name: string }>;
  /** Still reading: a call not found yet may be found. */
  pending: boolean;
  /** A read failed: calls not found may exist. */
  failed: boolean;
  retry: () => void;
} {
  const wanted = callIds.join(",");
  const query = useInfiniteQuery({
    queryKey: ["interaction-tool-call-askers", sessionId, endDate, wanted],
    initialPageParam: 0,
    queryFn: async ({ pageParam }) => {
      const response = await getLlmProxyLogSummaries({
        query: {
          sessionId,
          endDate: endDate ?? undefined,
          limit: ASKER_BATCH,
          offset: pageParam,
          sortBy: "createdAt",
          sortDirection: "desc",
        },
      });
      throwOnApiError(response.error);
      return response.data ?? null;
    },
    getNextPageParam: (last, all) => {
      if (!last?.pagination.hasNext) return undefined;
      const found = new Set(
        all.flatMap((page) =>
          (page?.data ?? []).flatMap((row) =>
            (row.responseToolCalls ?? []).map((call) => call.id),
          ),
        ),
      );
      if (callIds.every((id) => found.has(id))) return undefined;
      return all.length * ASKER_BATCH;
    },
    enabled: callIds.length > 0 && endDate !== null,
  });
  const { hasNextPage, isFetchingNextPage, fetchNextPage, isError } = query;
  useEffect(() => {
    if (hasNextPage && !isFetchingNextPage && !isError) fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, isError, fetchNextPage]);

  const pages = query.data?.pages;
  const byCallId = useMemo(() => {
    const ids = new Set(wanted ? wanted.split(",") : []);
    const found = new Map<string, { requestId: string; name: string }>();
    for (const page of pages ?? []) {
      for (const row of page?.data ?? []) {
        for (const call of row.responseToolCalls ?? []) {
          if (ids.has(call.id) && !found.has(call.id)) {
            found.set(call.id, { requestId: row.id, name: call.name });
          }
        }
      }
    }
    return found;
  }, [pages, wanted]);
  const enabled = callIds.length > 0 && endDate !== null;
  return {
    byCallId,
    pending:
      enabled &&
      !isError &&
      (query.isPending || hasNextPage || isFetchingNextPage),
    failed: enabled && isError,
    retry: () => {
      query.refetch();
    },
  };
}

export function useInteractionSummaries({
  profileId,
  externalAgentId,
  userId,
  sessionId,
  startDate,
  endDate,
  beforeId,
  limit = DEFAULT_TABLE_LIMIT,
  offset = 0,
  sortBy,
  sortDirection = "desc",
  enabled = true,
}: {
  profileId?: string;
  externalAgentId?: string;
  userId?: string;
  sessionId?: string;
  startDate?: string;
  endDate?: string;
  /** Only rows before this interaction; the total is its position. */
  beforeId?: string;
  limit?: number;
  offset?: number;
  sortBy?: NonNullable<
    archestraApiTypes.GetLlmProxyLogSummariesData["query"]
  >["sortBy"];
  sortDirection?: NonNullable<
    archestraApiTypes.GetLlmProxyLogSummariesData["query"]
  >["sortDirection"];
  enabled?: boolean;
} = {}) {
  return useQuery({
    queryKey: [
      "interaction-summaries",
      profileId,
      externalAgentId,
      userId,
      sessionId,
      startDate,
      endDate,
      beforeId,
      limit,
      offset,
      sortBy,
      sortDirection,
    ],
    queryFn: async () => {
      const response = await getLlmProxyLogSummaries({
        query: {
          profileId,
          externalAgentId,
          userId,
          sessionId,
          startDate,
          endDate,
          beforeId,
          limit,
          offset,
          sortBy,
          sortDirection,
        },
      });
      throwOnApiError(response.error);
      return (
        response.data ?? {
          data: [],
          pagination: {
            currentPage: 1,
            limit,
            total: 0,
            totalPages: 0,
            hasNext: false,
            hasPrev: false,
          },
        }
      );
    },
    enabled,
  });
}

export function useInteraction({
  interactionId,
  refetchInterval = 3_000,
  enabled = true,
}: {
  interactionId?: string;
  refetchInterval?: number | null;
  enabled?: boolean;
}) {
  return useQuery({
    queryKey: ["interactions", interactionId],
    queryFn: async () => {
      const response = await getLlmProxyLog({
        path: { logId: interactionId as string },
      });
      throwOnApiError(response.error, { allowNotFound: true });
      return response.data ?? null;
    },
    enabled: enabled && !!interactionId,
    ...(refetchInterval ? { refetchInterval } : {}), // later we might want to switch to websockets or sse, polling for now
  });
}

export function useUniqueExternalAgentIds() {
  return useQuery({
    queryKey: ["interactions", "externalAgentIds"],
    queryFn: async () => {
      const response = await getLlmProxyLogExternalAgentIds();
      throwOnApiError(response.error);
      return response.data ?? [];
    },
  });
}

/**
 * Users for the logs user filter: the most active users, or the users whose
 * name matches `search`. The server caps the list, so search finds the rest.
 */
export function useInteractionUserOptions({
  search,
  enabled,
}: {
  search: string;
  enabled: boolean;
}) {
  return useQuery({
    queryKey: ["interactions", "userIds", "options", search],
    queryFn: async ({ signal }) => {
      const response = await getLlmProxyLogUserIds({
        signal,
        query: { search: search || undefined, limit: LOG_USER_OPTIONS_LIMIT },
      });
      throwOnApiError(response.error, { toastOnError: false });
      return response.data ?? [];
    },
    enabled,
    staleTime: 0,
    refetchOnMount: "always",
    refetchInterval: search ? false : 20_000,
  });
}

/** Resolve the logs users the filter refers to, such as one saved in the URL. */
export function useInteractionUserReferences({ ids }: { ids: string[] }) {
  const uniqueIds = [...new Set(ids)].sort();
  return useQuery({
    queryKey: ["interactions", "userIds", "references", uniqueIds],
    queryFn: async ({ signal }) => {
      const response = await getLlmProxyLogUserIds({
        signal,
        query: { ids: uniqueIds, limit: 100 },
      });
      throwOnApiError(response.error, { toastOnError: false });
      return response.data ?? [];
    },
    enabled: uniqueIds.length > 0,
  });
}

/**
 * Fetches fork lineage for a session: the session it forks and any sessions
 * forked from it. Enabled only when OpenAPPA is on.
 */
export function useSessionLineage({
  sessionId,
  enabled,
}: {
  sessionId: string;
  enabled: boolean;
}) {
  return useQuery({
    queryKey: ["interactions", "sessions", sessionId, "lineage"],
    queryFn: async () => {
      const response = await getLlmProxyLogSessionLineage({
        path: { sessionId },
      });
      const none = { forkedFrom: null, forks: [], forksTruncated: false };
      // A session several people share (a Slack thread, say) has no single
      // lineage to show; that is not an error worth interrupting anyone for.
      if (response.response?.status === 409) return none;
      throwOnApiError(response.error, { toastOnError: false });
      return response.data ?? none;
    },
    enabled,
  });
}

export function useInteractionSessions({
  profileId,
  userId,
  source,
  client,
  sessionId,
  startDate,
  endDate,
  limit = DEFAULT_TABLE_LIMIT,
  cursor,
  initialData,
  toastOnError,
  enabled = true,
}: {
  profileId?: string;
  userId?: string;
  source?: InteractionSource;
  client?: ClientFilter;
  sessionId?: string;
  startDate?: string;
  endDate?: string;
  limit?: number;
  cursor?: string;
  initialData?: archestraApiTypes.GetLlmProxyLogSessionsResponses["200"];
  toastOnError?: boolean;
  enabled?: boolean;
} = {}) {
  return useQuery({
    queryKey: [
      "interactions",
      "sessions",
      profileId,
      userId,
      source,
      client,
      sessionId,
      startDate,
      endDate,
      limit,
      cursor,
    ],
    // A new page or a minute tick keeps the rows on screen until the
    // answer lands, so the table never blanks and loses its scroll.
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const response = await getLlmProxyLogSessions({
        query: {
          ...(profileId ? { profileId } : {}),
          ...(userId ? { userId } : {}),
          ...(source ? { source } : {}),
          ...(client ? { client } : {}),
          ...(sessionId ? { sessionId } : {}),
          ...(startDate ? { startDate } : {}),
          ...(endDate ? { endDate } : {}),
          limit,
          ...(cursor ? { cursor } : {}),
        },
      });
      const emptyResponse = {
        data: [],
        pagination: {
          limit,
          nextCursor: null,
          hasNext: false,
        },
      };

      throwOnApiError(response.error, { toastOnError });
      return response.data ?? emptyResponse;
    },
    initialData:
      !cursor &&
      limit === DEFAULT_TABLE_LIMIT &&
      !profileId &&
      !userId &&
      !source &&
      !client &&
      !sessionId &&
      !startDate &&
      !endDate
        ? initialData
        : undefined,
    enabled,
  });
}

/**
 * Fetch every interaction in a session (paging through the API) and download
 * them as a single JSON file. A mutation rather than a query: it is an
 * on-demand action that wants a pending state for its button and a fresh
 * fetch per click, not a cached result.
 */
export function useExportSessionInteractions() {
  return useMutation({
    mutationFn: async ({ sessionId }: { sessionId: string }) => {
      const interactions: archestraApiTypes.GetLlmProxyLogsResponses["200"]["data"] =
        [];
      let offset = 0;
      for (;;) {
        const response = await getLlmProxyLogs({
          query: {
            sessionId,
            limit: EXPORT_PAGE_SIZE,
            offset,
            sortBy: "createdAt",
            sortDirection: "asc",
          },
        });
        if (response.error) {
          handleApiError(response.error);
          throw toApiError(response.error);
        }
        interactions.push(...(response.data?.data ?? []));
        if (!response.data?.pagination.hasNext) {
          break;
        }
        offset += EXPORT_PAGE_SIZE;
      }
      downloadSessionInteractionsFile(sessionId, interactions);
      return interactions.length;
    },
    onSuccess: (count) => {
      toast.success(
        `Exported ${count} request${count === 1 ? "" : "s"} from this session`,
      );
    },
  });
}

// === Internal helpers ===

// The API caps page size at 100, so the export pages at that cap.
const EXPORT_PAGE_SIZE = 100;

function downloadSessionInteractionsFile(
  sessionId: string,
  interactions: archestraApiTypes.GetLlmProxyLogsResponses["200"]["data"],
) {
  const payload = {
    sessionId,
    exportedAt: new Date().toISOString(),
    interactionCount: interactions.length,
    interactions,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: "application/json",
  });
  // Revoked on a delay: the browser reads the blob asynchronously after the
  // click, so revoking immediately can truncate a large export.
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `llm-session-${sessionId}.json`;
  anchor.style.display = "none";
  document.body.append(anchor);
  anchor.click();
  setTimeout(() => {
    anchor.remove();
    URL.revokeObjectURL(url);
  }, 10_000);
}

const LOG_USER_OPTIONS_LIMIT = 50;

/** Rows read per step of the backward search for tool-call askers. */
const ASKER_BATCH = 100;
