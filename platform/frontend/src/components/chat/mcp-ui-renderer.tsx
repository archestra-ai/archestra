"use client";

// @ts-expect-error - potentially missing types until pnpm finishes
import { AppRenderer } from "@mcp-ui/client";
import { useMemo } from "react";

interface MCPUIRendererProps {
  resourceUri: string;
  agentId?: string;
  input?: Record<string, unknown>;
  output?: unknown;
}

/**
 * Minimal MCP client proxy for AppRenderer
 */
class McpProxyClient {
  constructor(private agentId?: string) {}

  async readResource(params: { uri: string }) {
    const query = new URLSearchParams({
      uri: params.uri,
    });
    if (this.agentId) {
      query.append("agentId", this.agentId);
    }

    const response = await fetch(
      `/api/mcp_server/resource?${query.toString()}`,
    );
    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.message || "Failed to read resource");
    }

    return response.json();
  }
}

export function MCPUIRenderer({
  resourceUri,
  agentId,
  input,
  output,
}: MCPUIRendererProps) {
  const client = useMemo(() => new McpProxyClient(agentId), [agentId]);

  return (
    <div className="mcp-ui-container my-2 overflow-hidden rounded-xl border bg-background shadow-sm transition-all hover:shadow-md">
      <AppRenderer
        resourceUri={resourceUri}
        // biome-ignore lint/suspicious/noExplicitAny: External library missing types
        client={client as any}
        initialData={{ input, output }}
        sandbox={{
          url: process.env.NEXT_PUBLIC_SANDBOX_URL || "http://localhost:3001",
        }}
      />
    </div>
  );
}
