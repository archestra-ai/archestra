import { useQuery } from "@tanstack/react-query";

/**
 * MCP Apps UI metadata for a tool.
 * Contains information needed to render the tool's MCP App.
 */
interface McpAppToolUiMeta {
  ui?: {
    resourceUri?: string;
    visibility?: string[];
    csp?: {
      connectDomains?: string[];
      resourceDomains?: string[];
      frameDomains?: string[];
    };
    permissions?: {
      camera?: Record<string, never>;
      microphone?: Record<string, never>;
      geolocation?: Record<string, never>;
      clipboardWrite?: Record<string, never>;
    };
    prefersBorder?: boolean;
  };
}

/**
 * Query key factory for MCP Apps
 */
const mcpAppsKeys = {
  toolMeta: (agentId: string) =>
    ["mcp-apps", "tool-meta", agentId] as const,
  resource: (agentId: string, uri: string) =>
    ["mcp-apps", "resource", agentId, uri] as const,
};

/**
 * Fetch MCP Apps metadata for an agent's tools.
 * Returns a map of tool name to _meta object for tools that support MCP Apps.
 */
async function fetchMcpAppsToolMeta(
  agentId: string,
): Promise<Record<string, McpAppToolUiMeta>> {
  try {
    const response = await fetch(`/api/mcp-apps/tools/${agentId}`);
    if (!response.ok) return {};
    return await response.json();
  } catch {
    return {};
  }
}

/**
 * React hook to fetch MCP Apps tool metadata for an agent.
 * Returns a map of tool name to MCP App UI metadata.
 */
export function useMcpAppsToolMeta(agentId?: string) {
  return useQuery({
    queryKey: mcpAppsKeys.toolMeta(agentId ?? ""),
    queryFn: () => fetchMcpAppsToolMeta(agentId!),
    enabled: Boolean(agentId),
    staleTime: 60 * 1000, // 1 minute
    gcTime: 5 * 60 * 1000,
  });
}

/**
 * Fetch MCP App UI resource content (HTML) from the backend.
 */
async function fetchMcpAppResource(params: {
  agentId: string;
  uri: string;
}): Promise<{
  uri: string;
  mimeType: string;
  text?: string;
  blob?: string;
} | null> {
  try {
    const response = await fetch("/api/mcp-apps/resource", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
    });

    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

/**
 * React hook to fetch an MCP App UI resource.
 * Only fetches when both agentId and uri are provided.
 */
export function useMcpAppResource(agentId?: string, uri?: string) {
  return useQuery({
    queryKey: mcpAppsKeys.resource(agentId ?? "", uri ?? ""),
    queryFn: () =>
      fetchMcpAppResource({ agentId: agentId!, uri: uri! }),
    enabled: Boolean(agentId && uri),
    staleTime: 5 * 60 * 1000, // 5 minutes
    gcTime: 10 * 60 * 1000,
  });
}
