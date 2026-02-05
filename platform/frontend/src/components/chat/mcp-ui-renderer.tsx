"use client";

import { AppRenderer } from "@mcp-ui/client";
import { useMemo } from "react";
import { ArchestraMcpClient } from "@/lib/mcp-client";

interface ChatMcpUiRendererProps {
  toolName: string;
  // biome-ignore lint/suspicious/noExplicitAny: Tool input is dynamic
  toolInput: any;
  // biome-ignore lint/suspicious/noExplicitAny: Tool result is dynamic
  toolResult: any;
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
        client={client}
        toolName={toolName}
        toolInput={toolInput}
        toolResult={toolResult}
        // biome-ignore lint/suspicious/noExplicitAny: library types are strict
        onOpenLink={async ({ url }) => {
          window.open(url, "_blank");
          return {} as any;
        }}
        // biome-ignore lint/suspicious/noExplicitAny: library types are strict
        onMessage={async (params) => {
          console.log("MCP UI Message:", params);
          return {} as any;
        }}
      />
    </div>
  );
}
