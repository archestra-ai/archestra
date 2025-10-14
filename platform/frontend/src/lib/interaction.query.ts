"use client";

import { useSuspenseQuery } from "@tanstack/react-query";
import {
  type GetInteractionResponses,
  type GetInteractionsResponses,
  getInteraction,
  getInteractions,
} from "@/lib/clients/api";
import { DEFAULT_TABLE_LIMIT } from "./utils";

export function useInteractions({
  agentId,
  limit = DEFAULT_TABLE_LIMIT,
  offset = 0,
  initialData,
}: {
  agentId?: string;
  limit?: number;
  offset?: number;
  initialData?: GetInteractionsResponses["200"];
} = {}) {
  return useSuspenseQuery({
    queryKey: ["interactions", agentId, limit, offset],
    queryFn: async () => {
      const response = await getInteractions({
        query: {
          ...(agentId ? { agentId } : {}),
          limit,
          offset,
        },
      });
      return response.data;
    },
    // Only use initialData for the first page (offset 0)
    initialData: offset === 0 ? initialData : undefined,
    // refetchInterval: 3_000, // later we might want to switch to websockets or sse, polling for now
  });
}

export function useInteraction({
  interactionId,
  initialData,
  refetchInterval = 3_000,
}: {
  interactionId: string;
  initialData?: GetInteractionResponses["200"];
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
