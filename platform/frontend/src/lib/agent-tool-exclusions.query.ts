import { archestraApiSdk, type archestraApiTypes } from "@archestra/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { handleApiError, throwOnApiError, toApiError } from "@/lib/utils";

const { getAgentToolExclusions, updateAgentToolExclusions } = archestraApiSdk;

export type AgentToolExclusions =
  archestraApiTypes.GetAgentToolExclusionsResponses["200"];

export function useAgentToolExclusions(agentId: string | undefined) {
  return useQuery({
    queryKey: agentToolExclusionsQueryKey(agentId ?? ""),
    queryFn: async (): Promise<AgentToolExclusions> => {
      if (!agentId) return { excludedToolIds: [] };
      const { data, error } = await getAgentToolExclusions({
        path: { id: agentId },
      });
      throwOnApiError(error, { toastOnError: false });
      return data ?? { excludedToolIds: [] };
    },
    enabled: !!agentId,
  });
}

export function useUpdateAgentToolExclusions() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (params: {
      agentId: string;
      exclusions: AgentToolExclusions;
    }) => {
      const { data, error } = await updateAgentToolExclusions({
        path: { id: params.agentId },
        body: params.exclusions,
      });
      if (error) {
        handleApiError(error);
        throw toApiError(error);
      }
      return data;
    },
    onSuccess: (_data, { agentId }) => {
      queryClient.invalidateQueries({
        queryKey: agentToolExclusionsQueryKey(agentId),
      });
    },
  });
}

// === internal ===

function agentToolExclusionsQueryKey(agentId: string) {
  return ["agents", agentId, "tool-exclusions"] as const;
}
