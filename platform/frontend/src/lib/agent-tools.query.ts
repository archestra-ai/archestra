import { archestraApiSdk, type archestraApiTypes } from "@archestra/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { invalidateToolAssignmentQueries } from "./agent-tools.hook";
import {
  getApiErrorMessage,
  handleApiError,
  reportApiError,
  throwOnApiError,
} from "./utils";

const {
  assignToolToAgent,
  bulkAssignTools,
  bulkUpdateAgentTools,
  getAgentTools,
  getAllAgentTools,
  unassignToolFromAgent,
  updateAgentTool,
  getAgentDelegations,
  syncAgentDelegations,
  deleteAgentDelegation,
} = archestraApiSdk;

type AgentAssignedTool =
  archestraApiTypes.GetAgentToolsResponses["200"][number];

/**
 * Under `["agents", id, "tools"]`, so `invalidateToolAssignmentQueries` — which
 * every tool write funnels through — refreshes this read too.
 */
function agentToolsQueryKey(agentId: string) {
  return ["agents", agentId, "tools", "assigned"] as const;
}

/**
 * The tools currently assigned to an agent, read loud.
 *
 * Deliberately not `fetchAgentMcpTools` from `chat.query.ts`: its
 * `callApi(..., [])` fallback answers a failed read with an empty array, so a
 * 403 or an outage is indistinguishable from an agent with no tools. Callers
 * that decide something on the strength of "this agent has no conflicting
 * tools" need the failure to reach them, so this one throws.
 */
export function useAgentTools(
  agentId: string | undefined,
  params?: { enabled?: boolean },
) {
  return useQuery({
    queryKey: agentToolsQueryKey(agentId ?? ""),
    queryFn: async (): Promise<AgentAssignedTool[]> => {
      if (!agentId) return [];
      const { data, error } = await getAgentTools({ path: { agentId } });
      throwOnApiError(error, { toastOnError: false });
      return data ?? [];
    },
    enabled: !!agentId && (params?.enabled ?? true),
  });
}

type GetAllProfileToolsQueryParams = NonNullable<
  archestraApiTypes.GetAllAgentToolsData["query"]
>;
type CredentialResolutionMode = NonNullable<
  archestraApiTypes.AssignToolToAgentData["body"]
>["credentialResolutionMode"];

