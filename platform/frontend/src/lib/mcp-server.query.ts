import { archestraApiSdk, type archestraApiTypes } from "@shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { toast } from "sonner";
import { invalidateToolAssignmentQueries } from "./agent-tools.hook";
import { authClient } from "./clients/auth/auth-client";
import { handleApiError } from "./utils";

const {
  deleteMcpServer,
  getMcpServers,
  getMcpServerTools,
  installMcpServer,
  getMcpServer,
  reauthenticateMcpServer,
  reinstallMcpServer,
} = archestraApiSdk;

export function useMcpServers(params?: {
  initialData?: archestraApiTypes.GetMcpServersResponses["200"];
  hasInstallingServers?: boolean;
  catalogId?: string;
}) {
  return useQuery({
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
        handleApiError(error);
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
      // Invalidate catalog tools query so the manage-tools dialog shows discovered tools
      if (variables.catalogId) {
        queryClient.invalidateQueries({
          queryKey: ["mcp-catalog", variables.catalogId, "tools"],
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
      // Invalidate all tool assignment queries (tools, agent-tools, chat, etc.)
      invalidateToolAssignmentQueries(queryClient);
      toast.success(`Successfully uninstalled ${variables.name}`);
    },
    onError: (error, variables) => {
      console.error("Uninstall error:", error);
      toast.error(`Failed to uninstall ${variables.name}`);
    },
  });
}

export function useMcpServerTools(mcpServerId: string | null) {
  return useQuery({
    queryKey: ["mcp-servers", mcpServerId, "tools"],
    queryFn: async () => {
      if (!mcpServerId) return [];
      const { data, error } = await getMcpServerTools({
        path: { id: mcpServerId },
      });
      if (error) {
        // handleApiError not used to prevent "MCP server not found" error from being shown
        console.error("Failed to fetch MCP server tools:", error);
        return [];
      }
      return data ?? [];
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

export function useReauthenticateMcpServer() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (data: {
      id: string;
      secretId: string;
      name: string;
    }) => {
      const response = await reauthenticateMcpServer({
        path: { id: data.id },
        body: { secretId: data.secretId },
      });
      return response.data;
    },
    onSuccess: async (_, variables) => {
      await queryClient.refetchQueries({ queryKey: ["mcp-servers"] });
      toast.success(`Successfully re-authenticated ${variables.name}`);
    },
    onError: (_error, variables) => {
      toast.error(`Failed to re-authenticate ${variables.name}`);
    },
  });
}

/**
 * Reinstall an MCP server without losing tool assignments and policies.
 * This is used when a catalog item is edited and requires manual reinstall
 * (e.g., when new prompted env vars were added).
 */
export function useReinstallMcpServer() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (data: {
      id: string;
      name: string;
      environmentValues?: Record<string, string>;
      isByosVault?: boolean;
      serviceAccount?: string;
    }) => {
      const { id, name, ...body } = data;
      const response = await reinstallMcpServer({
        path: { id },
        body,
      });
      if (response.error) {
        handleApiError(response.error);
        return null;
      }
      return { data: response.data, name };
    },
    onSuccess: async (_result, variables) => {
      // Refetch servers to get updated status (will show "pending" initially)
      await queryClient.refetchQueries({ queryKey: ["mcp-servers"] });
      // Invalidate tools queries since tools may have been synced
      queryClient.invalidateQueries({ queryKey: ["tools"] });
      queryClient.invalidateQueries({ queryKey: ["tools", "unassigned"] });
      queryClient.invalidateQueries({ queryKey: ["agent-tools"] });
      // Invalidate catalog tools query
      if (variables.id) {
        queryClient.invalidateQueries({
          queryKey: ["mcp-servers", variables.id, "tools"],
        });
      }
      // Note: No success toast here - the progress bar provides feedback
      // Success toast is shown when polling detects status changed to "success"
    },
  });
}
