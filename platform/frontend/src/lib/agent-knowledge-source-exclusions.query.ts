import { archestraApiSdk, type archestraApiTypes } from "@archestra/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { reportApiError, throwOnApiError } from "@/lib/utils";

const {
  getAgentKnowledgeSourceExclusions,
  updateAgentKnowledgeSourceExclusions,
} = archestraApiSdk;

export type AgentKnowledgeSourceExclusions =
  archestraApiTypes.GetAgentKnowledgeSourceExclusionsResponses["200"];

export function useAgentKnowledgeSourceExclusions(agentId: string | undefined) {
  return useQuery({
    queryKey: agentKnowledgeSourceExclusionsQueryKey(agentId ?? ""),
    queryFn: async (): Promise<AgentKnowledgeSourceExclusions> => {
      if (!agentId) return { excludedConnectorIds: [] };
      const { data, error } = await getAgentKnowledgeSourceExclusions({
        path: { id: agentId },
      });
      throwOnApiError(error, { toastOnError: false });
      return data ?? { excludedConnectorIds: [] };
    },
    enabled: !!agentId,
  });
}

export function useUpdateAgentKnowledgeSourceExclusions() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (params: {
      agentId: string;
      exclusions: AgentKnowledgeSourceExclusions;
    }) => {
      const { data, error } = await updateAgentKnowledgeSourceExclusions({
        path: { id: params.agentId },
        body: params.exclusions,
      });
      if (error) {
        throw reportApiError(error);
      }
      return data;
    },
    onSuccess: (_data, { agentId }) => {
      queryClient.invalidateQueries({
        queryKey: agentKnowledgeSourceExclusionsQueryKey(agentId),
      });
    },
  });
}

// === internal ===

function agentKnowledgeSourceExclusionsQueryKey(agentId: string) {
  return ["agents", agentId, "knowledge-source-exclusions"] as const;
}
