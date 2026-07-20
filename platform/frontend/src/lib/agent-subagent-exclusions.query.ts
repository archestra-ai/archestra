import { archestraApiSdk, type archestraApiTypes } from "@archestra/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { handleApiError, throwOnApiError, toApiError } from "@/lib/utils";

const { getAgentSubagentExclusions, updateAgentSubagentExclusions } =
  archestraApiSdk;

export type AgentSubagentExclusions =
  archestraApiTypes.GetAgentSubagentExclusionsResponses["200"];

export function useAgentSubagentExclusions(agentId: string | undefined) {
  return useQuery({
    queryKey: agentSubagentExclusionsQueryKey(agentId ?? ""),
    queryFn: async (): Promise<AgentSubagentExclusions> => {
      if (!agentId) return { excludedSubagentIds: [] };
      const { data, error } = await getAgentSubagentExclusions({
        path: { id: agentId },
      });
      throwOnApiError(error, { toastOnError: false });
      return data ?? { excludedSubagentIds: [] };
    },
    enabled: !!agentId,
  });
}

export function useUpdateAgentSubagentExclusions() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (params: {
      agentId: string;
      exclusions: AgentSubagentExclusions;
    }) => {
      const { data, error } = await updateAgentSubagentExclusions({
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
        queryKey: agentSubagentExclusionsQueryKey(agentId),
      });
    },
  });
}

// === internal ===

function agentSubagentExclusionsQueryKey(agentId: string) {
  return ["agents", agentId, "subagent-exclusions"] as const;
}
