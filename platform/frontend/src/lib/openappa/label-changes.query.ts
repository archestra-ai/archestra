"use client";

import { archestraApiSdk, type archestraApiTypes } from "@archestra/shared";
import { useQuery } from "@tanstack/react-query";

const { getOpenappaLabelChanges } = archestraApiSdk;

export type LabelChangeRecord =
  archestraApiTypes.GetOpenappaLabelChangesResponses["200"]["data"][number];

/**
 * An LLM session's recorded label history, oldest first: a baseline row,
 * then one per change. Empty when nothing was recorded or the viewer may not
 * read it; the trace then shows no label gutter.
 */
export function useSessionLabelChanges({
  llmSessionId,
  enabled,
}: {
  llmSessionId: string;
  enabled: boolean;
}) {
  return useQuery({
    queryKey: ["openappa-label-changes", llmSessionId],
    enabled,
    queryFn: async (): Promise<LabelChangeRecord[]> => {
      const response = await getOpenappaLabelChanges({
        query: { llmSessionId },
      });
      return response.data?.data ?? [];
    },
  });
}
