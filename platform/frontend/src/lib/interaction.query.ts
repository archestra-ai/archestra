"use client";

import { archestraApiSdk, type archestraApiTypes } from "@shared";
import { useSuspenseQuery } from "@tanstack/react-query";
import { DEFAULT_TABLE_LIMIT } from "./utils";

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
  return useSuspenseQuery({
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
      if (response.error) {
        throw new Error(
          response.error.error?.message ?? "Failed to fetch interactions",
        );
      }
      if (!response.data) {
        throw new Error("Failed to fetch interactions");
      }
      return response.data;
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
  return useSuspenseQuery({
    queryKey: ["interactions", interactionId],
    queryFn: async () => {
      const response = await getInteraction({ path: { interactionId } });
      if (response.error) {
        throw new Error(
          response.error.error?.message ?? "Failed to fetch interaction",
        );
      }
      if (!response.data) {
        throw new Error("Failed to fetch interaction");
      }
      return response.data;
    },
    initialData,
    ...(refetchInterval ? { refetchInterval } : {}), // later we might want to switch to websockets or sse, polling for now
  });
}

export function useUniqueExternalAgentIds() {
  return useSuspenseQuery({
    queryKey: ["interactions", "externalAgentIds"],
    queryFn: async () => {
      const response = await getUniqueExternalAgentIds();
      if (response.error) {
        const msg =
          response.error.error?.message ?? "Failed to fetch external agent IDs";
        throw new Error(msg);
      }
      if (!response.data) {
        throw new Error("Failed to fetch external agent IDs");
      }
      return response.data;
    },
  });
}

export function useUniqueUserIds() {
  return useSuspenseQuery({
    queryKey: ["interactions", "userIds"],
    queryFn: async () => {
      const response = await getUniqueUserIds();
      if (response.error) {
        throw new Error(
          response.error.error?.message ?? "Failed to fetch user IDs",
        );
      }
      if (!response.data) {
        throw new Error("Failed to fetch user IDs");
      }
      return response.data;
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
  return useSuspenseQuery({
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
      if (response.error) {
        throw new Error(
          response.error.error?.message ?? "Failed to fetch sessions",
        );
      }
      if (!response.data) {
        throw new Error("Failed to fetch sessions");
      }
      return response.data;
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
