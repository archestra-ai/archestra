import { archestraApiSdk, type archestraApiTypes } from "@shared";
import {
  useMutation,
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { useMemo } from "react";
import { toast } from "sonner";
import { authClient } from "./clients/auth/auth-client";

const {
  deleteMcpServer,
  getMcpServers,
  getMcpServerTools,
  installMcpServer,
  getMcpServer,
  getMcpServerLogs,
  restartMcpServer,
  restartAllMcpServerInstallations,
} = archestraApiSdk;

export function useMcpServers(params?: {
  initialData?: archestraApiTypes.GetMcpServersResponses["200"];
  hasInstallingServers?: boolean;
  catalogId?: string;
}) {
  return useSuspenseQuery({
    // Include catalogId in queryKey only when provided to maintain cache separation
    queryKey: params?.catalogId
      ? ["mcp-servers", { catalogId: params.catalogId }]
      : ["mcp-servers"],
    queryFn: async () => {
      const response = await getMcpServers({
        query: params?.catalogId ? { catalogId: params.catalogId } : undefined,
      });
      return response.data ?? [];
    },
    initialData: params?.initialData,
    refetchInterval: params?.hasInstallingServers ? 2000 : false,
  });
}

/**
 * Get MCP servers grouped by catalogId with current user's credentials first.
 * Used for credential/installation selection in tool configuration.
 *
 * @param catalogId - Optional catalog ID to filter. If provided, only returns servers for that catalog.
 */
export function useMcpServersGroupedByCatalog(params?: { catalogId?: string }) {
  const { data: servers } = useMcpServers({ catalogId: params?.catalogId });
  const { data: session } = authClient.useSession();
  const currentUserId = session?.user?.id;

  return useMemo(() => {
    if (!servers) return {};

    // Filter out servers without catalogId
    const withCatalog = servers.filter(
      (s): s is typeof s & { catalogId: string } => !!s.catalogId,
    );

    // Sort: current user's credentials first
    const sorted = [...withCatalog].sort((a, b) => {
      const aIsOwner = a.ownerId === currentUserId ? 1 : 0;
      const bIsOwner = b.ownerId === currentUserId ? 1 : 0;
      return bIsOwner - aIsOwner;
    });

    // Group by catalogId
    return sorted.reduce(
      (acc, server) => {
        const key = server.catalogId;
        if (!acc[key]) acc[key] = [];
        acc[key].push(server);
        return acc;
      },
      {} as Record<string, typeof servers>,
    );
  }, [servers, currentUserId]);
}

export function useInstallMcpServer() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (
      data: archestraApiTypes.InstallMcpServerData["body"] & {
        dontShowToast?: boolean;
      },
    ) => {
      const { data: installedServer, error } = await installMcpServer({
        body: data,
      });
      if (error) {
        const msg =
          typeof error.error === "string"
            ? error.error
            : error.error?.message || "Unknown error";
        toast.error(msg);
      }
      return { installedServer, dontShowToast: data.dontShowToast };
    },
    onSuccess: async ({ installedServer, dontShowToast }, variables) => {
      // Show success toast for remote servers (local servers show toast after async tool fetch completes)
      if (!dontShowToast && installedServer) {
        toast.success(`Successfully installed ${variables.name}`);
      }
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
      // Invalidate all chat MCP tools (new tools may be available)
      queryClient.invalidateQueries({ queryKey: ["chat", "agents"] });
    },
    onError: (_error, variables) => {
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
      // Invalidate all chat MCP tools (tools are now unavailable)
      queryClient.invalidateQueries({ queryKey: ["chat", "agents"] });
      toast.success(`Successfully uninstalled ${variables.name}`);
    },
    onError: (error, variables) => {
      console.error("Uninstall error:", error);
      toast.error(`Failed to uninstall ${variables.name}`);
    },
  });
}

export function useRestartMcpServer() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (data: { id: string; name: string }) => {
      const response = await restartMcpServer({ path: { id: data.id } });
      return response.data;
    },
    onSuccess: async (_, variables) => {
      await queryClient.refetchQueries({ queryKey: ["mcp-servers"] });
      toast.success(`Successfully restarted ${variables.name}`);
    },
    onError: (_error, variables) => {
      toast.error(`Failed to restart ${variables.name}`);
    },
  });
}

export function useRestartAllMcpServerInstallations() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (data: { catalogId: string; name: string }) => {
      const response = await restartAllMcpServerInstallations({
        path: { catalogId: data.catalogId },
      });
      return response.data;
    },
    onSuccess: async (result, variables) => {
      await queryClient.refetchQueries({ queryKey: ["mcp-servers"] });
      if (result?.summary) {
        const { succeeded, failed, total } = result.summary;
        if (failed === 0) {
          toast.success(
            `Successfully restarted all ${succeeded} installation(s) of ${variables.name}`,
          );
        } else {
          toast.warning(
            `Restarted ${succeeded}/${total} installation(s) of ${variables.name}, ${failed} failed`,
          );
        }
      }
    },
    onError: (_error, variables) => {
      toast.error(`Failed to restart installations of ${variables.name}`);
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
      if (result === "error") {
        await queryClient.refetchQueries({ queryKey: ["mcp-servers"] });
        toast.error("Failed to install server");
      }
      return result;
    },
    throwOnError: false,
    refetchInterval: (query) => {
      const status = query.state.data;
      return (
        !query.state.error &&
        (status === "pending" ||
        status === "discovering-tools" ||
        status === null
          ? 2000
          : false)
      );
    },
    enabled: !!installingMcpServerId,
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
