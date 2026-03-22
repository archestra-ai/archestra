"use client";

import type { UIResource } from "@shared";
import { AlertTriangleIcon, ExternalLinkIcon, MaximizeIcon, MinimizeIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type McpAppRendererProps = {
  resource: UIResource;
  className?: string;
};

/**
 * Renders an MCP App UI resource inside a sandboxed iframe.
 *
 * Supports three content types:
 * - `text/html`: inline HTML rendered via srcdoc
 * - `text/uri-list`: remote URL loaded in iframe src
 * - `application/remote-dom+json`: reserved for future remote DOM support
 *
 * Communication between the iframe and parent uses postMessage with a
 * nonce-based handshake for authentication.
 */
export function McpAppRenderer({ resource, className }: McpAppRendererProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const nonceRef = useRef(crypto.randomUUID());
  const [height, setHeight] = useState(300);
  const [isExpanded, setIsExpanded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleMessage = useCallback(
    (event: MessageEvent) => {
      const iframe = iframeRef.current;
      if (!iframe?.contentWindow || event.source !== iframe.contentWindow) {
        return;
      }

      const data = event.data;
      if (typeof data !== "object" || data === null) return;

      switch (data.type) {
        case "ui-lifecycle-iframe-ready": {
          iframe.contentWindow.postMessage(
            { type: "ui-lifecycle-auth", nonce: nonceRef.current },
            "*",
          );
          break;
        }
        case "ui-size-change": {
          if (typeof data.height === "number" && data.height > 0) {
            setHeight(Math.min(data.height, 800));
          }
          break;
        }
      }
    },
    [],
  );

  useEffect(() => {
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [handleMessage]);

  if (resource.mimeType === "application/remote-dom+json") {
    return (
      <div className={cn("flex items-center gap-2 rounded-md border p-3 text-muted-foreground text-xs", className)}>
        <AlertTriangleIcon className="size-4" />
        <span>Remote DOM rendering is not yet supported.</span>
      </div>
    );
  }

  const sandbox = "allow-scripts allow-forms allow-popups";

  const iframeSrc =
    resource.mimeType === "text/uri-list" ? resource.uri : undefined;

  const iframeSrcDoc =
    resource.mimeType === "text/html" ? (resource.text ?? "") : undefined;

  if (!iframeSrc && !iframeSrcDoc) {
    return (
      <div className={cn("flex items-center gap-2 rounded-md border p-3 text-muted-foreground text-xs", className)}>
        <AlertTriangleIcon className="size-4" />
        <span>No content available for this MCP App.</span>
      </div>
    );
  }

  return (
    <div className={cn("space-y-1", className)}>
      <div className="flex items-center justify-between">
        <span className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
          MCP App
        </span>
        <div className="flex items-center gap-1">
          {resource.mimeType === "text/uri-list" && (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-1"
              asChild
            >
              <a
                href={resource.uri}
                target="_blank"
                rel="noopener noreferrer"
              >
                <ExternalLinkIcon className="size-3" />
              </a>
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-1"
            onClick={() => setIsExpanded(!isExpanded)}
          >
            {isExpanded ? (
              <MinimizeIcon className="size-3" />
            ) : (
              <MaximizeIcon className="size-3" />
            )}
          </Button>
        </div>
      </div>
      {error ? (
        <div className="rounded-md border border-destructive/20 bg-destructive/10 p-3 text-destructive text-xs">
          {error}
        </div>
      ) : (
        <iframe
          ref={iframeRef}
          title="MCP App"
          sandbox={sandbox}
          src={iframeSrc}
          srcDoc={iframeSrcDoc}
          className={cn(
            "w-full rounded-md border bg-background transition-[height] duration-200",
            isExpanded ? "h-[80vh]" : "",
          )}
          style={isExpanded ? undefined : { height: `${height}px` }}
          onError={() => setError("Failed to load MCP App content.")}
        />
      )}
    </div>
  );
}

// ============================================================================
// UIResource detection helpers
// ============================================================================

/**
 * Checks if a tool output contains a UIResource.
 */
export function hasUIResource(output: unknown): boolean {
  return extractUIResource(output) !== null;
}

/**
 * Extracts the first UIResource from a tool output.
 * Looks for the standard `_meta.ui` or top-level `uri` + `mimeType` pattern.
 */
export function extractUIResource(output: unknown): UIResource | null {
  if (!output || typeof output !== "object") return null;

  const obj = output as Record<string, unknown>;

  // Pattern 1: { _meta: { ui: UIResource } }
  if (obj._meta && typeof obj._meta === "object") {
    const meta = obj._meta as Record<string, unknown>;
    if (meta.ui && typeof meta.ui === "object") {
      const ui = meta.ui as Record<string, unknown>;
      if (isValidUIResource(ui)) {
        return ui as unknown as UIResource;
      }
    }
  }

  // Pattern 2: { uri, mimeType } at top level
  if (isValidUIResource(obj)) {
    return obj as unknown as UIResource;
  }

  // Pattern 3: string output that looks like JSON containing UIResource
  if (typeof output === "string") {
    try {
      const parsed = JSON.parse(output);
      return extractUIResource(parsed);
    } catch {
      return null;
    }
  }

  return null;
}

function isValidUIResource(obj: Record<string, unknown>): boolean {
  const validMimeTypes = [
    "text/html",
    "text/uri-list",
    "application/remote-dom+json",
  ];
  return (
    typeof obj.uri === "string" &&
    typeof obj.mimeType === "string" &&
    validMimeTypes.includes(obj.mimeType)
  );
}
