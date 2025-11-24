import { archestraApiSdk, type archestraApiTypes } from "@shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

const {
  assignToolToAgent,
  getTools,
  getTool,
  getAllAgentTools,
  unassignToolFromAgent,
  updateAgentTool,
} = archestraApiSdk;

type GetAllAgentToolsQueryParams = NonNullable<
  archestraApiTypes.GetAllAgentToolsData["query"]
>;
type GetToolsQuery = NonNullable<archestraApiTypes.GetToolsData["query"]>;

export function useTools({
  initialData,
  pagination,
  sorting,
  filters,
}: {
  initialData?: archestraApiTypes.GetToolsResponses["200"];
  pagination?: Partial<Pick<GetToolsQuery, "limit" | "offset">>;
  sorting?: Partial<Pick<GetToolsQuery, "sortBy" | "sortDirection">>;
  filters?: Partial<
    Pick<
      GetToolsQuery,
      | "search"
      | "agentId"
      | "origin"
      | "mcpServerOwnerId"
      | "excludeArchestraTools"
    >
  >;
}) {
  return useQuery({
    queryKey: [
      "tools",
      {
        limit: pagination?.limit,
        offset: pagination?.offset,
        sortBy: sorting?.sortBy,
        sortDirection: sorting?.sortDirection,
        search: filters?.search,
        agentId: filters?.agentId,
        origin: filters?.origin,
        mcpServerOwnerId: filters?.mcpServerOwnerId,
        excludeArchestraTools: filters?.excludeArchestraTools,
      },
    ],
    queryFn: async () => {
      const result = await getTools({
        query: {
          limit: pagination?.limit,
          offset: pagination?.offset,
          sortBy: sorting?.sortBy,
          sortDirection: sorting?.sortDirection,
          search: filters?.search,
          agentId: filters?.agentId,
          origin: filters?.origin,
          mcpServerOwnerId: filters?.mcpServerOwnerId,
          excludeArchestraTools: filters?.excludeArchestraTools,
        },
      });

      return (
        result.data ?? {
          data: [],
          pagination: {
            currentPage: 1,
            limit: pagination?.limit ?? 20,
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

export function useTool(toolId: string) {
  return useQuery({
    queryKey: ["tool", toolId],
    queryFn: async () => {
      const { data } = await getTool({
        query: {
          toolId,
        },
      });
      return data;
    },
  });
}

export function useAllAgentTools({
  initialData,
  pagination,
  sorting,
  filters,
  enabled = true,
}: {
  initialData?: archestraApiTypes.GetAllAgentToolsResponses["200"];
  pagination?: Partial<Pick<GetAllAgentToolsQueryParams, "limit" | "offset">>;
  sorting?: Partial<
    Pick<GetAllAgentToolsQueryParams, "sortBy" | "sortDirection">
  >;
  filters?: Partial<
    Pick<
      GetAllAgentToolsQueryParams,
      | "search"
      | "agentId"
      | "toolId"
      | "origin"
      | "mcpServerOwnerId"
      | "excludeArchestraTools"
    >
  >;
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
        toolId: filters?.toolId,
        origin: filters?.origin,
        mcpServerOwnerId: filters?.mcpServerOwnerId,
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
          toolId: filters?.toolId,
          origin: filters?.origin,
          mcpServerOwnerId: filters?.mcpServerOwnerId,
          excludeArchestraTools: true,
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
      toolPolicyId,
    }: {
      agentId: string;
      toolId: string;
      credentialSourceMcpServerId?: string | null;
      executionSourceMcpServerId?: string | null;
      toolPolicyId?: string | null;
    }) => {
      const bodyPayload: archestraApiTypes.AssignToolToAgentData["body"] = {};

      if (credentialSourceMcpServerId) {
        bodyPayload.credentialSourceMcpServerId = credentialSourceMcpServerId;
      }
      if (executionSourceMcpServerId) {
        bodyPayload.executionSourceMcpServerId = executionSourceMcpServerId;
      }
      if (toolPolicyId) {
        bodyPayload.toolPolicyId = toolPolicyId;
      }

      const { data } = await assignToolToAgent({
        path: { agentId, toolId },
        body: bodyPayload,
      });
      return data?.success ?? false;
    },
    onSuccess: (_, { agentId }) => {
      // Invalidate queries to refetch data
      queryClient.invalidateQueries({ queryKey: ["agents", agentId, "tools"] });
      queryClient.invalidateQueries({ queryKey: ["tools"] });
      queryClient.invalidateQueries({ queryKey: ["tools", "unassigned"] });
      queryClient.invalidateQueries({ queryKey: ["agent-tools"] });
      queryClient.refetchQueries({ queryKey: ["agent-tools"] });
      // Invalidate all MCP server tools queries to update assigned agent counts
      queryClient.invalidateQueries({ queryKey: ["mcp-servers"] });
      // Invalidate chat MCP tools for this agent
      queryClient.invalidateQueries({
        queryKey: ["chat", "agents", agentId, "mcp-tools"],
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
      queryClient.refetchQueries({ queryKey: ["agent-tools"] });
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
      queryClient.refetchQueries({ queryKey: ["agent-tools"] });
    },
  });
}
