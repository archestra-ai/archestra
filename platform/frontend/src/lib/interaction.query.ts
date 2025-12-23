"use client";

import { archestraApiSdk, type archestraApiTypes } from "@shared";
import { useSuspenseQuery } from "@tanstack/react-query";
import { DEFAULT_TABLE_LIMIT } from "./utils";

const {
  getInteraction,
  getInteractions,
  getUniqueExternalAgentIds,
  getUniqueUserIds,
} = archestraApiSdk;

export function useInteractions({
  profileId,
  externalAgentId,
  userId,
  limit = DEFAULT_TABLE_LIMIT,
  offset = 0,
  sortBy,
  sortDirection = "desc",
  initialData,
}: {
  profileId?: string;
  externalAgentId?: string;
  userId?: string;
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
          limit,
          offset,
          ...(sortBy ? { sortBy } : {}),
          sortDirection,
        },
      });
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
      !userId
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
      return response.data;
    },
  });
}

export function useUniqueUserIds() {
  return useSuspenseQuery({
    queryKey: ["interactions", "userIds"],
    queryFn: async () => {
      const response = await getUniqueUserIds();
      return response.data;
    },
  });
}
