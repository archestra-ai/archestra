import { archestraApiSdk, type archestraApiTypes } from "@shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { handleApiError } from "./utils";

const {
  assignToolToAgent,
  autoConfigureAgentToolPolicies,
  bulkAssignTools,
  getAllAgentTools,
  unassignToolFromAgent,
  updateAgentTool,
  getAgentDelegations,
  syncAgentDelegations,
  deleteAgentDelegation,
  getAllDelegationConnections,
} = archestraApiSdk;

type GetAllProfileToolsQueryParams = NonNullable<
  archestraApiTypes.GetAllAgentToolsData["query"]
>;

export function useAllProfileTools({
  initialData,
  pagination,
  sorting,
  filters,
  skipPagination,
  enabled = true,
}: {
  initialData?: archestraApiTypes.GetAllAgentToolsResponses["200"];
  pagination?: {
    limit?: number;
    offset?: number;
  };
  sorting?: {
    sortBy?: NonNullable<GetAllProfileToolsQueryParams["sortBy"]>;
    sortDirection?: NonNullable<GetAllProfileToolsQueryParams["sortDirection"]>;
  };
  filters?: {
    search?: string;
    agentId?: string;
    origin?: string;
    credentialSourceMcpServerId?: string;
    mcpServerOwnerId?: string;
  };
  skipPagination?: boolean;
  enabled?: boolean;
}) {
  return useQuery({
    queryKey: [
      "agent-tools",
      {
        limit: pagination?.limit,
        offset: pagination?.offset,
        sortBy: sorting?.sortBy,
        sortDirection: sorting?.sortDirection,
        search: filters?.search,
        agentId: filters?.agentId,
        origin: filters?.origin,
        credentialSourceMcpServerId: filters?.credentialSourceMcpServerId,
        mcpServerOwnerId: filters?.mcpServerOwnerId,
        skipPagination,
      },
    ],
    queryFn: async () => {
      const result = await getAllAgentTools({
        query: {
          limit: pagination?.limit,
          offset: pagination?.offset,
          sortBy: sorting?.sortBy,
          sortDirection: sorting?.sortDirection,
          search: filters?.search,
          agentId: filters?.agentId,
          origin: filters?.origin,
          mcpServerOwnerId: filters?.mcpServerOwnerId,
          skipPagination,
        },
      });
      if (result.error) {
        handleApiError(result.error);
      }
      return (
        result.data ?? {
          data: [],
          pagination: {
            currentPage: 1,
            limit: 20,
            total: 0,
            totalPages: 0,
            hasNext: false,
            hasPrev: false,
          },
        }
      );
    },
    initialData,
    enabled,
  });
}

export function useAssignTool() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      agentId,
      toolId,
      credentialSourceMcpServerId,
      executionSourceMcpServerId,
      useDynamicTeamCredential,
      skipInvalidation,
    }: {
      agentId: string;
      toolId: string;
      credentialSourceMcpServerId?: string | null;
      executionSourceMcpServerId?: string | null;
      useDynamicTeamCredential?: boolean;
      skipInvalidation?: boolean;
    }) => {
      const { data } = await assignToolToAgent({
        path: { agentId, toolId },
        body:
          credentialSourceMcpServerId ||
          executionSourceMcpServerId ||
          useDynamicTeamCredential !== undefined
            ? {
                credentialSourceMcpServerId:
                  credentialSourceMcpServerId || undefined,
                executionSourceMcpServerId:
                  executionSourceMcpServerId || undefined,
                useDynamicTeamCredential,
              }
            : undefined,
      });
      return { success: data?.success ?? false, agentId, skipInvalidation };
    },
    onSuccess: (result) => {
      if (result.skipInvalidation) return;

      const { agentId } = result;
      // Invalidate queries to refetch data
      queryClient.invalidateQueries({ queryKey: ["agents", agentId, "tools"] });
      queryClient.invalidateQueries({ queryKey: ["agents"] });
      queryClient.invalidateQueries({ queryKey: ["tools"] });
      queryClient.invalidateQueries({ queryKey: ["tools", "unassigned"] });
      queryClient.invalidateQueries({ queryKey: ["tools-with-assignments"] });
      queryClient.invalidateQueries({ queryKey: ["agent-tools"] });
      // Invalidate all MCP server queries (including nested tools queries for assignment counts)
      queryClient.invalidateQueries({ queryKey: ["mcp-servers"] });
      // Invalidate all MCP catalog queries (including tools for assignment counts on cards)
      queryClient.invalidateQueries({ queryKey: ["mcp-catalog"] });
      // Invalidate chat MCP tools for this agent and all chat queries
      queryClient.invalidateQueries({
        queryKey: ["chat", "agents", agentId, "mcp-tools"],
      });
      queryClient.invalidateQueries({
        queryKey: ["chat", "agents"],
      });
    },
  });
}

