"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * MCP UI Renderer - Renders UIResources from MCP tools as interactive iframes
 * 
 * Implements the MCP Apps postMessage contract:
 * - intent: Navigation/action requests
 * - notify: Toast/notification requests
 * - tool: Tool execution requests
 * - prompt: Prompt execution requests
 * - link: External link requests
 * - data: Data fetch requests
 * - render-data: Rendered data from host
 * - size: Size update notifications
 */

interface UIResource {
  type: "resource";
  resource: {
    uri: string; // e.g., ui://component/id
    mimeType: "text/html" | "text/uri-list" | "application/vnd.mcp-ui.remote-dom";
    text?: string; // Inline HTML, external URL, or remote-dom script
    blob?: string; // Base64-encoded content
  };
}

interface MCPUIRendererProps {
  resource: UIResource;
  onToolCall?: (toolName: string, args: Record<string, unknown>) => Promise<unknown>;
  onPromptCall?: (promptName: string, args: Record<string, unknown>) => Promise<unknown>;
  onNotify?: (message: string, type?: "info" | "success" | "warning" | "error") => void;
  onLinkOpen?: (url: string) => void;
  className?: string;
}

// Message types from MCP UI spec
type MCPUIMessage =
  | { type: "intent"; payload: { action: string; data?: unknown } }
  | { type: "notify"; payload: { message: string; level?: string } }
  | { type: "tool"; payload: { name: string; arguments?: Record<string, unknown> }; id: string }
  | { type: "prompt"; payload: { name: string; arguments?: Record<string, unknown> }; id: string }
  | { type: "link"; payload: { url: string } }
  | { type: "data"; payload: { key: string }; id: string }
  | { type: "size"; payload: { width?: number; height?: number } }
  | { type: "ready" };

