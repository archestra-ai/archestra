import { archestraApiSdk, type archestraApiTypes } from "@shared";
import {
  useMutation,
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { toast } from "sonner";

const { deleteMcpServer, getMcpServers, getMcpServerTools, installMcpServer } =
  archestraApiSdk;

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
    onSuccess: async (installedServer, variables) => {
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