export function useBulkAssignTools() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      assignments,
      mcpServerId,
      skipInvalidation,
    }: {
      assignments: Array<{
        agentId: string;
        toolId: string;
        credentialSourceMcpServerId?: string | null;
        executionSourceMcpServerId?: string | null;
        useDynamicTeamCredential?: boolean;
      }>;
      mcpServerId?: string | null;
      skipInvalidation?: boolean;
    }) => {
      const { data } = await bulkAssignTools({
        body: { assignments },
      });
      if (!data) return null;
      return { ...data, mcpServerId, skipInvalidation };
    },
    onSuccess: (result) => {
      if (!result) return;
      if (result.skipInvalidation) return;

      // Invalidate specific agent tools queries for agents that had successful assignments
      const agentIds = result.succeeded.map((a) => a.agentId);
      const uniqueProfileIds = new Set(agentIds);
      for (const agentId of uniqueProfileIds) {
        queryClient.invalidateQueries({
          queryKey: ["agents", agentId, "tools"],
        });
        // Invalidate chat MCP tools for each affected agent
        queryClient.invalidateQueries({
          queryKey: ["chat", "agents", agentId, "mcp-tools"],
        });
      }

      // Invalidate global queries (only once, exact match to prevent nested invalidation)
      queryClient.invalidateQueries({ queryKey: ["tools"], exact: true });
      queryClient.invalidateQueries({ queryKey: ["tools", "unassigned"] });
      queryClient.invalidateQueries({ queryKey: ["tools-with-assignments"] });
      queryClient.invalidateQueries({ queryKey: ["agent-tools"] });
      queryClient.invalidateQueries({ queryKey: ["agents"] });

      // Invalidate all MCP server queries (including nested tools queries for assignment counts)
      queryClient.invalidateQueries({
        queryKey: ["mcp-servers"],
      });

      // Invalidate all MCP catalog queries (including tools for assignment counts on cards)
      queryClient.invalidateQueries({
        queryKey: ["mcp-catalog"],
      });

      // Invalidate all chat agent queries as a fallback
      queryClient.invalidateQueries({
        queryKey: ["chat", "agents"],
      });
    },
  });
}

export function useUnassignTool() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      agentId,
      toolId,
      skipInvalidation,
    }: {
      agentId: string;
      toolId: string;
      skipInvalidation?: boolean;
    }) => {
      const { data } = await unassignToolFromAgent({
        path: { agentId, toolId },
      });
      return { success: data?.success ?? false, agentId, skipInvalidation };
    },
    onSuccess: (result) => {
      if (result.skipInvalidation) return;

      const { agentId } = result;
      queryClient.invalidateQueries({ queryKey: ["agents", agentId, "tools"] });
      queryClient.invalidateQueries({ queryKey: ["agents"] });
      queryClient.invalidateQueries({ queryKey: ["tools"] });
      queryClient.invalidateQueries({ queryKey: ["tools", "unassigned"] });
      queryClient.invalidateQueries({ queryKey: ["tools-with-assignments"] });
      queryClient.invalidateQueries({ queryKey: ["agent-tools"] });
      // Invalidate all MCP server queries (including nested tools queries for assignment counts)
      queryClient.invalidateQueries({ queryKey: ["mcp-servers"] });
      // Invalidate all MCP catalog queries (including tools for assignment counts on cards)
      queryClient.invalidateQueries({ queryKey: ["mcp-catalog"] });
      // Invalidate chat MCP tools for this agent and all chat queries
      queryClient.invalidateQueries({
        queryKey: ["chat", "agents", agentId, "mcp-tools"],
      });
      queryClient.invalidateQueries({
        queryKey: ["chat", "agents"],
      });
    },
  });
}

export function useProfileToolPatchMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (
      updatedProfileTool: archestraApiTypes.UpdateAgentToolData["body"] & {
        id: string;
        skipInvalidation?: boolean;
      },
    ) => {
      const { skipInvalidation, ...body } = updatedProfileTool;
      const result = await updateAgentTool({
        body,
        path: { id: updatedProfileTool.id },
      });
      if (result.error) {
        handleApiError(result.error);
      }
      return { data: result.data ?? null, skipInvalidation };
    },
    onSuccess: (result) => {
      if (result.skipInvalidation) return;

      // Invalidate all agent-tools queries to refetch updated data
      queryClient.invalidateQueries({
        queryKey: ["agent-tools"],
      });
      queryClient.invalidateQueries({ queryKey: ["agents"] });
      // Invalidate all MCP server queries (including nested tools queries for assignment counts)
      queryClient.invalidateQueries({ queryKey: ["mcp-servers"] });
      // Invalidate all MCP catalog queries (including tools for assignment counts on cards)
      queryClient.invalidateQueries({ queryKey: ["mcp-catalog"] });
      // Invalidate all chat MCP tools queries (we don't know which agent was affected)
      queryClient.invalidateQueries({
        queryKey: ["chat", "agents"],
      });
    },
  });
}