export function MCPUIRenderer({
  resource,
  onToolCall,
  onPromptCall,
  onNotify,
  onLinkOpen,
  className,
}: MCPUIRendererProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [dimensions, setDimensions] = useState({ width: "100%", height: "200px" });
  const [isLoaded, setIsLoaded] = useState(false);

  // Handle messages from iframe
  const handleMessage = useCallback(
    async (event: MessageEvent) => {
      // Validate origin - in production, check against known MCP UI origins
      const iframe = iframeRef.current;
      if (!iframe || event.source !== iframe.contentWindow) {
        return;
      }

      const message = event.data as MCPUIMessage;

      switch (message.type) {
        case "ready":
          setIsLoaded(true);
          break;

        case "size":
          if (message.payload.height) {
            setDimensions((prev) => ({
              ...prev,
              height: `${message.payload.height}px`,
            }));
          }
          if (message.payload.width) {
            setDimensions((prev) => ({
              ...prev,
              width: `${message.payload.width}px`,
            }));
          }
          break;

        case "tool":
          if (onToolCall) {
            try {
              const result = await onToolCall(
                message.payload.name,
                message.payload.arguments || {}
              );
              iframe.contentWindow?.postMessage(
                { type: "tool-result", id: message.id, result },
                "*"
              );
            } catch (error) {
              iframe.contentWindow?.postMessage(
                { type: "tool-error", id: message.id, error: String(error) },
                "*"
              );
            }
          }
          break;

        case "prompt":
          if (onPromptCall) {
            try {
              const result = await onPromptCall(
                message.payload.name,
                message.payload.arguments || {}
              );
              iframe.contentWindow?.postMessage(
                { type: "prompt-result", id: message.id, result },
                "*"
              );
            } catch (error) {
              iframe.contentWindow?.postMessage(
                { type: "prompt-error", id: message.id, error: String(error) },
                "*"
              );
            }
          }
          break;

        case "notify":
          if (onNotify) {
            onNotify(
              message.payload.message,
              (message.payload.level as "info" | "success" | "warning" | "error") || "info"
            );
          }
          break;

        case "link":
          if (onLinkOpen) {
            onLinkOpen(message.payload.url);
          } else {
            window.open(message.payload.url, "_blank", "noopener,noreferrer");
          }
          break;

        case "intent":
          // Handle navigation/action intents
          console.log("[MCP-UI] Intent received:", message.payload);
          break;

        case "data":
          // Handle data requests - respond with render-data
          iframe.contentWindow?.postMessage(
            { type: "render-data", id: message.id, data: null },
            "*"
          );
          break;
      }
    },
    [onToolCall, onPromptCall, onNotify, onLinkOpen]
  );

  useEffect(() => {
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [handleMessage]);

  // Generate iframe content based on resource type
  const getIframeSrc = useCallback(() => {
    const { mimeType, text, blob } = resource.resource;

    if (mimeType === "text/uri-list" && text) {
      // External URL - use directly
      return text.trim().split("\n")[0];
    }

    if (mimeType === "text/html") {
      // Inline HTML - create blob URL
      const html = blob ? atob(blob) : text || "";
      const blobObj = new Blob([html], { type: "text/html" });
      return URL.createObjectURL(blobObj);
    }

    if (mimeType === "application/vnd.mcp-ui.remote-dom") {
      // Remote DOM - wrap in host HTML
      const script = blob ? atob(blob) : text || "";
      const html = `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="utf-8">
          <style>body { margin: 0; font-family: system-ui, sans-serif; }</style>
        </head>
        <body>
          <div id="root"></div>
          <script type="module">${script}</script>
        </body>
        </html>
      `;
      const blobObj = new Blob([html], { type: "text/html" });
      return URL.createObjectURL(blobObj);
    }

    return "";
  }, [resource]);

  const iframeSrc = getIframeSrc();

  // Cleanup blob URLs
  useEffect(() => {
    return () => {
      if (iframeSrc.startsWith("blob:")) {
        URL.revokeObjectURL(iframeSrc);
      }
    };
  }, [iframeSrc]);

  if (!iframeSrc) {
    return (
      <div className="text-sm text-muted-foreground p-2">
        Unable to render MCP UI resource
      </div>
    );
  }

  return (
    <div className={className}>
      <iframe
        ref={iframeRef}
        src={iframeSrc}
        style={{
          width: dimensions.width,
          height: dimensions.height,
          border: "none",
          borderRadius: "8px",
          backgroundColor: "transparent",
        }}
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
        title="MCP UI"
        onLoad={() => setIsLoaded(true)}
      />
      {!isLoaded && (
        <div className="absolute inset-0 flex items-center justify-center bg-muted/50 rounded-lg">
          <div className="animate-pulse text-sm text-muted-foreground">
            Loading MCP UI...
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Utility to detect if a tool output contains an MCP UI resource
 */
export function isMCPUIResource(output: unknown): output is UIResource {
  if (!output || typeof output !== "object") return false;
  
  const obj = output as Record<string, unknown>;
  
  // Check for UIResource structure
  if (obj.type === "resource" && obj.resource) {
    const resource = obj.resource as Record<string, unknown>;
    return (
      typeof resource.uri === "string" &&
      resource.uri.startsWith("ui://") &&
      typeof resource.mimeType === "string"
    );
  }

  // Check for _meta.ui pattern (MCP Apps)
  if (obj._meta && typeof obj._meta === "object") {
    const meta = obj._meta as Record<string, unknown>;
    if (meta.ui && typeof meta.ui === "object") {
      const ui = meta.ui as Record<string, unknown>;
      return typeof ui.resourceUri === "string";
    }
  }

  return false;
}

/**
 * Extract UIResource from tool output
 */
export function extractUIResource(output: unknown): UIResource | null {
  if (!output || typeof output !== "object") return null;

  const obj = output as Record<string, unknown>;

  // Direct UIResource
  if (obj.type === "resource" && obj.resource) {
    return obj as UIResource;
  }

  // Check content array (common pattern)
  if (Array.isArray(obj.content)) {
    for (const item of obj.content) {
      if (item && typeof item === "object" && item.type === "resource") {
        return item as UIResource;
      }
    }
  }

  return null;
}
