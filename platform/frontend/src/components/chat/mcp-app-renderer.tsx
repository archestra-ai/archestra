"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { DynamicToolUIPart, ToolUIPart } from "ai";

// JSON-RPC message types for MCP App <-> Host communication
interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
}

type JsonRpcMessage = JsonRpcRequest | JsonRpcResponse | JsonRpcNotification;

interface MCPAppRendererProps {
  part: ToolUIPart | DynamicToolUIPart;
  toolResultPart: ToolUIPart | DynamicToolUIPart | null;
  toolName: string;
  agentId?: string;
}

const MIN_HEIGHT = 100;
const MAX_HEIGHT = 600;
const DEFAULT_HEIGHT = 300;

/**
 * MCPAppRenderer — Renders MCP App UIs in a sandboxed iframe.
 *
 * MCP Apps are MCP servers that return interactive HTML UIs as tool results.
 * They communicate with the host via postMessage JSON-RPC protocol.
 *
 * Protocol:
 * - Host sends `ui/initialize` with tool result data after iframe loads
 * - App can send `tools/call` to invoke other MCP tools
 * - App can send `ui/sendOpenLink` to open external URLs
 * - App can send `ui/updateContext` to update context data
 * - App can send resize requests
 *
 * @see https://modelcontextprotocol.io/docs/extensions/apps
 */
export function MCPAppRenderer({
  part,
  toolResultPart,
  toolName,
  agentId,
}: MCPAppRendererProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [iframeHeight, setIframeHeight] = useState(DEFAULT_HEIGHT);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const appHtml = extractAppHtml(toolResultPart);

  // Send JSON-RPC message to iframe
  const sendToIframe = useCallback((message: JsonRpcMessage) => {
    if (iframeRef.current?.contentWindow) {
      iframeRef.current.contentWindow.postMessage(message, "*");
    }
  }, []);

  // Handle JSON-RPC messages from iframe
  const handleMessage = useCallback(
    (event: MessageEvent) => {
      if (event.source !== iframeRef.current?.contentWindow) return;

      const msg = event.data as JsonRpcMessage;
      if (!msg || msg.jsonrpc !== "2.0") return;

      // Handle requests/notifications from the app
      if ("method" in msg) {
        switch (msg.method) {
          case "tools/call": {
            handleToolCall(msg as JsonRpcRequest);
            break;
          }
          case "ui/sendOpenLink": {
            const url = (msg.params as Record<string, unknown>)?.url;
            if (url && typeof url === "string") {
              try {
                const parsed = new URL(url);
                if (parsed.protocol === "https:") {
                  window.open(url, "_blank", "noopener,noreferrer");
                }
              } catch {
                // Invalid URL — ignore
              }
            }
            if ("id" in msg && msg.id != null) {
              sendToIframe({ jsonrpc: "2.0", id: msg.id, result: {} });
            }
            break;
          }
          case "ui/updateContext": {
            if ("id" in msg && msg.id != null) {
              sendToIframe({ jsonrpc: "2.0", id: msg.id, result: {} });
            }
            break;
          }
          case "ui/resize": {
            const height = (msg.params as Record<string, unknown>)?.height;
            if (typeof height === "number" && height > 0) {
              setIframeHeight(
                Math.min(Math.max(height, MIN_HEIGHT), MAX_HEIGHT),
              );
            }
            break;
          }
          default: {
            if ("id" in msg && msg.id != null) {
              sendToIframe({
                jsonrpc: "2.0",
                id: msg.id,
                error: {
                  code: -32601,
                  message: `Method not found: ${msg.method}`,
                },
              });
            }
          }
        }
      }
    },
    [sendToIframe],
  );

  // Handle proxied tool calls from the MCP App
  const handleToolCall = useCallback(
    async (request: JsonRpcRequest) => {
      try {
        const { name, arguments: args } = request.params as {
          name: string;
          arguments?: Record<string, unknown>;
        };

        const response = await fetch(`/api/agents/${agentId}/tools/call`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ toolName: name, input: args || {} }),
        });

        if (!response.ok) {
          throw new Error(`Tool call failed: ${response.statusText}`);
        }

        const result = await response.json();
        sendToIframe({ jsonrpc: "2.0", id: request.id, result });
      } catch (err) {
        sendToIframe({
          jsonrpc: "2.0",
          id: request.id,
          error: {
            code: -32603,
            message: err instanceof Error ? err.message : "Internal error",
          },
        });
      }
    },
    [agentId, sendToIframe],
  );

  // Listen for postMessage events
  useEffect(() => {
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [handleMessage]);

  // Send ui/initialize when iframe loads
  const handleIframeLoad = useCallback(() => {
    setIsLoading(false);

    sendToIframe({
      jsonrpc: "2.0",
      id: `init-${Date.now()}`,
      method: "ui/initialize",
      params: {
        toolName,
        toolCallId: (part as Record<string, unknown>)?.toolCallId,
        input: (part as Record<string, unknown>)?.input,
        output: toolResultPart
          ? (toolResultPart as Record<string, unknown>)?.output
          : undefined,
      },
    });
  }, [sendToIframe, toolName, part, toolResultPart]);

  if (!appHtml) {
    return null;
  }

  if (error) {
    return (
      <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-600 dark:border-red-800 dark:bg-red-950 dark:text-red-400">
        <p className="font-medium">MCP App Error</p>
        <p>{error}</p>
      </div>
    );
  }

  return (
    <div className="relative rounded-lg border border-border overflow-hidden">
      {isLoading && (
        <div className="absolute inset-0 flex items-center justify-center bg-muted/50 z-10">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <svg
              className="h-4 w-4 animate-spin"
              viewBox="0 0 24 24"
              fill="none"
            >
              <circle
                className="opacity-25"
                cx="12"
                cy="12"
                r="10"
                stroke="currentColor"
                strokeWidth="4"
              />
              <path
                className="opacity-75"
                fill="currentColor"
                d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
              />
            </svg>
            Loading MCP App...
          </div>
        </div>
      )}
      <iframe
        ref={iframeRef}
        srcDoc={appHtml}
        sandbox="allow-scripts allow-forms"
        style={{
          width: "100%",
          height: `${iframeHeight}px`,
          border: "none",
          display: "block",
        }}
        title={`MCP App: ${toolName}`}
        onLoad={handleIframeLoad}
        onError={() => setError("Failed to load MCP App")}
      />
    </div>
  );
}