export function useAutoConfigurePolicies() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (toolIds: string[]) => {
      const result = await autoConfigureAgentToolPolicies({
        body: { toolIds },
      });

      if (result.error) {
        handleApiError(result.error);
        return null;
      }

      return result.data;
    },
    onSuccess: () => {
      // Invalidate queries to refetch with new policies
      queryClient.invalidateQueries({
        queryKey: ["agent-tools"],
      });
      queryClient.invalidateQueries({
        queryKey: ["tools"],
      });
      queryClient.invalidateQueries({
        queryKey: ["tool-invocation-policies"],
      });
      queryClient.invalidateQueries({
        queryKey: ["tool-result-policies"],
      });
    },
  });
}

// ============================================================================
// Agent Delegations (Internal Agents Only)
// ============================================================================

/**
 * Query key factory for agent delegations
 */
export const agentDelegationsQueryKeys = {
  all: ["agent-delegations"] as const,
  connections: ["agent-delegations", "connections"] as const,
  byAgent: (agentId: string) => ["agent-delegations", agentId] as const,
};

/**
 * Get all delegation connections for the organization.
 * Used for canvas visualization.
 */
export function useAllDelegationConnections() {
  return useQuery({
    queryKey: agentDelegationsQueryKeys.connections,
    queryFn: async () => {
      const response = await getAllDelegationConnections();
      if (response.error) {
        handleApiError(response.error);
      }
      return (
        response.data ?? {
          connections: [],
          agents: [],
        }
      );
    },
  });
}

/**
 * Get all delegation targets for an internal agent.
 */
export function useAgentDelegations(agentId: string | undefined) {
  return useQuery({
    queryKey: agentDelegationsQueryKeys.byAgent(agentId ?? ""),
    queryFn: async () => {
      if (!agentId) return [];
      const response = await getAgentDelegations({ path: { agentId } });
      if (response.error) {
        handleApiError(response.error);
      }
      return response.data ?? [];
    },
    enabled: !!agentId,
    staleTime: 0, // Always refetch to ensure fresh data
  });
}

/**
 * Sync delegation targets for an internal agent (replace all with new list).
 */
export function useSyncAgentDelegations() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      agentId,
      targetAgentIds,
    }: {
      agentId: string;
      targetAgentIds: string[];
    }) => {
      const response = await syncAgentDelegations({
        path: { agentId },
        body: { targetAgentIds },
      });
      if (response.error) {
        handleApiError(response.error);
        return null;
      }
      return response.data;
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({
        queryKey: agentDelegationsQueryKeys.byAgent(variables.agentId),
      });
      queryClient.invalidateQueries({
        queryKey: agentDelegationsQueryKeys.connections,
      });
      // Delegated agents create/delete tools, so invalidate tool caches
      queryClient.invalidateQueries({ queryKey: ["tools"] });
      queryClient.invalidateQueries({ queryKey: ["tools", "unassigned"] });
      queryClient.invalidateQueries({ queryKey: ["tools-with-assignments"] });
      queryClient.invalidateQueries({ queryKey: ["agent-tools"] });
      // Invalidate agent-specific tools (used by AgentToolsDisplay)
      queryClient.invalidateQueries({
        queryKey: ["agents", variables.agentId, "tools"],
      });
      // Invalidate agents list to update subagents count in table
      queryClient.invalidateQueries({ queryKey: ["agents"] });
    },
  });
}

/**
 * Remove a specific delegation from an agent.
 */
export function useRemoveAgentDelegation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      agentId,
      targetAgentId,
    }: {
      agentId: string;
      targetAgentId: string;
    }) => {
      const response = await deleteAgentDelegation({
        path: { agentId, targetAgentId },
      });
      if (response.error) {
        handleApiError(response.error);
        return null;
      }
      return response.data;
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({
        queryKey: agentDelegationsQueryKeys.byAgent(variables.agentId),
      });
      queryClient.invalidateQueries({
        queryKey: agentDelegationsQueryKeys.connections,
      });
      // Delegated agents create/delete tools, so invalidate tool caches
      queryClient.invalidateQueries({ queryKey: ["tools"] });
      queryClient.invalidateQueries({ queryKey: ["tools", "unassigned"] });
      queryClient.invalidateQueries({ queryKey: ["tools-with-assignments"] });
      queryClient.invalidateQueries({ queryKey: ["agent-tools"] });
      // Invalidate agent-specific tools (used by AgentToolsDisplay)
      queryClient.invalidateQueries({
        queryKey: ["agents", variables.agentId, "tools"],
      });
      // Invalidate agents list to update subagents count in table
      queryClient.invalidateQueries({ queryKey: ["agents"] });
    },
  });
}
