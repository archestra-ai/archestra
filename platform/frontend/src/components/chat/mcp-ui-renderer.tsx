"use client";

import { AppRenderer, type AppRendererProps } from "@mcp-ui/client";
import { useMemo } from "react";
import { ArchestraMcpClient } from "@/lib/mcp-client";

interface ChatMcpUiRendererProps {
  toolName: string;
  /** Input parameters provided to the tool */
  toolInput: Record<string, unknown>;
  /** 
   * The result returned from tool execution. 
   * Handled as unknown as tool results are dynamic objects whose structure 
   * depends on the specific tool being called.
   */
  toolResult: unknown;
  agentId?: string;
}

export function ChatMcpUiRenderer({
  toolName,
  toolInput,
  toolResult,
  agentId,
}: ChatMcpUiRendererProps) {
  const client = useMemo(() => {
    return new ArchestraMcpClient(agentId);
  }, [agentId]);

  return (
    <div className="border rounded-md my-2 overflow-hidden bg-background">
      <AppRenderer
        // ArchestraMcpClient fulfills the bridge interface for request handling.
        client={client as any}
        toolName={toolName}
        toolInput={toolInput}
        toolResult={toolResult as AppRendererProps["toolResult"]}
        onOpenLink={async ({ url }) => {
          window.open(url, "_blank");
          return {
            // Return empty result as requested by bridge spec
          };
        }}
        sandbox={{ url: new URL("about:blank") }}
        onMessage={async (params) => {
          console.log("MCP UI Message:", params);
          return {
            // Return empty result as requested by bridge spec
          };
        }}
      />
    </div>
  );
}