/**
 * Detect whether a tool result contains MCP App HTML content.
 * Checks the tool result output for HTML content (text/html MIME type,
 * embedded resources, or raw HTML strings).
 */
export function hasMcpAppContent(
  toolResultPart: ToolUIPart | DynamicToolUIPart | null,
): boolean {
  return extractAppHtml(toolResultPart) !== undefined;
}

/**
 * Extract HTML content from a tool result that represents an MCP App UI.
 * MCP Apps return HTML content as tool results with specific MIME types.
 */
function extractAppHtml(
  toolResultPart: ToolUIPart | DynamicToolUIPart | null,
): string | undefined {
  if (!toolResultPart) return undefined;

  const output = (toolResultPart as Record<string, unknown>)?.output;
  if (!output) return undefined;

  // Case 1: Output is a content array (MCP standard format)
  if (Array.isArray(output)) {
    for (const item of output) {
      // Text content with HTML MIME type
      if (
        item.type === "text" &&
        item.mimeType?.startsWith("text/html") &&
        typeof item.text === "string"
      ) {
        return item.text;
      }
      // Resource content (embedded)
      if (item.type === "resource" && item.resource) {
        if (
          item.resource.mimeType?.startsWith("text/html") &&
          typeof item.resource.text === "string"
        ) {
          return item.resource.text;
        }
        // Base64-encoded blob
        if (
          item.resource.mimeType?.startsWith("text/html") &&
          typeof item.resource.blob === "string"
        ) {
          try {
            return atob(item.resource.blob);
          } catch {
            return undefined;
          }
        }
      }
    }
  }

  // Case 2: Output is a string that looks like HTML
  if (typeof output === "string" && output.trim().startsWith("<")) {
    return output;
  }

  // Case 3: Output is an object with html field
  if (
    typeof output === "object" &&
    output !== null &&
    "html" in output &&
    typeof (output as Record<string, unknown>).html === "string"
  ) {
    return (output as Record<string, unknown>).html as string;
  }

  return undefined;
}
