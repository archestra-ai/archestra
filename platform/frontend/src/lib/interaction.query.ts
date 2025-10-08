"use client";

import {
  type GetInteractionResponses,
  type GetInteractionsResponses,
  getInteraction,
  getInteractions,
} from "@shared/api-client";
import { useQuery } from "@tanstack/react-query";

export function useInteractions({
  agentId,
  initialData,
}: {
  agentId?: string;
  initialData?: GetInteractionsResponses["200"];
} = {}) {
  return useQuery({
    queryKey: ["interactions", agentId],
    queryFn: async () => {
      const params = agentId ? { query: { agentId } } : undefined;
      const response = await getInteractions(params);
      return response.data;
    },
    initialData,
    refetchInterval: 3_000, // later we might want to switch to websockets or sse, polling for now
  });
}

export function useInteraction({
  interactionId,
  initialData,
}: {
  interactionId: string;
  initialData?: GetInteractionResponses["200"];
}) {
  return useQuery({
    queryKey: ["interactions", interactionId],
    queryFn: async () => {
      const response = await getInteraction({ path: { interactionId } });
      return response.data;
    },
    initialData,
    refetchInterval: 3_000, // later we might want to switch to websockets or sse, polling for now
  });
}
