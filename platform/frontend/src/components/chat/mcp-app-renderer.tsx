import { AppRenderer } from "@mcp-ui/client";
import { useEffect, useState } from "react";

interface McpAppRendererProps {
  toolName: string;
  toolInput: Record<string, unknown>;
  toolResult: unknown;
  resourceUri: string;
  agentId: string;
  conversationId?: string;
}

/**
 * Renders MCP App UI in a sandboxed iframe using @mcp-ui/client's AppRenderer.
 * 
 * This component:
 * 1. Fetches the UI HTML from the MCP server via resources/read
 * 2. Renders it in a sandboxed iframe using AppRenderer
 * 3. Handles bidirectional communication between the app and host
 */
export function McpAppRenderer({
  toolName,
  toolInput,
  toolResult,
  resourceUri,
  agentId,
  conversationId,
}: McpAppRendererProps) {
  const [uiHtml, setUiHtml] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  // Fetch UI HTML from MCP server
  useEffect(() => {
    const fetchUiHtml = async () => {
      try {
        setIsLoading(true);
        setError(null);

        // Call backend API to fetch the UI resource via MCP Gateway
        const response = await fetch("/api/mcp/resources/read", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            agentId,
            conversationId,
            resourceUri,
          }),
        });

        if (!response.ok) {
          throw new Error(`Failed to fetch UI resource: ${response.statusText}`);
        }

        const data = await response.json();
        
        // Extract HTML content from MCP resource response
        // MCP resources/read returns { contents: [{ uri, mimeType, text }] }
        const htmlContent = data.contents?.[0]?.text;
        
        if (!htmlContent) {
          throw new Error("No HTML content in resource response");
        }

        setUiHtml(htmlContent);
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        console.error("Failed to fetch MCP App UI:", { toolName, resourceUri, error: err });
        setError(errorMessage);
      } finally {
        setIsLoading(false);
      }
    };

    fetchUiHtml();
  }, [resourceUri, agentId, conversationId, toolName]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center p-4 border rounded-lg bg-muted/50">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <div className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
          Loading MCP App UI...
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-4 border border-destructive/50 rounded-lg bg-destructive/10">
        <div className="text-sm text-destructive">
          <strong>Failed to load MCP App UI:</strong> {error}
        </div>
      </div>
    );
  }

  if (!uiHtml) {
    return null;
  }

  return (
    <div className="border rounded-lg overflow-hidden bg-background">
      <AppRenderer
        html={uiHtml}
        context={{
          toolName,
          toolInput,
          toolResult,
        }}
        onMessage={(message) => {
          // Handle messages from the app (e.g., tool invocations, state updates)
          console.debug("Received message from MCP App:", { toolName, message });
          // TODO: Implement message handling if needed (e.g., trigger tool calls)
        }}
        sandbox={{
          // Security: restrict iframe capabilities
          allow: "scripts",
          // Prevent navigation, forms, popups, etc.
          disallow: ["navigation", "forms", "popups", "modals"],
        }}
        style={{
          width: "100%",
          minHeight: "400px",
          border: "none",
        }}
      />
    </div>
  );
}
