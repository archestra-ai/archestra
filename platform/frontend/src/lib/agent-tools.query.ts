import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  assignToolToAgent,
  getAgentTools,
  unassignToolFromAgent,
} from "@/lib/clients/api";

export function useAgentTools(agentId: string) {
  return useQuery({
    queryKey: ["agents", agentId, "tools"],
    queryFn: async () => {
      const { data } = await getAgentTools({ path: { agentId } });
      return data || [];
    },
  });
}

export function useAssignTool() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      agentId,
      toolId,
    }: {
      agentId: string;
      toolId: string;
    }) => {
      const { data } = await assignToolToAgent({
        path: { agentId, toolId },
      });
      return data?.success ?? false;
    },
    onSuccess: (_, { agentId }) => {
      // Invalidate queries to refetch data
      queryClient.invalidateQueries({ queryKey: ["agents", agentId, "tools"] });
      queryClient.invalidateQueries({ queryKey: ["tools"] });
    },
  });
}

export function useUnassignTool() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      agentId,
      toolId,
    }: {
      agentId: string;
      toolId: string;
    }) => {
      const { data } = await unassignToolFromAgent({
        path: { agentId, toolId },
      });
      return data?.success ?? false;
    },
    onSuccess: (_, { agentId }) => {
      queryClient.invalidateQueries({ queryKey: ["agents", agentId, "tools"] });
      queryClient.invalidateQueries({ queryKey: ["tools"] });
    },
  });
}
