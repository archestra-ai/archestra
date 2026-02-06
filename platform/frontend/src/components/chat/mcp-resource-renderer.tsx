"use client";

import { AppRenderer } from "@mcp-ui/client";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Loader2Icon, AlertCircleIcon } from "lucide-react";
import { useEffect, useState, useMemo } from "react";
import { useUserTokenValue } from "@/lib/user-token.query";
import { Button } from "@/components/ui/button";

interface MCPResourceRendererProps {
  uri: string;
  agentId: string;
  toolName: string;
  toolInput: any;
  toolResult: any;
}

export function MCPResourceRenderer({
  uri,
  agentId,
  toolName,
  toolInput,
  toolResult,
}: MCPResourceRendererProps) {
  const { data: tokenData, isLoading: isLoadingToken, refetch: fetchToken } = useUserTokenValue();
  const [client, setClient] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [isConnecting, setIsConnecting] = useState(false);

  // Auto-fetch token on mount
  useEffect(() => {
    if (!tokenData?.value) {
      fetchToken();
    }
  }, [fetchToken, tokenData?.value]);

  useEffect(() => {
    if (!tokenData?.value || !agentId || client || isConnecting) return;

    setIsConnecting(true);
    setError(null);

    const transport = new StreamableHTTPClientTransport(
      new URL(`${window.location.origin}/v1/mcp/${agentId}`),
      {
        requestInit: {
          headers: {
            Authorization: `Bearer ${tokenData.value}`,
          },
        },
      }
    );

    const mcpClient = new Client(
      { name: "archestra-frontend", version: "1.0.0" },
      { capabilities: {} }
    );

    mcpClient
      .connect(transport)
      .then(() => {
        setClient(mcpClient);
        setIsConnecting(false);
      })
      .catch((err: unknown) => {
        console.error("[MCP-UI] Connection failed:", err);
        setError("Failed to connect to MCP gateway");
        setIsConnecting(false);
      });

    return () => {
      mcpClient.close().catch(() => {});
    };
  }, [agentId, tokenData?.value, client, isConnecting]);

  if (error) {
    return (
      <div className="p-4 border border-destructive/20 rounded-lg bg-destructive/5 my-2 flex items-center gap-3">
        <AlertCircleIcon className="size-5 text-destructive" />
        <div className="flex-1 text-sm text-destructive">{error}</div>
        <Button size="sm" variant="outline" onClick={() => { setClient(null); setIsConnecting(false); }}>
          Retry
        </Button>
      </div>
    );
  }

  if (!client || isLoadingToken) {
    return (
      <div className="p-8 border rounded-lg bg-muted/30 my-2 flex flex-col items-center justify-center gap-3 animate-pulse">
        <Loader2Icon className="size-6 text-muted-foreground animate-spin" />
        <div className="text-xs text-muted-foreground uppercase tracking-widest font-medium">
          Initializing UI...
        </div>
      </div>
    );
  }

  return (
    <div className="border rounded-lg bg-background my-2 overflow-hidden shadow-sm">
      <AppRenderer
        client={client}
        toolName={toolName}
        toolInput={toolInput}
        toolResult={toolResult}
        // Use the built-in Archestra canvas host for sandboxing if available, 
        // or a safe default.
        sandbox={{ url: new URL(`${window.location.origin}/__openclaw__/canvas/`) }}
        onOpenLink={async ({ url }) => {
          window.open(url, "_blank");
          return { success: true };
        }}
      />
    </div>
  );
}
