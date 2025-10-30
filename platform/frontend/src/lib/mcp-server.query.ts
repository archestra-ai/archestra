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
  getMcpServerInstallationStatus,
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
      data: archestraApiTypes.InstallMcpServerData["body"],
    ) => {
      const { data: installedServer } = await installMcpServer({ body: data });
      return installedServer;
    },
    onSuccess: (installedServer, variables) => {
      queryClient.invalidateQueries({ queryKey: ["mcp-servers"] });
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
      toast.success(`Successfully installed ${variables.name}`);
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
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ["mcp-servers"] });
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
  mcpServerId: string | null,
  options?: {
    enabled?: boolean;
    onSuccess?: (status: "idle" | "pending" | "success" | "error") => void;
    onError?: () => void;
  },
) {
  return useQuery({
    queryKey: ["mcp-servers", mcpServerId, "installation-status"],
    queryFn: async () => {
      if (!mcpServerId) return null;
      try {
        const response = await getMcpServerInstallationStatus({
          path: { id: mcpServerId },
        });
        return response.data;
      } catch (error) {
        console.error("Failed to fetch installation status:", error);
        return null;
      }
    },
    enabled: !!mcpServerId && (options?.enabled ?? true),
    refetchInterval: (query) => {
      const status = query.state.data?.localInstallationStatus;
      // Stop polling once we reach a terminal state (success or error)
      if (status === "success" || status === "error") {
        // When installation completes, invalidate relevant queries
        if (status === "success") {
          queryClient.invalidateQueries({ queryKey: ["mcp-servers"] });
          queryClient.invalidateQueries({ queryKey: ["tools"] });
          queryClient.invalidateQueries({ queryKey: ["tools", "unassigned"] });
          queryClient.invalidateQueries({ queryKey: ["agent-tools"] });
          if (mcpServerId) {
            queryClient.invalidateQueries({
              queryKey: ["mcp-servers", mcpServerId, "tools"],
            });
          }
          options?.onSuccess?.(status);
        } else if (status === "error") {
          options?.onError?.();
        }
        return false;
      }

      if (status === "error") {
        options?.onError?.();
        return false; // Stop polling
      }

      // Poll every 5 seconds while installation is pending
      return status === "pending" ? 5000 : false;
    },
    // Disable automatic retries to prevent excessive requests on errors
    retry: false,
    // Reduce stale time to prevent unnecessary refetches
    staleTime: 4000,
    // Prevent refetching on window focus or mount
    refetchOnWindowFocus: false,
    refetchOnMount: false,
    refetchOnReconnect: false,
  });
}
