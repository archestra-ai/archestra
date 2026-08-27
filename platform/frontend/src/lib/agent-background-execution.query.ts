import { archestraApiSdk, type archestraApiTypes } from "@archestra/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { reportApiError, throwOnApiError } from "@/lib/utils";

const {
  deleteAgentBackgroundExecutionCredential,
  getAgentBackgroundExecutionPreflight,
  getAgentExecutions,
  setAgentBackgroundExecutionCredential,
} = archestraApiSdk;

export type AgentExecution =
  archestraApiTypes.GetAgentExecutionsResponses["200"][number];

export function useAgentBackgroundExecutionPreflight(
  agentId: string,
  enabled = true,
) {
  return useQuery({
    queryKey: ["agents", agentId, "background-execution", "preflight"],
    queryFn: async () => {
      const { data, error } = await getAgentBackgroundExecutionPreflight({
        path: { id: agentId },
      });
      throwOnApiError(error, { toastOnError: false });
      return data;
    },
    enabled,
  });
}

export function useAgentExecutions(agentId: string, enabled = true) {
  return useQuery({
    queryKey: ["agents", agentId, "executions"],
    queryFn: async () => {
      const { data, error } = await getAgentExecutions({
        path: { id: agentId },
      });
      throwOnApiError(error, { toastOnError: false });
      return data ?? [];
    },
    enabled,
    refetchInterval: enabled ? 5_000 : false,
  });
}

export function useSetAgentBackgroundExecutionCredential(agentId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ key, value }: { key: string; value: string }) => {
      const { data, error } = await setAgentBackgroundExecutionCredential({
        path: { id: agentId, key },
        body: { value },
      });
      if (error) throw reportApiError(error);
      return data;
    },
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: ["agents", agentId, "background-execution", "preflight"],
      }),
  });
}

export function useDeleteAgentBackgroundExecutionCredential(agentId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (key: string) => {
      const { data, error } = await deleteAgentBackgroundExecutionCredential({
        path: { id: agentId, key },
      });
      if (error) throw reportApiError(error);
      return data;
    },
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: ["agents", agentId, "background-execution", "preflight"],
      }),
  });
}
