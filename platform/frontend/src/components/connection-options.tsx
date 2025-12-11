"use client";

import { McpConnectionInstructions } from "@/components/mcp-connection-instructions";
import { ProxyConnectionInstructions } from "@/components/proxy-connection-instructions";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

interface ConnectionOptionsProps {
  agentId?: string;
}

export function ConnectionOptions({ agentId }: ConnectionOptionsProps) {
  return (
    <div>
      <h3 className="font-medium mb-4">Connection Options</h3>
      <Tabs defaultValue="llm-proxy" className="w-full">
        <TabsList className="grid w-full grid-cols-2">
          <TabsTrigger value="llm-proxy">LLM Proxy</TabsTrigger>
          <TabsTrigger value="mcp-gateway">MCP Gateway</TabsTrigger>
        </TabsList>
        <TabsContent value="llm-proxy" className="space-y-4 pt-4">
          <p className="text-sm text-muted-foreground">
            For security, observability, and enabling tools
          </p>
          <ProxyConnectionInstructions />
        </TabsContent>
        <TabsContent value="mcp-gateway" className="space-y-4 pt-4">
          <p className="text-sm text-muted-foreground">
            Connect directly to the MCP Gateway to use tools for this profile
          </p>
          {agentId && <McpConnectionInstructions agentId={agentId} />}
        </TabsContent>
      </Tabs>
    </div>
  );
}
