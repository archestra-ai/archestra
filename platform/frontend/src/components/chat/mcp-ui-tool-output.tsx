"use client";

import { UIResourceRenderer } from "@mcp-ui/client";
import { useCallback } from "react";

interface UIResource {
  uri: string;
  mimeType: string;
  text?: string;
  blob?: string;
}

function extractUIResource(output: unknown): UIResource | null {
  try {
    const parsed =
      typeof output === "string" ? JSON.parse(output) : output;

    if (
      parsed?.type === "resource" &&
      parsed?.resource?.uri &&
      parsed?.resource?.mimeType
    ) {
      return parsed.resource as UIResource;
    }

    if (Array.isArray(parsed?.content)) {
      for (const item of parsed.content) {
        if (
          item?.type === "resource" &&
          item?.resource?.uri &&
          item?.resource?.mimeType
        ) {
          return item.resource as UIResource;
        }
      }
    }

    return null;
  } catch {
    return null;
  }
}

interface McpUiToolOutputProps {
  output: unknown;
  onAction?: (action: unknown) => void;
}

export function McpUiToolOutput({ output, onAction }: McpUiToolOutputProps) {
  const resource = extractUIResource(output);
  if (!resource) return null;

  const handleAction = useCallback(
    async (action: unknown) => {
      onAction?.(action);
    },
    [onAction],
  );

  return (
    <div className="mt-2 rounded-lg border bg-background overflow-hidden">
      <div className="px-3 py-1.5 border-b bg-muted/30 flex items-center gap-2">
        <span className="text-xs text-muted-foreground font-mono">
          MCP UI · {resource.uri}
        </span>
      </div>
      <div className="p-2">
        <UIResourceRenderer
          resource={resource}
          onUIAction={handleAction}
        />
      </div>
    </div>
  );
}

export { extractUIResource };
