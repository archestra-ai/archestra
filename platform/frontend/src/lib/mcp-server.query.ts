import { archestraApiSdk, type archestraApiTypes } from "@shared";
import {
  useMutation,
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { toast } from "sonner";

const {
  deleteMcpServer,
  getMcpServers,
  getMcpServerTools,
  installMcpServer,
  getMcpServer,
  getAgentAvailableTokens,
  getMcpServerLogs,
} = archestraApiSdk;

export function useMcpServers(params?: {
  initialData?: archestraApiTypes.GetMcpServersResponses["200"];
}) {
  return useSuspenseQuery({
    queryKey: ["mcp-servers"],
    queryFn: async () => (await getMcpServers()).data ?? [],
    initialData: params?.initialData,
  });
}

export function useInstallMcpServer() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (
      data: archestraApiTypes.InstallMcpServerData["body"] & {
        dontShowToast?: boolean;
      },
    ) => {
      const { data: installedServer } = await installMcpServer({ body: data });
      if (!data.dontShowToast) {
        toast.success(`Successfully installed ${data.name}`);
      }
      return installedServer;
    },
    onSuccess: async (installedServer) => {
      // Refetch instead of just invalidating to ensure data is fresh
      await queryClient.refetchQueries({ queryKey: ["mcp-servers"] });
      // Invalidate tools queries since MCP server installation creates new tools
      queryClient.invalidateQueries({ queryKey: ["tools"] });
      queryClient.invalidateQueries({ queryKey: ["tools", "unassigned"] });
      queryClient.invalidateQueries({ queryKey: ["agent-tools"] });
      // Invalidate the specific MCP server's tools query
      if (installedServer) {
        queryClient.invalidateQueries({
          queryKey: ["mcp-servers", installedServer.id, "tools"],
        });
      }
    },
    onError: (error, variables) => {
      console.error("Install error:", error);
      toast.error(`Failed to install ${variables.name}`);
    },
  });
}

export function useDeleteMcpServer() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (data: { id: string; name: string }) => {
      const response = await deleteMcpServer({ path: { id: data.id } });
      return response.data;
    },
    onSuccess: async (_, variables) => {
      // Refetch instead of just invalidating to ensure data is fresh
      await queryClient.refetchQueries({ queryKey: ["mcp-servers"] });
      // Invalidate tools queries since MCP server deletion cascades to tools
      queryClient.invalidateQueries({ queryKey: ["tools"] });
      queryClient.invalidateQueries({ queryKey: ["tools", "unassigned"] });
      queryClient.invalidateQueries({ queryKey: ["agent-tools"] });
      toast.success(`Successfully uninstalled ${variables.name}`);
    },
    onError: (error, variables) => {
      console.error("Uninstall error:", error);
      toast.error(`Failed to uninstall ${variables.name}`);
    },
  });
}

export function useRevokeUserMcpServerAccess() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      catalogId,
      userId,
    }: {
      catalogId: string;
      userId: string;
    }) => {
      await archestraApiSdk.revokeUserMcpServerAccess({
        path: { catalogId, userId },
      });
    },
    onSuccess: async () => {
      // Wait for refetch to complete so UI updates immediately
      await queryClient.refetchQueries({
        queryKey: ["mcp-servers"],
        type: "active",
      });
      toast.success("User access revoked successfully");
    },
    onError: (error) => {
      console.error("Error revoking user access:", error);
      toast.error("Failed to revoke user access");
    },
  });
}

export function useGrantTeamMcpServerAccess() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      catalogId,
      teamIds,
      userId,
    }: {
      catalogId: string;
      teamIds: string[];
      userId?: string;
    }) => {
      await archestraApiSdk.grantTeamMcpServerAccess({
        path: { catalogId },
        body: { teamIds, userId },
      });
    },
    onSuccess: async () => {
      // Wait for refetch to complete so UI updates immediately
      await queryClient.refetchQueries({
        queryKey: ["mcp-servers"],
        type: "active",
      });
      toast.success("Team access granted successfully");
    },
    onError: (error) => {
      console.error("Error granting team access:", error);
      toast.error("Failed to grant team access");
    },
  });
}

