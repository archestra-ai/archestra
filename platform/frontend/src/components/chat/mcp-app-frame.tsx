"use client";

import { useEffect, useRef, useState } from "react";
import { getBackendBaseUrl } from "@/lib/config";

/**
 * Renders an MCP App (interactive UI from an MCP tool) in a sandboxed iframe.
 * Fetches the ui:// resource from our backend and passes the initial tool result via postMessage.
 * @see https://modelcontextprotocol.io/docs/extensions/apps
 */
export function McpAppFrame({
  agentId,
  resourceUri,
  toolResult,
  toolName,
  className,
}: {
  agentId: string;
  resourceUri: string;
  /** Initial tool result to pass to the app (host pushes this when the app loads) */
  toolResult: unknown;
  toolName: string;
  className?: string;
}) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [html, setHtml] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const url = `${getBackendBaseUrl()}/api/chat/agents/${agentId}/mcp-app-resource?uri=${encodeURIComponent(resourceUri)}`;

    fetch(url, { credentials: "include" })
      .then((res) => {
        if (!res.ok) throw new Error(res.statusText || "Failed to load MCP App");
        return res.text();
      })
      .then((text) => {
        if (!cancelled) {
          setHtml(text);
          setError(null);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load");
          setHtml(null);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [agentId, resourceUri]);

  // When iframe loads and we have a tool result, send it to the app via postMessage (MCP Apps protocol)
  useEffect(() => {
    if (!html || !iframeRef.current) return;

    const iframe = iframeRef.current;
    const handleLoad = () => {
      try {
        // Keep iframe origin opaque for security (no allow-same-origin in sandbox),
        // so we treat it as untrusted and use "*" as targetOrigin.
        iframe.contentWindow?.postMessage(
          {
            jsonrpc: "2.0",
            method: "notifications/tool_result",
            params: {
              result: {
                content:
                  typeof toolResult === "string"
                    ? [{ type: "text", text: toolResult }]
                    : Array.isArray(toolResult)
                      ? toolResult
                      : [{ type: "text", text: JSON.stringify(toolResult) }],
              },
              toolName,
            },
          },
          "*",
        );
      } catch (_e) {
        // Ignore postMessage errors (e.g. iframe not available)
      }
    };

    iframe.addEventListener("load", handleLoad);
    return () => iframe.removeEventListener("load", handleLoad);
  }, [html, toolResult, toolName]);

  if (loading) {
    return (
      <div
        className={className}
        style={{ minHeight: 200 }}
        aria-busy
      >
        <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
          Loading app…
        </div>
      </div>
    );
  }

  if (error || !html) {
    return (
      <div
        className={className}
        style={{ minHeight: 120 }}
      >
        <div className="rounded-md bg-destructive/10 text-destructive text-sm p-3">
          {error ?? "No content"}
        </div>
      </div>
    );
  }

  return (
    <iframe
      ref={iframeRef}
      title={`MCP App: ${toolName}`}
      srcDoc={html}
      // Do NOT use allow-same-origin here; keeping an opaque origin prevents the app
      // HTML (fetched from remote MCP servers) from accessing parent DOM, cookies, or storage.
      sandbox="allow-scripts"
      className={className}
      style={{ minHeight: 280, width: "100%", border: "1px solid var(--border)" }}
    />
  );
}
