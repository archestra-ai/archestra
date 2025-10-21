import { useInfiniteQuery, useQuery } from "@tanstack/react-query";

// Official MCP Registry API response types
// Based on https://registry.modelcontextprotocol.io/docs#/operations/list-servers-v0.1
interface McpServerApiResponse {
  server: {
    name: string;
    description?: string;
    repository?: {
      url?: string;
      source?: string;
    };
    version?: string;
    vendor?: string;
    homepage?: string;
  };
  _meta?: {
    "io.modelcontextprotocol.registry/official"?: {
      status?: string;
      publishedAt?: string;
      updatedAt?: string;
      isLatest?: boolean;
    };
  };
}

interface McpRegistryApiResponse {
  servers: McpServerApiResponse[];
  metadata: {
    nextCursor?: string;
    count: number;
  };
}

export interface McpServer {
  id: string;
  name: string;
  description?: string;
  author?: string;
  homepage?: string;
  repository?: string;
  categories?: string[];
  tags?: string[];
  version?: string;
  license?: string;
  createdAt?: string;
  updatedAt?: string;
  sourceUrl?: string;
  vendor?: string;
}

function transformMcpServer(
  item: McpServerApiResponse,
  index: number,
): McpServer {
  const server = item.server;
  const meta = item._meta?.["io.modelcontextprotocol.registry/official"];

  return {
    id: server.name || `server-${index}`,
    name: server.name,
    description: server.description,
    author: server.vendor,
    homepage: server.homepage,
    repository: server.repository?.url,
    version: server.version,
    createdAt: meta?.publishedAt,
    updatedAt: meta?.updatedAt,
    vendor: server.vendor,
    sourceUrl: server.repository?.url,
  };
}

// Fetch all servers from the official MCP Registry API
// Uses Next.js rewrites to proxy the request and avoid CORS issues
export function useMcpRegistryServers() {
  return useQuery({
    queryKey: ["mcp-registry-external", "servers"],
    queryFn: async (): Promise<McpServer[]> => {
      const response = await fetch("/api/mcp-registry-proxy");
      if (!response.ok) {
        throw new Error(
          `Failed to fetch MCP servers: ${response.status} ${response.statusText}`,
        );
      }
      const data: McpRegistryApiResponse = await response.json();

      // Transform the API response to our interface
      return data.servers.map(transformMcpServer);
    },
  });
}

// Fetch servers with infinite scroll pagination support
export function useMcpRegistryServersInfinite(search?: string, limit = 30) {
  return useInfiniteQuery({
    queryKey: ["mcp-registry-external", "servers-infinite", search, limit],
    queryFn: async ({ pageParam }): Promise<McpRegistryApiResponse> => {
      const params = new URLSearchParams();
      if (pageParam) {
        params.append("cursor", pageParam);
      }
      if (search?.trim()) {
        params.append("search", search.trim());
      }
      params.append("limit", limit.toString());

      const url = `/api/mcp-registry-proxy?${params.toString()}`;
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(
          `Failed to fetch MCP servers: ${response.status} ${response.statusText}`,
        );
      }
      return await response.json();
    },
    getNextPageParam: (lastPage) => lastPage.metadata.nextCursor ?? undefined,
    initialPageParam: undefined as string | undefined,
  });
}
