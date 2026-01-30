"use client";

import { archestraApiSdk, type archestraApiTypes } from "@shared";
import { useQuery } from "@tanstack/react-query";
import { DEFAULT_TABLE_LIMIT, handleApiError } from "./utils";

const {
  getInteraction,
  getInteractions,
  getInteractionSessions,
  getUniqueExternalAgentIds,
  getUniqueUserIds,
} = archestraApiSdk;

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
  sortDirection?: "asc" | "desc";
  initialData?: archestraApiTypes.GetInteractionsResponses["200"];
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
    // refetchInterval: 3_000, // later we might want to switch to websockets or sse, polling for now
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
  sessionId?: string;
  startDate?: string;
  endDate?: string;
  search?: string;
  limit?: number;
  offset?: number;
  initialData?: archestraApiTypes.GetInteractionSessionsResponses["200"];
} = {}) {
  return useQuery({
    queryKey: [
      "interactions",
      "sessions",
      profileId,
      userId,
      sessionId,
      startDate,
      endDate,
      search,
      limit,
      offset,
    ],
    queryFn: async () => {
      const response = await getInteractionSessions({
        query: {
          ...(profileId ? { profileId } : {}),
          ...(userId ? { userId } : {}),
          ...(sessionId ? { sessionId } : {}),
          ...(startDate ? { startDate } : {}),
          ...(endDate ? { endDate } : {}),
          ...(search ? { search } : {}),
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
      !sessionId &&
      !startDate &&
      !endDate &&
      !search
        ? initialData
        : undefined,
  });
}