export function useAllProfileTools({
  initialData,
  pagination,
  sorting,
  filters,
  skipPagination,
  includeToolDetails,
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
    mcpServerId?: string;
    mcpServerOwnerId?: string;
  };
  skipPagination?: boolean;
  /** False leaves out each tool's parameter schema and description. */
  includeToolDetails?: boolean;
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
        mcpServerId: filters?.mcpServerId,
        mcpServerOwnerId: filters?.mcpServerOwnerId,
        skipPagination,
        includeToolDetails,
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
          includeToolDetails,
        },
      });
      throwOnApiError(result.error);
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
      mcpServerId,
      resolveAtCallTime,
      credentialResolutionMode,
      skipInvalidation,
    }: {
      agentId: string;
      toolId: string;
      mcpServerId?: string | null;
      resolveAtCallTime?: boolean;
      credentialResolutionMode?: CredentialResolutionMode;
      skipInvalidation?: boolean;
    }) => {
      const body =
        mcpServerId ||
        resolveAtCallTime !== undefined ||
        credentialResolutionMode
          ? {
              mcpServerId: mcpServerId ?? undefined,
              resolveAtCallTime,
              credentialResolutionMode,
            }
          : null;

      const { data, error } = await assignToolToAgent({
        path: { agentId, toolId },
        body,
      });
      if (error) {
        throw new Error(getApiErrorMessage(error));
      }
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
    }: NonNullable<archestraApiTypes.BulkAssignToolsData["body"]> & {
      mcpServerId?: string | null;
      skipInvalidation?: boolean;
    }) => {
      const { data, error } = await bulkAssignTools({
        body: { assignments },
      });
      // Without this a 403/404/500 resolves as a successful mutation, so
      // callers report a save that never happened.
      throwOnApiError(error);
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

/**
 * Apply a whole tool-selection edit — additions, credential changes, and
 * removals — in one request.
 *
 * Prefer this over looping {@link useAssignTool}/{@link useUnassignTool}: every
 * one of those requests forks its own agent config version, so a 30-tool server
 * burns 30 of the agent's 100 retained versions and evicts the changes a human
 * actually made. The batch forks once per affected agent.
 */
export function useBulkUpdateAgentTools() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      assignments = [],
      removals = [],
      skipInvalidation,
    }: NonNullable<archestraApiTypes.BulkUpdateAgentToolsData["body"]> & {
      skipInvalidation?: boolean;
    }) => {
      const { data, error } = await bulkUpdateAgentTools({
        body: { assignments, removals },
      });
      // Rejects with the error the toast is already showing, so a caller that
      // reports its own orchestration failures does not repeat this one.
      if (error) throw reportApiError(error);
      if (!data) return null;
      return { ...data, skipInvalidation };
    },
    onSuccess: (result) => {
      if (!result) return;
      if (result.skipInvalidation) return;

      invalidateToolAssignmentQueries(
        queryClient,
        new Set([
          ...result.succeeded.map((s) => s.agentId),
          ...result.removed.map((r) => r.agentId),
        ]),
      );
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
      const { data, error } = await unassignToolFromAgent({
        path: { agentId, toolId },
      });
      if (error) {
        throw new Error(getApiErrorMessage(error));
      }
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
        throw new Error(getApiErrorMessage(result.error));
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
 * Get all delegation targets for an internal agent.
 */
export function useAgentDelegations(
  agentId: string | undefined,
  params?: { enabled?: boolean },
) {
  return useQuery({
    queryKey: agentDelegationsQueryKeys.byAgent(agentId ?? ""),
    queryFn: async () => {
      if (!agentId) return [];
      const response = await getAgentDelegations({ path: { agentId } });
      throwOnApiError(response.error);
      return response.data ?? [];
    },
    enabled: !!agentId && (params?.enabled ?? true),
    // No `keepPreviousData`: the key is the agent, so a placeholder would show
    // (and, in the agent form, seed and save) the previous agent's subagents.
    staleTime: 30 * 1000,
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

/**
 * Adds and removes one server's tools on an agent in a single step.
 *
 * Every request runs even when some are refused, and a failure reports how
 * many tools still landed rather than leaving the caller to guess. Credentials
 * default to resolving at call time, the only mode a personal connection can
 * use. Pass `undoToast` to confirm a plain add with an Undo that removes
 * exactly the tools it added.
 */
export function useUpdateAgentServerTools() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (params: UpdateAgentServerToolsParams) => {
      const credential = params.credential ?? { mode: "dynamic" };
      const assignBody = params.builtIn
        ? null
        : credential.mode === "dynamic"
          ? {
              resolveAtCallTime: true,
              credentialResolutionMode: "dynamic" as const,
            }
          : {
              mcpServerId: credential.mcpServerId,
              resolveAtCallTime: false,
              credentialResolutionMode: "static" as const,
            };
      const results = await Promise.allSettled([
        ...params.add.map(async (toolId) => {
          const { error } = await assignToolToAgent({
            path: { agentId: params.agentId, toolId },
            body: assignBody,
          });
          if (error) throw new Error(getApiErrorMessage(error));
          return toolId;
        }),
        ...params.remove.map(async (toolId) => {
          const { error } = await unassignToolFromAgent({
            path: { agentId: params.agentId, toolId },
          });
          if (error) throw new Error(getApiErrorMessage(error));
          return toolId;
        }),
      ]);
      const added = results
        .slice(0, params.add.length)
        .flatMap((result) =>
          result.status === "fulfilled" ? [result.value] : [],
        );
      const failure = results.find((result) => result.status === "rejected");
      if (failure) {
        throw new ServerToolsUpdateError({
          message:
            failure.reason instanceof Error
              ? failure.reason.message
              : "The server refused the change",
          addedCount: added.length,
          requestedAddCount: params.add.length,
        });
      }
      return { added };
    },
    onSettled: (_data, _error, params) => {
      invalidateToolAssignmentQueries(queryClient, params.agentId);
    },
    onSuccess: ({ added }, params) => {
      if (!params.undoToast || added.length === 0) return;
      const { agentName, serverName } = params.undoToast;
      toast.success(
        `Added ${added.length} ${serverName} ${added.length === 1 ? "tool" : "tools"} to ${agentName}`,
        {
          action: {
            label: "Undo",
            onClick: () => {
              void Promise.allSettled(
                added.map((toolId) =>
                  unassignToolFromAgent({
                    path: { agentId: params.agentId, toolId },
                  }),
                ),
              ).then(() =>
                invalidateToolAssignmentQueries(queryClient, params.agentId),
              );
            },
          },
        },
      );
    },
  });
}

/** A server-tools update that was refused, with how many adds still landed. */
export class ServerToolsUpdateError extends Error {
  readonly addedCount: number;
  readonly requestedAddCount: number;

  constructor(params: {
    message: string;
    addedCount: number;
    requestedAddCount: number;
  }) {
    super(params.message);
    this.name = "ServerToolsUpdateError";
    this.addedCount = params.addedCount;
    this.requestedAddCount = params.requestedAddCount;
  }
}

type UpdateAgentServerToolsParams = {
  agentId: string;
  add: string[];
  remove: string[];
  /** Built-in tools take no credential. */
  builtIn: boolean;
  credential?: { mode: "dynamic" } | { mode: "static"; mcpServerId: string };
  undoToast?: { agentName: string; serverName: string };
};
