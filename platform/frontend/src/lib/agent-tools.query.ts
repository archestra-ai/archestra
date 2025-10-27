import {
  useMutation,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import {
  assignToolToAgent,
  type GetAllAgentToolsResponses,
  getAgentTools,
  getAllAgentTools,
  type UpdateAgentToolData,
  unassignToolFromAgent,
  updateAgentTool,
} from "@/lib/clients/api";

export function useAllAgentTools({
  initialData,
}: {
  initialData?: GetAllAgentToolsResponses["200"];
}) {
  return useSuspenseQuery({
    queryKey: ["agent-tools"],
    queryFn: async () => {
      const result = await getAllAgentTools();
      return result.data ?? [];
    },
    initialData,
  });
}

export function useAgentTools(agentId: string) {
  return useSuspenseQuery({
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
      queryClient.invalidateQueries({ queryKey: ["tools", "unassigned"] });
      queryClient.invalidateQueries({ queryKey: ["agent-tools"] });
      // Invalidate all MCP server tools queries to update assigned agent counts
      queryClient.invalidateQueries({ queryKey: ["mcp-servers"] });
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
      queryClient.invalidateQueries({ queryKey: ["tools", "unassigned"] });
      queryClient.invalidateQueries({ queryKey: ["agent-tools"] });
      // Invalidate all MCP server tools queries to update assigned agent counts
      queryClient.invalidateQueries({ queryKey: ["mcp-servers"] });
    },
  });
}

export function useAgentToolPatchMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (
      updatedAgentTool: UpdateAgentToolData["body"] & { id: string },
    ) => {
      const result = await updateAgentTool({
        body: updatedAgentTool,
        path: { id: updatedAgentTool.id },
      });
      return result.data ?? null;
    },
    onSuccess: (data) => {
      // Update the cache directly without invalidating
      queryClient.setQueryData<GetAllAgentToolsResponses["200"]>(
        ["agent-tools"],
        (old) => {
          if (!old || !data) return old;

          // Find and update the agent-tool with the response data
          const agentToolIndex = old.findIndex((at) => at.id === data.id);
          if (agentToolIndex === -1) {
            return old;
          }

          // Create a new array with the updated agent-tool from the server response
          const newAgentTools = [...old];
          newAgentTools[agentToolIndex] = {
            ...newAgentTools[agentToolIndex],
            ...data,
          };
          return newAgentTools;
        },
      );
    },
  });
}
