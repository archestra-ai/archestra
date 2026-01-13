import { archestraApiSdk, type archestraApiTypes } from "@shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

const {
  assignToolToAgent,
  autoConfigureAgentToolPolicies,
  bulkAssignTools,
  getAllAgentTools,
  unassignToolFromAgent,
  updateAgentTool,
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
    }: {
      agentId: string;
      toolId: string;
      credentialSourceMcpServerId?: string | null;
      executionSourceMcpServerId?: string | null;
      useDynamicTeamCredential?: boolean;
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
      return data?.success ?? false;
    },
    onSuccess: (_, { agentId }) => {
      // Invalidate queries to refetch data
      queryClient.invalidateQueries({ queryKey: ["agents", agentId, "tools"] });
      queryClient.invalidateQueries({ queryKey: ["agents"] });
      queryClient.invalidateQueries({ queryKey: ["tools"] });
      queryClient.invalidateQueries({ queryKey: ["tools", "unassigned"] });
      queryClient.invalidateQueries({ queryKey: ["agent-tools"] });
      // Invalidate all MCP server tools queries to update assigned agent counts
      queryClient.invalidateQueries({ queryKey: ["mcp-servers"] });
      // Invalidate chat MCP tools for this agent
      queryClient.invalidateQueries({
        queryKey: ["chat", "agents", agentId, "mcp-tools"],
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
    }: {
      assignments: Array<{
        agentId: string;
        toolId: string;
        credentialSourceMcpServerId?: string | null;
        executionSourceMcpServerId?: string | null;
      }>;
      mcpServerId?: string | null;
    }) => {
      const { data } = await bulkAssignTools({
        body: { assignments },
      });
      if (!data) return null;
      return { ...data, mcpServerId };
    },
    onSuccess: (result) => {
      if (!result) return;

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
      queryClient.invalidateQueries({ queryKey: ["agent-tools"] });
      queryClient.invalidateQueries({ queryKey: ["agents"] });

      // Invalidate the MCP servers list
      queryClient.invalidateQueries({
        queryKey: ["mcp-servers"],
        exact: true,
      });

      // Invalidate the specific MCP server's tools if we know which server
      if (result.mcpServerId) {
        queryClient.invalidateQueries({
          queryKey: ["mcp-servers", result.mcpServerId, "tools"],
        });
      }
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
      queryClient.invalidateQueries({ queryKey: ["agents"] });
      queryClient.invalidateQueries({ queryKey: ["tools"] });
      queryClient.invalidateQueries({ queryKey: ["tools", "unassigned"] });
      queryClient.invalidateQueries({ queryKey: ["agent-tools"] });
      // Invalidate all MCP server tools queries to update assigned agent counts
      queryClient.invalidateQueries({ queryKey: ["mcp-servers"] });
      // Invalidate chat MCP tools for this agent
      queryClient.invalidateQueries({
        queryKey: ["chat", "agents", agentId, "mcp-tools"],
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
      },
    ) => {
      const result = await updateAgentTool({
        body: updatedProfileTool,
        path: { id: updatedProfileTool.id },
      });
      return result.data ?? null;
    },
    onSuccess: () => {
      // Invalidate all agent-tools queries to refetch updated data
      queryClient.invalidateQueries({
        queryKey: ["agent-tools"],
      });
      queryClient.invalidateQueries({ queryKey: ["agents"] });
    },
  });
}

export function useAutoConfigurePolicies() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (agentToolIds: string[]) => {
      const result = await autoConfigureAgentToolPolicies({
        body: { agentToolIds },
      });

      if (!result.data) {
        const errorMessage =
          result.error && "message" in result.error
            ? String(result.error.message)
            : "Failed to auto-configure policies";
        throw new Error(errorMessage);
      }

      return result.data;
    },
    onSuccess: () => {
      // Invalidate agent-tools queries to refetch with new policies
      queryClient.invalidateQueries({
        queryKey: ["agent-tools"],
      });
    },
  });
}
