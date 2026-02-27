"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useOrgTheme } from "@/lib/theme.hook";

/** Props for a single MCP App inline iframe. */
export interface McpAppIframeProps {
  /** The `ui://` resource URI declared by the MCP tool. */
  resourceUri: string;
  /** Agent (profile) ID — used for the backend proxy. */
  agentId: string;
  /** Slugified tool name (e.g., "excalidraw__create_drawing"). */
  toolName: string;
  /** Tool input parameters (forwarded to the iframe as `ui/notifications/tool-input`). */
  toolInput?: unknown;
  /** Tool output / result (forwarded as `ui/notifications/tool-result`). */
  toolOutput?: unknown;
  /** Current tool state from the streaming pipeline. */
  toolState?: string;
  /** Optional metadata from `_meta.ui` (border preference, etc.). */
  uiMeta?: {
    prefersBorder?: boolean;
  };
}

/** JSON-RPC 2.0 message shape. */
interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: string | number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

/**
 * MCP App iframe renderer.
 *
 * Renders a sandboxed `<iframe>` that loads an MCP App HTML resource from
 * the backend proxy (`/api/mcp-app/resource`). Implements the JSON-RPC 2.0
 * postMessage bridge defined by SEP-1865.
 */
export function McpAppIframe({
  resourceUri,
  agentId,
  toolName,
  toolInput,
  toolOutput,
  toolState: _toolState,
  uiMeta,
}: McpAppIframeProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [isInitialized, setIsInitialized] = useState(false);
  const [displayMode, setDisplayMode] = useState<"inline" | "modal" | "panel">(
    "inline",
  );
  const [iframeHeight, setIframeHeight] = useState(400);
  const [loadError, setLoadError] = useState<string | null>(null);
  const { currentUITheme } = useOrgTheme();

  // Build the proxy URL for the iframe src
  const iframeSrc = `/api/mcp-app/resource?uri=${encodeURIComponent(resourceUri)}&agentId=${encodeURIComponent(agentId)}`;

  // Resolve the expected origin for postMessage validation
  const expectedOrigin =
    typeof window !== "undefined" ? window.location.origin : "";

  /** Send a JSON-RPC notification (no id) to the iframe. */
  const sendNotification = useCallback(
    (method: string, params: unknown) => {
      if (!iframeRef.current?.contentWindow || !isInitialized) return;
      const msg: JsonRpcMessage = { jsonrpc: "2.0", method, params };
      iframeRef.current.contentWindow.postMessage(msg, expectedOrigin);
    },
    [isInitialized, expectedOrigin],
  );

  /** Send a JSON-RPC response to a request from the iframe. */
  const sendResponse = useCallback(
    (id: string | number, result: unknown) => {
      if (!iframeRef.current?.contentWindow) return;
      const msg: JsonRpcMessage = { jsonrpc: "2.0", id, result };
      iframeRef.current.contentWindow.postMessage(msg, expectedOrigin);
    },
    [expectedOrigin],
  );

  /** Send a JSON-RPC error response. */
  const sendError = useCallback(
    (id: string | number, code: number, message: string) => {
      if (!iframeRef.current?.contentWindow) return;
      const msg: JsonRpcMessage = {
        jsonrpc: "2.0",
        id,
        error: { code, message },
      };
      iframeRef.current.contentWindow.postMessage(msg, expectedOrigin);
    },
    [expectedOrigin],
  );

  // Handle incoming postMessage from the iframe
  useEffect(() => {
    const handler = async (event: MessageEvent) => {
      // Validate origin
      if (event.origin !== expectedOrigin) return;

      const data = event.data as JsonRpcMessage;
      if (data?.jsonrpc !== "2.0" || !data.method) return;

      switch (data.method) {
        // --- Handshake ---
        case "ui/initialize": {
          setIsInitialized(true);
          sendResponse(data.id!, {
            protocolVersion: "2026-01-26",
            capabilities: {
              tools: true,
              resources: true,
              theme: true,
            },
          });
          break;
        }

        // --- Tool calls from the iframe ---
        case "tools/call": {
          const params = data.params as {
            name: string;
            arguments?: Record<string, unknown>;
          };
          try {
            const response = await fetch("/api/mcp-app/tool-call", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                agentId,
                toolName: params.name,
                args: params.arguments ?? {},
              }),
            });
            const result = await response.json();
            sendResponse(data.id!, result);
          } catch (error) {
            sendError(
              data.id!,
              -32603,
              error instanceof Error ? error.message : "Tool call failed",
            );
          }
          break;
        }

        // --- Resource reads from the iframe ---
        case "resources/read": {
          const params = data.params as { uri: string };
          try {
            const response = await fetch(
              `/api/mcp-app/resource?uri=${encodeURIComponent(params.uri)}&agentId=${encodeURIComponent(agentId)}`,
            );
            const text = await response.text();
            sendResponse(data.id!, {
              contents: [{ uri: params.uri, mimeType: "text/html", text }],
            });
          } catch (error) {
            sendError(
              data.id!,
              -32603,
              error instanceof Error ? error.message : "Resource read failed",
            );
          }
          break;
        }

        // --- Display mode change request ---
        case "ui/request/setDisplayMode": {
          const params = data.params as { mode: "inline" | "modal" | "panel" };
          if (["inline", "modal", "panel"].includes(params.mode)) {
            setDisplayMode(params.mode);
          }
          sendResponse(data.id!, { success: true });
          break;
        }

        // --- Size change notification ---
        case "ui/notifications/size-changed": {
          const params = data.params as { height?: number };
          if (params.height && params.height > 0) {
            setIframeHeight(Math.min(params.height, 800));
          }
          break;
        }

        default:
          // Unknown method — ignore silently
          break;
      }
    };

    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [expectedOrigin, agentId, sendResponse, sendError]);

  // Send theme notification on init and theme changes
  useEffect(() => {
    if (!isInitialized) return;
    const isDark = currentUITheme?.includes("dark");
    sendNotification("ui/notifications/theme", {
      colorScheme: isDark ? "dark" : "light",
    });
  }, [currentUITheme, isInitialized, sendNotification]);

  // Forward tool input when available
  useEffect(() => {
    if (!isInitialized || toolInput === undefined) return;
    sendNotification("ui/notifications/tool-input", { input: toolInput });
  }, [toolInput, isInitialized, sendNotification]);

  // Forward tool result when available
  useEffect(() => {
    if (!isInitialized || toolOutput === undefined) return;
    sendNotification("ui/notifications/tool-result", { result: toolOutput });
  }, [toolOutput, isInitialized, sendNotification]);

  // Send teardown on unmount
  useEffect(() => {
    return () => {
      if (iframeRef.current?.contentWindow) {
        try {
          iframeRef.current.contentWindow.postMessage(
            { jsonrpc: "2.0", method: "ui/resource-teardown", params: {} },
            expectedOrigin,
          );
        } catch {
          // iframe may already be detached
        }
      }
    };
  }, [expectedOrigin]);

  if (loadError) {
    return (
      <div className="rounded-md border border-destructive/50 bg-destructive/5 p-3 text-sm text-destructive">
        Failed to load MCP App: {loadError}
      </div>
    );
  }

  const showBorder = uiMeta?.prefersBorder !== false;

  return (
    <div
      className={`relative mt-2 overflow-hidden rounded-lg ${showBorder ? "border border-border" : ""} ${
        displayMode === "modal"
          ? "fixed inset-4 z-50 bg-background shadow-2xl"
          : ""
      }`}
    >
      {displayMode === "modal" && (
        <button
          type="button"
          onClick={() => setDisplayMode("inline")}
          className="absolute right-2 top-2 z-10 rounded-md bg-background/80 px-2 py-1 text-xs hover:bg-background"
        >
          Close
        </button>
      )}
      <iframe
        ref={iframeRef}
        src={iframeSrc}
        title={`MCP App: ${toolName}`}
        sandbox="allow-scripts allow-forms allow-popups allow-same-origin"
        style={{
          width: "100%",
          height: displayMode === "modal" ? "100%" : `${iframeHeight}px`,
          border: "none",
          display: "block",
        }}
        onError={() => setLoadError("Failed to load iframe content")}
      />
    </div>
  );
}
