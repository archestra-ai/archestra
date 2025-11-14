import { archestraApiSdk, type archestraApiTypes } from "@shared";
import {
  useMutation,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";

const {
  assignToolToAgent,
  bulkAssignTools,
  getAllAgentTools,
  unassignToolFromAgent,
  updateAgentTool,
} = archestraApiSdk;

type GetAllAgentToolsQueryParams = NonNullable<
  archestraApiTypes.GetAllAgentToolsData["query"]
>;

export function useAllAgentTools({
  initialData,
  pagination,
  sorting,
  filters,
}: {
  initialData?: archestraApiTypes.GetAllAgentToolsResponses["200"];
  pagination?: {
    limit?: number;
    offset?: number;
  };
  sorting?: {
    sortBy?: NonNullable<GetAllAgentToolsQueryParams["sortBy"]>;
    sortDirection?: NonNullable<GetAllAgentToolsQueryParams["sortDirection"]>;
  };
  filters?: {
    search?: string;
    agentId?: string;
    origin?: string;
    credentialSourceMcpServerId?: string;
  };
}) {
  return useSuspenseQuery({
    queryKey: ["agent-tools"],
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
          credentialSourceMcpServerId: filters?.credentialSourceMcpServerId,
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
    }: {
      agentId: string;
      toolId: string;
      credentialSourceMcpServerId?: string | null;
      executionSourceMcpServerId?: string | null;
    }) => {
      const { data } = await assignToolToAgent({
        path: { agentId, toolId },
        body:
          credentialSourceMcpServerId || executionSourceMcpServerId
            ? {
                credentialSourceMcpServerId:
                  credentialSourceMcpServerId || undefined,
                executionSourceMcpServerId:
                  executionSourceMcpServerId || undefined,
              }
            : undefined,
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
      const uniqueAgentIds = new Set(agentIds);
      for (const agentId of uniqueAgentIds) {
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

export function useAgentToolPatchMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (
      updatedAgentTool: archestraApiTypes.UpdateAgentToolData["body"] & {
        id: string;
      },
    ) => {
      const result = await updateAgentTool({
        body: updatedAgentTool,
        path: { id: updatedAgentTool.id },
      });
      return result.data ?? null;
    },
    onSuccess: () => {
      // Invalidate all agent-tools queries to refetch updated data
      queryClient.invalidateQueries({
        queryKey: ["agent-tools"],
      });
    },
  });
}
