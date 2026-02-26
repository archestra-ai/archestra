"use client";

import { UIResourceRenderer } from "@mcp-ui/client";
import { useCallback, useState } from "react";
import { Button } from "@/components/ui/button";

export interface McpAppResource {
  uri: string;
  mimeType?: string;
  text?: string;
  blob?: string;
}

interface McpAppFrameProps {
  /** Resource with HTML already loaded, or just a uri:// reference to fetch */
  resource: McpAppResource;
  toolName: string;
  /** Agent ID, needed to fetch ui:// resources that aren't inlined in the tool result */
  agentId?: string;
}

/**
 * Renders an MCP App UI resource inside a sandboxed iframe.
 * Uses @mcp-ui/client's UIResourceRenderer for secure rendering.
 *
 * Handles two cases:
 * 1. Resource HTML is already in `resource.text` (inline, from tool result)
 * 2. Resource only has a `ui://` URI — fetched lazily from /api/mcp-app-resource
 */
export function McpAppFrame({ resource, toolName, agentId }: McpAppFrameProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [loadedResource, setLoadedResource] = useState<McpAppResource | null>(
    resource.text ? resource : null,
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleOpen = useCallback(
    async (e: React.MouseEvent) => {
      e.stopPropagation();

      if (isOpen) {
        setIsOpen(false);
        return;
      }

      // If we already have the HTML, just open
      if (loadedResource?.text) {
        setIsOpen(true);
        return;
      }

      // Otherwise fetch from backend proxy
      if (!agentId) {
        setError("Cannot load app: agent ID missing");
        setIsOpen(true);
        return;
      }

      setLoading(true);
      try {
        const params = new URLSearchParams({ agentId, uri: resource.uri });
        const res = await fetch(`/api/mcp-app-resource?${params}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        setLoadedResource(data);
        setIsOpen(true);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load app");
        setIsOpen(true);
      } finally {
        setLoading(false);
      }
    },
    [isOpen, loadedResource, agentId, resource.uri],
  );

  return (
    <div className="mt-2">
      <Button
        size="sm"
        variant="outline"
        onClick={handleOpen}
        disabled={loading}
      >
        {loading ? "Loading…" : isOpen ? "Close App" : "Open App"}
      </Button>
      {isOpen && (
        <div
          className="mt-2 rounded-md border overflow-hidden"
          style={{ height: 480 }}
        >
          {error ? (
            <div className="flex items-center justify-center h-full text-sm text-destructive p-4">
              {error}
            </div>
          ) : loadedResource?.text ? (
            <UIResourceRenderer
              resource={loadedResource}
              onUIAction={async (action) => {
                console.log("[MCP App]", toolName, action);
              }}
            />
          ) : null}
        </div>
      )}
    </div>
  );
}

/**
 * Extracts the first MCP App resource from a tool output, if present.
 * MCP Apps return resources with mimeType 'text/html;profile=mcp-app'
 * or with a uri starting with 'ui://'.
 */
export function extractMcpAppResource(
  output: unknown,
): McpAppResource | null {
  if (!Array.isArray(output)) return null;

  for (const item of output) {
    if (item?.type === "resource" && item.resource) {
      const r = item.resource as McpAppResource;
      const isMcpApp =
        r.mimeType?.includes("text/html") ||
        r.mimeType?.includes("mcp-app") ||
        r.uri?.startsWith("ui://");
      if (isMcpApp) return r;
    }
  }
  return null;
}

/**
 * Checks if a tool definition has MCP App support via _meta.ui.resourceUri.
 * Returns the resourceUri if present, null otherwise.
 */
export function getMcpAppResourceUri(toolMeta: unknown): string | null {
  if (
    toolMeta &&
    typeof toolMeta === "object" &&
    "ui" in toolMeta &&
    toolMeta.ui &&
    typeof toolMeta.ui === "object" &&
    "resourceUri" in toolMeta.ui &&
    typeof toolMeta.ui.resourceUri === "string"
  ) {
    return toolMeta.ui.resourceUri;
  }
  return null;
}
