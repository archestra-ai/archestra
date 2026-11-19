// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import { archestraApiSdk, type archestraApiTypes } from "@archestra/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { reportApiError, throwOnApiError } from "@/lib/utils/api";

const { getAgentIdentityBindings, replaceAgentIdentityBindings } =
  archestraApiSdk;

export type AgentIdentityBinding =
  archestraApiTypes.GetAgentIdentityBindingsResponses["200"]["bindings"][number];

export function useAgentIdentityBindings(agentId: string | undefined) {
  return useQuery({
    queryKey: agentIdentityBindingsQueryKey(agentId ?? ""),
    queryFn: async (): Promise<AgentIdentityBinding[]> => {
      if (!agentId) return [];
      const { data, error } = await getAgentIdentityBindings({
        path: { id: agentId },
      });
      throwOnApiError(error, { toastOnError: false });
      return data?.bindings ?? [];
    },
    enabled: !!agentId,
  });
}

export function useReplaceAgentIdentityBindings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (params: {
      agentId: string;
      bindings: AgentIdentityBinding[];
    }) => {
      const { data, error } = await replaceAgentIdentityBindings({
        path: { id: params.agentId },
        body: { bindings: params.bindings },
      });
      if (error) {
        throw reportApiError(error);
      }
      return data;
    },
    onSuccess: (_data, { agentId }) => {
      queryClient.invalidateQueries({
        queryKey: agentIdentityBindingsQueryKey(agentId),
      });
    },
  });
}

// === internal ===

function agentIdentityBindingsQueryKey(agentId: string) {
  return ["agents", agentId, "identity-bindings"] as const;
}
