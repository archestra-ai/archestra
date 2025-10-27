import {
  useMutation,
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { toast } from "sonner";
import {
  deleteMcpServer,
  type GetMcpServersResponses,
  getMcpServers,
  getMcpServerTools,
  type InstallMcpServerData,
  installMcpServer,
} from "@/lib/clients/api";

export function useMcpServers(params?: {
  initialData?: GetMcpServersResponses["200"];
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
    mutationFn: async (data: InstallMcpServerData["body"]) => {
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
