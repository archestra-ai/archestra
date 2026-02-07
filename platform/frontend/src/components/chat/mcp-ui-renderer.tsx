"use client";

/**
 * MCP UI Renderer Component
 *
 * Integrates @mcp-ui/client with Archestra's chat UI to render
 * interactive UI elements from MCP tool responses.
 *
 * Supports:
 * - Raw HTML content (text/html)
 * - External URLs (text/uri-list)
 * - Remote DOM (application/vnd.mcp-ui.remote-dom)
 *
 * @see https://github.com/MCP-UI-Org/mcp-ui
 */

import { useCallback, useMemo, useState } from "react";
import { UIResourceRenderer, type UIActionResult, AppRenderer, type AppRendererProps } from "@mcp-ui/client";
import { cn } from "@/lib/utils";
import { AlertCircle, ExternalLink, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";

// Re-export AppRenderer and its props for MCP Apps support
export { AppRenderer };
export type { AppRendererProps };

// Types for MCP UI resources
export interface MCPUIResource {
  uri: string;
  mimeType?: string;
  text?: string;
  blob?: string;
}

// Types for MCP Apps (tools with _meta.ui.resourceUri)
export interface MCPAppInfo {
  toolName: string;
  resourceUri: string;
}

/**
 * Detects if a tool definition is an MCP App (has _meta.ui.resourceUri).
 *
 * MCP Apps are tools that have a UI resource URI in their metadata,
 * which should be rendered using the AppRenderer component.
 */
export function detectMCPApp(
  toolDefinition: unknown
): MCPAppInfo | null {
  if (!toolDefinition || typeof toolDefinition !== "object") {
    return null;
  }

  const tool = toolDefinition as Record<string, unknown>;
  const meta = tool._meta as Record<string, unknown> | undefined;
  const ui = meta?.ui as Record<string, unknown> | undefined;
  const resourceUri = ui?.resourceUri;

  if (typeof resourceUri === "string" && typeof tool.name === "string") {
    return {
      toolName: tool.name,
      resourceUri,
    };
  }

  return null;
}

export interface MCPUIRendererProps {
  /** The MCP UI resource to render */
  resource: MCPUIResource;
  /** Optional callback when a UI action is triggered (tool call, prompt, link, etc.) */
  onUIAction?: (result: UIActionResult) => Promise<unknown>;
  /** Optional callback when a tool is called from the UI */
  onToolCall?: (toolName: string, params: Record<string, unknown>) => Promise<unknown>;
  /** Optional callback when a link is opened */
  onOpenLink?: (url: string) => void;
  /** Optional CSS class name */
  className?: string;
  /** Optional minimum height for the iframe */
  minHeight?: number;
  /** Optional maximum height for the iframe */
  maxHeight?: number;
}

/**
 * Detects if a tool output contains an MCP UI resource.
 *
 * MCP UI resources can be identified by:
 * 1. A `_meta.ui.resourceUri` field pointing to a UI resource
 * 2. An embedded resource with mimeType text/html or text/uri-list
 * 3. A content object with type 'resource' and appropriate mimeType
 */
export function detectMCPUIResource(
  output: unknown
): MCPUIResource | null {
  if (!output || typeof output !== "object") {
    return null;
  }

  // Check for embedded resource in output
  const obj = output as Record<string, unknown>;

  // Case 1: Direct resource object with uri and mimeType
  if (obj.uri && typeof obj.uri === "string") {
    const mimeType = obj.mimeType as string | undefined;
    if (
      mimeType === "text/html" ||
      mimeType === "text/uri-list" ||
      mimeType?.startsWith("application/vnd.mcp-ui.remote-dom") ||
      mimeType === "text/html;profile=mcp-app"
    ) {
      return {
        uri: obj.uri,
        mimeType,
        text: obj.text as string | undefined,
        blob: obj.blob as string | undefined,
      };
    }
  }

  // Case 2: Nested resource object
  if (obj.resource && typeof obj.resource === "object") {
    const resource = obj.resource as Record<string, unknown>;
    if (resource.uri && typeof resource.uri === "string") {
      const mimeType = resource.mimeType as string | undefined;
      if (
        mimeType === "text/html" ||
        mimeType === "text/uri-list" ||
        mimeType?.startsWith("application/vnd.mcp-ui.remote-dom") ||
        mimeType === "text/html;profile=mcp-app"
      ) {
        return {
          uri: resource.uri,
          mimeType,
          text: resource.text as string | undefined,
          blob: resource.blob as string | undefined,
        };
      }
    }
  }

  // Case 3: Array of content items (common in MCP responses)
  if (Array.isArray(obj.content)) {
    for (const item of obj.content) {
      if (item && typeof item === "object" && item.type === "resource") {
        const resource = item.resource as Record<string, unknown> | undefined;
        if (resource?.uri && typeof resource.uri === "string") {
          const mimeType = resource.mimeType as string | undefined;
          if (
            mimeType === "text/html" ||
            mimeType === "text/uri-list" ||
            mimeType?.startsWith("application/vnd.mcp-ui.remote-dom") ||
            mimeType === "text/html;profile=mcp-app"
          ) {
            return {
              uri: resource.uri,
              mimeType,
              text: resource.text as string | undefined,
              blob: resource.blob as string | undefined,
            };
          }
        }
      }
    }
  }

  return null;
}

/**
 * MCP UI Renderer Component
 *
 * Renders MCP UI resources (HTML, external URLs, Remote DOM) from tool responses.
 */
export function MCPUIRenderer({
  resource,
  onUIAction,
  onToolCall,
  onOpenLink,
  className,
  minHeight = 100,
  maxHeight = 600,
}: MCPUIRendererProps) {
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  // Handle UI actions from the rendered content
  const handleUIAction = useCallback(
    async (result: UIActionResult): Promise<unknown> => {
      try {
        // Handle different action types
        switch (result.type) {
          case "tool":
            if (onToolCall && result.payload) {
              const payload = result.payload as { toolName?: string; params?: Record<string, unknown> };
              return await onToolCall(
                payload.toolName || "unknown",
                payload.params || {}
              );
            }
            break;

          case "link":
            if (onOpenLink && result.payload) {
              const payload = result.payload as { url?: string };
              if (payload.url) {
                onOpenLink(payload.url);
              }
            }
            return { success: true };

          case "prompt":
            // Could integrate with chat input
            console.log("[MCP UI] Prompt action:", result.payload);
            break;

          case "notify":
            // Could integrate with toast notifications
            console.log("[MCP UI] Notification:", result.payload);
            break;

          case "intent":
            // Handle intents (similar to prompts)
            console.log("[MCP UI] Intent action:", result.payload);
            break;
        }

        // Forward to custom handler if provided
        if (onUIAction) {
          return await onUIAction(result);
        }
      } catch (err) {
        console.error("[MCP UI] Action error:", err);
        setError(err instanceof Error ? err.message : "Action failed");
      }

      return undefined;
    },
    [onUIAction, onToolCall, onOpenLink]
  );

  // Prepare the resource for rendering
  const preparedResource = useMemo(() => {
    return {
      uri: resource.uri,
      mimeType: resource.mimeType,
      text: resource.text,
      blob: resource.blob,
    };
  }, [resource]);

  // Handle iframe load
  const handleLoad = useCallback(() => {
    setIsLoading(false);
  }, []);

  // Error state
  if (error) {
    return (
      <div
        className={cn(
          "flex items-center gap-2 p-4 rounded-lg bg-destructive/10 text-destructive",
          className
        )}
      >
        <AlertCircle className="h-4 w-4 flex-shrink-0" />
        <span className="text-sm">{error}</span>
      </div>
    );
  }

  // Check if we have content to render
  if (!resource.text && !resource.blob) {
    // External URL case - show link to open
    if (resource.mimeType === "text/uri-list" && resource.uri) {
      return (
        <div className={cn("flex items-center gap-2 p-4", className)}>
          <Button
            variant="outline"
            size="sm"
            onClick={() => onOpenLink?.(resource.uri)}
          >
            <ExternalLink className="h-4 w-4 mr-2" />
            Open in new tab
          </Button>
        </div>
      );
    }

    return (
      <div
        className={cn(
          "flex items-center gap-2 p-4 rounded-lg bg-muted text-muted-foreground",
          className
        )}
      >
        <AlertCircle className="h-4 w-4 flex-shrink-0" />
        <span className="text-sm">No UI content available</span>
      </div>
    );
  }

  return (
    <div
      className={cn("relative rounded-lg overflow-hidden border", className)}
      style={{ minHeight, maxHeight }}
    >
      {isLoading && (
        <div className="absolute inset-0 flex items-center justify-center bg-background/80 z-10">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      )}
      <UIResourceRenderer
        resource={preparedResource}
        onUIAction={handleUIAction}
        htmlProps={{
          style: {
            width: "100%",
            minHeight: `${minHeight}px`,
            maxHeight: `${maxHeight}px`,
            border: "none",
          },
          onLoad: handleLoad,
        }}
      />
    </div>
  );
}

MCPUIRenderer.displayName = "MCPUIRenderer";

export default MCPUIRenderer;