export function useRevokeTeamMcpServerAccess() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      serverId,
      teamId,
    }: {
      serverId: string;
      teamId: string;
    }) => {
      await archestraApiSdk.revokeTeamMcpServerAccess({
        path: { id: serverId, teamId },
      });
    },
    onSuccess: async () => {
      // Wait for refetch to complete so UI updates immediately
      await queryClient.refetchQueries({
        queryKey: ["mcp-servers"],
        type: "active",
      });
      toast.success("Team access revoked successfully");
    },
    onError: (error) => {
      console.error("Error revoking team access:", error);
      toast.error("Failed to revoke team access");
    },
  });
}

export function useRevokeAllTeamsMcpServerAccess() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ catalogId }: { catalogId: string }) => {
      await archestraApiSdk.revokeAllTeamsMcpServerAccess({
        path: { catalogId },
      });
    },
    onSuccess: async () => {
      // Wait for refetch to complete so UI updates immediately
      await queryClient.refetchQueries({
        queryKey: ["mcp-servers"],
        type: "active",
      });
      toast.success("Team token revoked successfully");
    },
    onError: (error) => {
      console.error("Error revoking team token:", error);
      toast.error("Failed to revoke team token");
    },
  });
}

export function useMcpServerTools(mcpServerId: string | null) {
  return useQuery({
    queryKey: ["mcp-servers", mcpServerId, "tools"],
    queryFn: async () => {
      if (!mcpServerId) return [];
      try {
        const response = await getMcpServerTools({ path: { id: mcpServerId } });
        return response.data ?? [];
      } catch (error) {
        console.error("Failed to fetch MCP server tools:", error);
        return [];
      }
    },
    enabled: !!mcpServerId,
  });
}

export function useMcpServerInstallationStatus(
  installingMcpServerId: string | null,
) {
  const queryClient = useQueryClient();
  return useQuery({
    queryKey: ["mcp-servers-installation-polling", installingMcpServerId],
    queryFn: async () => {
      if (!installingMcpServerId) {
        await queryClient.refetchQueries({ queryKey: ["mcp-servers"] });
        return "success";
      }
      const response = await getMcpServer({
        path: { id: installingMcpServerId },
      });
      const result = response.data?.localInstallationStatus ?? null;
      if (result === "success") {
        await queryClient.refetchQueries({
          queryKey: ["mcp-servers", installingMcpServerId],
        });
        toast.success(`Successfully installed server`);
      }
      return result;
    },
    refetchInterval: (query) => {
      const status = query.state.data;
      return status === "pending" ||
        status === "discovering-tools" ||
        status === null
        ? 2000
        : false;
    },
    enabled: !!installingMcpServerId,
  });
}

/**
 * Get MCP servers (tokens) available for use with specific agents' tools.
 * Filters based on team membership and admin status.
 *
 * @param agentIds - Array of agent IDs to filter tokens for. If null/empty, returns all servers.
 * @param catalogId - Optional catalog ID to further filter tokens.
 */
export function useAgentAvailableTokens(params: {
  agentIds: string[];
  catalogId: string;
}) {
  const { agentIds, catalogId } = params;

  return useQuery({
    queryKey: ["agent-available-tokens", { agentIds, catalogId }],
    queryFn: async () => {
      if (!agentIds || agentIds.length === 0) {
        // If no agentIds, fallback to fetching all servers
        const response = await getMcpServers({});
        const servers = response.data ?? [];
        return catalogId
          ? servers.filter((server) => server.catalogId === catalogId)
          : servers;
      }

      // Use dedicated endpoint when agentIds are provided
      const response = await getAgentAvailableTokens({
        query: {
          agentIds: agentIds.join(","),
          ...(catalogId ? { catalogId } : {}),
        },
      });
      return response.data ?? [];
    },
  });
}

export function useMcpServerLogs(mcpServerId: string | null) {
  return useQuery({
    queryKey: ["mcp-servers", mcpServerId, "logs"],
    queryFn: async () => {
      if (!mcpServerId) return null;
      try {
        const response = await getMcpServerLogs({
          path: { id: mcpServerId },
          query: { lines: 100 },
        });
        return response.data ?? null;
      } catch (error) {
        console.error("Failed to fetch MCP server logs:", error);
        throw error;
      }
    },
    enabled: !!mcpServerId,
    refetchOnWindowFocus: false,
    retry: false,
  });
}
