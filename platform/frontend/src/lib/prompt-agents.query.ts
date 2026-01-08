import { archestraApiSdk, type archestraApiTypes } from "@shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

const {
  getAllPromptAgentConnections,
  getPromptAgents,
  syncPromptAgents,
  deletePromptAgent,
} = archestraApiSdk;

/**
 * Query key factory for prompt agents
 */
export const promptAgentsQueryKeys = {
  all: ["prompt-agents"] as const,
  connections: ["prompt-agents", "connections"] as const,
  byPrompt: (promptId: string) => ["prompt-agents", promptId] as const,
};

/**
 * Get all prompt-agent connections for the organization
 * Used for canvas visualization
 */
export function useAllPromptAgentConnections() {
  return useQuery({
    queryKey: promptAgentsQueryKeys.connections,
    queryFn: async () => {
      const response = await getAllPromptAgentConnections();
      return response.data ?? [];
    },
  });
}

/**
 * Get all agents assigned to a prompt
 */
export function usePromptAgents(promptId: string | undefined) {
  return useQuery({
    queryKey: promptAgentsQueryKeys.byPrompt(promptId ?? ""),
    queryFn: async () => {
      if (!promptId) return [];
      const response = await getPromptAgents({ path: { promptId } });
      return response.data ?? [];
    },
    enabled: !!promptId,
    staleTime: 0, // Always refetch to ensure fresh data
  });
}

/**
 * Sync agents for a prompt (replace all with new list)
 */
export function useSyncPromptAgents() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      promptId,
      agentPromptIds,
    }: {
      promptId: string;
      agentPromptIds: string[];
    }) => {
      const response = await syncPromptAgents({
        path: { promptId },
        body: { agentPromptIds },
      });
      return response.data;
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({
        queryKey: promptAgentsQueryKeys.byPrompt(variables.promptId),
      });
      queryClient.invalidateQueries({
        queryKey: promptAgentsQueryKeys.connections,
      });
      // Delegated agents create/delete tools, so invalidate tool caches
      queryClient.invalidateQueries({ queryKey: ["tools"] });
      queryClient.invalidateQueries({ queryKey: ["tools", "unassigned"] });
      queryClient.invalidateQueries({ queryKey: ["agent-tools"] });
      // Invalidate prompt-specific tools (used by AgentToolsDisplay)
      queryClient.invalidateQueries({
        queryKey: ["prompts", variables.promptId, "tools"],
      });
      toast.success("Agents updated successfully");
    },
    onError: (error) => {
      toast.error(
        error instanceof Error ? error.message : "Failed to update agents",
      );
    },
  });
}

/**
 * Remove a specific agent from a prompt
 */
export function useDeletePromptAgent() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      promptId,
      agentPromptId,
    }: {
      promptId: string;
      agentPromptId: string;
    }) => {
      const response = await deletePromptAgent({
        path: { promptId, agentPromptId },
      });
      return response.data;
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({
        queryKey: promptAgentsQueryKeys.byPrompt(variables.promptId),
      });
      queryClient.invalidateQueries({
        queryKey: promptAgentsQueryKeys.connections,
      });
      // Delegated agents create/delete tools, so invalidate tool caches
      queryClient.invalidateQueries({ queryKey: ["tools"] });
      queryClient.invalidateQueries({ queryKey: ["tools", "unassigned"] });
      queryClient.invalidateQueries({ queryKey: ["agent-tools"] });
      // Invalidate prompt-specific tools (used by AgentToolsDisplay)
      queryClient.invalidateQueries({
        queryKey: ["prompts", variables.promptId, "tools"],
      });
      toast.success("Agent removed successfully");
    },
    onError: (error) => {
      toast.error(
        error instanceof Error ? error.message : "Failed to remove agent",
      );
    },
  });
}

export type PromptAgentWithDetails =
  archestraApiTypes.GetPromptAgentsResponses["200"][number];
