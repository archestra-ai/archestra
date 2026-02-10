import type { CallToolResult, ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";
import { useQuery } from "@tanstack/react-query";
import { handleApiError } from "./utils";

export type McpUiToolMeta = {
  name: string;
  // Raw MCP Tool._meta persisted in Archestra
  // biome-ignore lint/suspicious/noExplicitAny: MCP meta shape is dynamic
  meta: Record<string, any>;
};

export function useChatProfileMcpUiTools(agentId: string | undefined) {
  return useQuery({
    queryKey: ["chat", "agents", agentId, "mcp-ui", "tools"],
    queryFn: async (): Promise<McpUiToolMeta[]> => {
      if (!agentId) return [];

      const response = await fetch(`/api/chat/agents/${agentId}/mcp-ui/tools`, {
        method: "GET",
        credentials: "include",
      });

      if (!response.ok) {
        handleApiError({
          error: new Error(
            `Failed to fetch MCP UI tools: ${response.status} ${response.statusText}`,
          ),
        });
        return [];
      }

      // Backend wraps responses in constructResponseSchema ({ data, error })
      const json = (await response.json()) as {
        data?: McpUiToolMeta[];
        error?: unknown;
      };

      if (json.error) {
        handleApiError({ error: json.error as Error });
        return [];
      }

      return json.data ?? [];
    },
    enabled: !!agentId,
    staleTime: 5 * 60 * 1000,
    gcTime: 10 * 60 * 1000,
  });
}

export async function callMcpUiTool(params: {
  agentId: string;
  name: string;
  // biome-ignore lint/suspicious/noExplicitAny: Tool arguments are tool-specific
  arguments?: Record<string, any>;
  conversationId?: string;
}): Promise<CallToolResult> {
  const response = await fetch(
    `/api/chat/agents/${params.agentId}/mcp-ui/tools/call`,
    {
      method: "POST",
      credentials: "include",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        name: params.name,
        arguments: params.arguments ?? {},
        conversationId: params.conversationId,
      }),
    },
  );

  if (!response.ok) {
    throw new Error(
      `Failed to call MCP tool: ${response.status} ${response.statusText}`,
    );
  }

  const json = (await response.json()) as {
    data?: CallToolResult;
    error?: unknown;
  };

  if (json.error) {
    throw new Error(
      json.error instanceof Error ? json.error.message : JSON.stringify(json.error),
    );
  }

  return json.data ?? ({ content: [], isError: true } as CallToolResult);
}

export async function readMcpUiResource(params: {
  agentId: string;
  uri: string;
}): Promise<ReadResourceResult> {
  const response = await fetch(
    `/api/chat/agents/${params.agentId}/mcp-ui/resources/read`,
    {
      method: "POST",
      credentials: "include",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({ uri: params.uri }),
    },
  );

  if (!response.ok) {
    throw new Error(
      `Failed to read MCP resource: ${response.status} ${response.statusText}`,
    );
  }

  const json = (await response.json()) as {
    data?: ReadResourceResult;
    error?: unknown;
  };

  if (json.error) {
    throw new Error(
      json.error instanceof Error ? json.error.message : JSON.stringify(json.error),
    );
  }

  return json.data ?? ({ contents: [] } as ReadResourceResult);
}
