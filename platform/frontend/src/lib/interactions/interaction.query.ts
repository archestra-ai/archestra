"use client";

import {
  archestraApiSdk,
  type archestraApiTypes,
  type ClientFilter,
  type InteractionSource,
} from "@archestra/shared";
import { useQuery } from "@tanstack/react-query";
import { DEFAULT_TABLE_LIMIT } from "@/consts";
import { throwOnApiError } from "@/lib/utils";

const {
  getInteraction,
  getInteractions,
  getInteractionSessions,
  getUniqueExternalAgentIds,
  getUniqueUserIds,
} = archestraApiSdk;

/**
 * True when `value` is a full session ID — either a bare `<UUID>` or a
 * `scheduled-<UUID>`. The logs search box only supports session-ID lookup
 * (free-text content search was removed), so callers use this to decide
 * whether a typed term should filter or be ignored.
 */
export const isSessionId = (value: string): boolean => {
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
      throwOnApiError(response.error, { allowNotFound: true });
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
      throwOnApiError(response.error);
      return response.data ?? [];
    },
  });
}

export function useUniqueUserIds() {
  return useQuery({
    queryKey: ["interactions", "userIds"],
    queryFn: async () => {
      const response = await getUniqueUserIds();
      throwOnApiError(response.error);
      return response.data ?? [];
    },
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
  offset = 0,
  initialData,
  toastOnError,
}: {
  profileId?: string;
  userId?: string;
  source?: InteractionSource;
  client?: ClientFilter;
  sessionId?: string;
  startDate?: string;
  endDate?: string;
  limit?: number;
  offset?: number;
  initialData?: archestraApiTypes.GetInteractionSessionsResponses["200"];
  toastOnError?: boolean;
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
      offset,
    ],
    queryFn: async () => {
      const response = await getInteractionSessions({
        query: {
          ...(profileId ? { profileId } : {}),
          ...(userId ? { userId } : {}),
          ...(source ? { source } : {}),
          ...(client ? { client } : {}),
          ...(sessionId ? { sessionId } : {}),
          ...(startDate ? { startDate } : {}),
          ...(endDate ? { endDate } : {}),
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

      throwOnApiError(response.error, { toastOnError });
      return response.data ?? emptyResponse;
    },
    initialData:
      offset === 0 &&
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
  });
}
