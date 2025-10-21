import { useInfiniteQuery, useSuspenseQuery } from "@tanstack/react-query";
import {
  listServersV01,
  type ServerListResponse,
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
export function useMcpRegistryServersInfinite(search?: string, limit = 30) {
  return useInfiniteQuery({
    queryKey: ["mcp-registry-external", "servers-infinite", search, limit],
    queryFn: async ({ pageParam }): Promise<ServerListResponse> => {
      const response = await listServersV01({
        query: {
          cursor: pageParam,
          search: search?.trim(),
          limit,
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
