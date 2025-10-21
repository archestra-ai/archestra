import {
  useInfiniteQuery,
  useQuery,
  useSuspenseQuery,
} from "@tanstack/react-query";
import {
  getServerVersionsV01,
  getServerVersionV01,
  listServersV01,
  type ServerListResponse,
  type ServerResponse,
} from "./clients/mcp-registry";

// Fetch all servers from the official MCP Registry API
export function useMcpRegistryServers() {
  return useSuspenseQuery({
    queryKey: ["mcp-registry-external", "servers"],
    queryFn: async (): Promise<ServerListResponse> => {
      const response = await listServersV01();
      if (!response.data) {
        throw new Error("No data returned from MCP registry");
      }
      return response.data;
    },
  });
}

// Fetch servers with infinite scroll pagination support
// By default, fetches only the latest version of each server
export function useMcpRegistryServersInfinite(search?: string, limit = 50) {
  return useInfiniteQuery({
    queryKey: ["mcp-registry-external", "servers-infinite", search, limit],
    queryFn: async ({ pageParam }): Promise<ServerListResponse> => {
      const response = await listServersV01({
        query: {
          cursor: pageParam,
          search: search?.trim(),
          limit,
          version: "latest", // Only fetch latest versions to avoid duplicates
        },
      });
      if (!response.data) {
        throw new Error("No data returned from MCP registry");
      }
      return response.data;
    },
    getNextPageParam: (lastPage) => lastPage.metadata.nextCursor ?? undefined,
    initialPageParam: undefined as string | undefined,
  });
}

// Fetch all versions for a specific server (for version dropdown)
export function useMcpServerVersions(serverName: string | null) {
  return useQuery({
    queryKey: ["mcp-registry-external", "server-versions", serverName],
    queryFn: async (): Promise<ServerListResponse> => {
      if (!serverName) {
        throw new Error("Server name is required");
      }
      const response = await getServerVersionsV01({
        path: { serverName },
      });
      if (!response.data) {
        throw new Error(`No versions found for server: ${serverName}`);
      }
      return response.data;
    },
    enabled: !!serverName, // Only fetch when serverName is provided
  });
}

// Fetch a specific version of a server
export function useMcpServerVersion(
  serverName: string | null,
  version: string | null,
) {
  return useQuery({
    queryKey: ["mcp-registry-external", "server-version", serverName, version],
    queryFn: async (): Promise<ServerResponse> => {
      if (!serverName || !version) {
        throw new Error("Server name and version are required");
      }
      const response = await getServerVersionV01({
        path: { serverName, version },
      });
      if (!response.data) {
        throw new Error(
          `Version ${version} not found for server: ${serverName}`,
        );
      }
      return response.data;
    },
    enabled: !!serverName && !!version, // Only fetch when both are provided
  });
}
