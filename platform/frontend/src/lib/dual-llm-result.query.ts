"use client";

import { archestraApiSdk, type archestraApiTypes } from "@shared";
import { useQuery } from "@tanstack/react-query";

const { getDualLlmResultByToolCallId, getDualLlmResultsByInteraction } =
  archestraApiSdk;

export function useDualLlmResultByToolCallId(toolCallId: string | null) {
  return useQuery({
    queryKey: ["dual-llm-results", "by-tool-call-id", toolCallId],
    queryFn: async () => {
      if (!toolCallId) return null;
      const response = await getDualLlmResultByToolCallId({
        path: { toolCallId },
      });
      return response.data;
    },
    enabled: !!toolCallId,
  });
}

export function useDualLlmResultsByInteraction({
  interactionId,
  initialData,
}: {
  interactionId: string;
  initialData?: archestraApiTypes.GetDualLlmResultsByInteractionResponses["200"];
}) {
  return useQuery({
    queryKey: ["dual-llm-results", "by-interaction", interactionId],
    queryFn: async () => {
      const response = await getDualLlmResultsByInteraction({
        path: { interactionId },
      });
      return response.data;
    },
    initialData,
  });
}
