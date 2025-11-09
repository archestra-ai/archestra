"use client";

import { McpConnectionInstructions } from "@/components/mcp-connection-instructions";
import { ProxyConnectionInstructions } from "@/components/proxy-connection-instructions";

interface ConnectionOptionsProps {
  agentId?: string;
}

export function ConnectionOptions({ agentId }: ConnectionOptionsProps) {
  return (
    <div>
      <h3 className="font-medium mb-4">Connection Options</h3>
      <div className="grid grid-cols-2 gap-6">
        <div className="space-y-3">
          <div className="flex items-center gap-2 pb-2 border-b">
            <h3 className="font-medium">LLM Proxy</h3>
            <h4 className="text-sm text-muted-foreground">
              For security, observibility and enabling tools
            </h4>
          </div>
          <ProxyConnectionInstructions />
        </div>
        <div className="space-y-3">
          <div className="flex items-center gap-2 pb-2 border-b">
            <h3 className="font-medium">MCP Gateway</h3>
            <h4 className="text-sm text-muted-foreground">
              To enable tools for the agent
            </h4>
          </div>
          {agentId && <McpConnectionInstructions agentId={agentId} />}
        </div>
      </div>
    </div>
  );
}
