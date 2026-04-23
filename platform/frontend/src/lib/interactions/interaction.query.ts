"use client";

import {
  archestraApiSdk,
  type archestraApiTypes,
  type InteractionSource,
} from "@shared";
import { useQuery } from "@tanstack/react-query";
import { DEFAULT_TABLE_LIMIT } from "@/consts";
import { handleApiError } from "@/lib/utils";

const {
  getInteraction,
  getInteractions,
  getInteractionSessions,
  getUniqueExternalAgentIds,
  getUniqueUserIds,
} = archestraApiSdk;

const isSessionId = (value: string): boolean => {
  // Either <UUID>, or scheduled-<UUID>
  const sessionIdRegex =
    /^(scheduled-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return sessionIdRegex.test(value);
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
    archestraApiTypes.GetInteractionsData["query"]
  >["sortBy"];
  sortDirection?: NonNullable<
    archestraApiTypes.GetInteractionsData["query"]
  >["sortDirection"];
  initialData?: archestraApiTypes.GetInteractionsResponses["200"];
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
      const response = await getInteractions({
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
      if (response.error) {
        handleApiError(response.error);
        return emptyResponse;
      }
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

export function useInteraction({
  interactionId,
  initialData,
  refetchInterval = 3_000,
}: {
  interactionId: string;
  initialData?: archestraApiTypes.GetInteractionResponses["200"];
  refetchInterval?: number | null;
}) {
  return useQuery({
    queryKey: ["interactions", interactionId],
    queryFn: async () => {
      const response = await getInteraction({ path: { interactionId } });
      if (response.error) {
        handleApiError(response.error);
        return null;
      }
      return response.data ?? null;
    },
    initialData,
    ...(refetchInterval ? { refetchInterval } : {}), // later we might want to switch to websockets or sse, polling for now
  });
}

export function useUniqueExternalAgentIds() {
  return useQuery({
    queryKey: ["interactions", "externalAgentIds"],
    queryFn: async () => {
      const response = await getUniqueExternalAgentIds();
      if (response.error) {
        handleApiError(response.error);
        return [];
      }
      return response.data ?? [];
    },
  });
}

export function useUniqueUserIds() {
  return useQuery({
    queryKey: ["interactions", "userIds"],
    queryFn: async () => {
      const response = await getUniqueUserIds();
      if (response.error) {
        handleApiError(response.error);
        return [];
      }
      return response.data ?? [];
    },
  });
}

export function useInteractionSessions({
  profileId,
  userId,
  source,
  sessionId,
  startDate,
  endDate,
  search,
  limit = DEFAULT_TABLE_LIMIT,
  offset = 0,
  initialData,
}: {
  profileId?: string;
  userId?: string;
  source?: InteractionSource;
  sessionId?: string;
  startDate?: string;
  endDate?: string;
  search?: string;
  limit?: number;
  offset?: number;
  initialData?: archestraApiTypes.GetInteractionSessionsResponses["200"];
} = {}) {
  // If the search value is a sessionId, we want to treat it as a sessionId search instead
  const isSessionIdSearch = search ? isSessionId(search) : false;
  const effectiveSessionId =
    sessionId ?? (isSessionIdSearch ? search : undefined);
  const effectiveSearch = isSessionIdSearch ? undefined : search;

  return useQuery({
    queryKey: [
      "interactions",
      "sessions",
      profileId,
      userId,
      source,
      effectiveSessionId,
      startDate,
      endDate,
      effectiveSearch,
      limit,
      offset,
    ],
    queryFn: async () => {
      const response = await getInteractionSessions({
        query: {
          ...(profileId ? { profileId } : {}),
          ...(userId ? { userId } : {}),
          ...(source ? { source } : {}),
          ...(effectiveSessionId ? { sessionId: effectiveSessionId } : {}),
          ...(startDate ? { startDate } : {}),
          ...(endDate ? { endDate } : {}),
          ...(effectiveSearch ? { search: effectiveSearch } : {}),
          limit,
          offset,
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

      if (response.error) {
        handleApiError(response.error);
        return emptyResponse;
      }
      return response.data ?? emptyResponse;
    },
    initialData:
      offset === 0 &&
      limit === DEFAULT_TABLE_LIMIT &&
      !profileId &&
      !userId &&
      !source &&
      !effectiveSessionId &&
      !startDate &&
      !endDate &&
      !effectiveSearch
        ? initialData
        : undefined,
  });
}
