"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

/**
 * MCP App Renderer - Renders interactive MCP App UIs in sandboxed iframes.
 *
 * MCP Apps are interactive HTML UIs declared by MCP tools via _meta.ui.resourceUri.
 * The HTML content is fetched from the backend and rendered in a sandboxed iframe
 * with a postMessage-based AppBridge protocol for communication.
 *
 * Security: The iframe is sandboxed with allow-scripts only (no same-origin,
 * no forms, no popups) to prevent XSS and other attacks.
 */

interface McpAppRendererProps {
  /** The HTML content to render in the iframe */
  htmlContent: string;
  /** Tool name for identification */
  toolName: string;
  /** Optional class name */
  className?: string;
  /** Tool output data to pass to the iframe app */
  toolOutput?: unknown;
}

/** JSON-RPC message format for AppBridge communication */
interface AppBridgeMessage {
  jsonrpc: "2.0";
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export function McpAppRenderer({
  htmlContent,
  toolName,
  className,
  toolOutput,
}: McpAppRendererProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [iframeHeight, setIframeHeight] = useState(300);
  const [isLoaded, setIsLoaded] = useState(false);

  // Handle messages from the iframe via AppBridge protocol
  const handleMessage = useCallback(
    (event: MessageEvent) => {
      // Only accept messages from our iframe
      if (
        !iframeRef.current?.contentWindow ||
        event.source !== iframeRef.current.contentWindow
      ) {
        return;
      }

      const data = event.data as AppBridgeMessage;
      if (data.jsonrpc !== "2.0" || !data.method) return;

      const iframe = iframeRef.current;

      switch (data.method) {
        case "resize": {
          const height = (data.params as { height?: number })?.height;
          if (typeof height === "number" && height > 0 && height <= 2000) {
            setIframeHeight(height);
          }
          // Send acknowledgment
          iframe.contentWindow?.postMessage(
            { jsonrpc: "2.0", id: data.id, result: { ok: true } },
            "*",
          );
          break;
        }
        case "getToolOutput": {
          // Send the tool output data to the iframe
          iframe.contentWindow?.postMessage(
            { jsonrpc: "2.0", id: data.id, result: toolOutput ?? null },
            "*",
          );
          break;
        }
        default: {
          // Unknown method - respond with error
          iframe.contentWindow?.postMessage(
            {
              jsonrpc: "2.0",
              id: data.id,
              error: { code: -32601, message: `Method not found: ${data.method}` },
            },
            "*",
          );
        }
      }
    },
    [toolOutput],
  );

  useEffect(() => {
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [handleMessage]);

  const handleLoad = useCallback(() => {
    setIsLoaded(true);
  }, []);

  // Create a blob URL from the HTML content for the iframe src
  const blobUrl = useRef<string | null>(null);
  useEffect(() => {
    const blob = new Blob([htmlContent], { type: "text/html" });
    blobUrl.current = URL.createObjectURL(blob);
    return () => {
      if (blobUrl.current) {
        URL.revokeObjectURL(blobUrl.current);
      }
    };
  }, [htmlContent]);

  return (
    <div className={cn("mt-2 overflow-hidden rounded-md border", className)}>
      <div className="flex items-center gap-2 border-b bg-muted/50 px-3 py-1.5">
        <span className="text-muted-foreground text-xs font-medium">
          Interactive UI — {toolName}
        </span>
      </div>
      {!isLoaded && (
        <div className="flex h-[200px] items-center justify-center text-muted-foreground text-sm">
          Loading interactive UI...
        </div>
      )}
      {blobUrl.current && (
        <iframe
          ref={iframeRef}
          src={blobUrl.current}
          title={`MCP App: ${toolName}`}
          sandbox="allow-scripts"
          style={{
            width: "100%",
            height: `${iframeHeight}px`,
            border: "none",
            display: isLoaded ? "block" : "none",
          }}
          onLoad={handleLoad}
        />
      )}
    </div>
  );
}
