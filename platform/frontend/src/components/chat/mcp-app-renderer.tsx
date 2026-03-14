"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTheme } from "next-themes";
import { cn } from "@/lib/utils";

/**
 * MCP Apps renderer for Archestra Chat UI.
 *
 * Renders MCP App UI resources (HTML) in sandboxed iframes with the
 * postMessage protocol defined by SEP-1865 (MCP Apps specification).
 *
 * Implements:
 * - ui/initialize handshake
 * - ui/notifications/tool-input delivery
 * - ui/notifications/tool-result delivery
 * - tools/call forwarding (app -> host -> MCP Gateway)
 * - ui/open-link handling
 * - ui/message handling
 * - Theme/style variable passthrough
 */

interface McpAppRendererProps {
  /** HTML content of the MCP App (from resources/read) */
  htmlContent: string;
  /** Tool input arguments to pass to the app */
  toolInput?: Record<string, unknown>;
  /** Tool result to pass to the app */
  toolResult?: unknown;
  /** Callback when the app requests a tool call */
  onToolCall?: (params: {
    name: string;
    arguments: Record<string, unknown>;
  }) => Promise<unknown>;
  /** Callback when the app sends a message */
  onMessage?: (params: { content: string }) => void;
  /** CSP domains from the resource _meta.ui */
  csp?: {
    connectDomains?: string[];
    resourceDomains?: string[];
    frameDomains?: string[];
  };
  /** Additional iframe permissions from _meta.ui */
  permissions?: {
    camera?: Record<string, never>;
    microphone?: Record<string, never>;
    geolocation?: Record<string, never>;
    clipboardWrite?: Record<string, never>;
  };
  /** Whether the app prefers a visible border */
  prefersBorder?: boolean;
  /** Custom className */
  className?: string;
}

/**
 * Next JSON-RPC request ID
 */
let nextRequestId = 1;

export function McpAppRenderer({
  htmlContent,
  toolInput,
  toolResult,
  onToolCall,
  onMessage,
  csp,
  permissions,
  prefersBorder = true,
  className,
}: McpAppRendererProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [isInitialized, setIsInitialized] = useState(false);
  const [iframeHeight, setIframeHeight] = useState(300);
  const { resolvedTheme } = useTheme();
  const pendingRequestsRef = useRef<
    Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>
  >(new Map());

  // Build sandbox attributes
  const sandboxAttrs = buildSandboxAttrs(permissions);

  // Build CSP meta tag to inject
  const cspMeta = buildCspMeta(csp);

  // Prepare the HTML content with injected CSP and bridge script
  const preparedHtml = prepareHtmlContent(htmlContent, cspMeta);

  // Handle messages from the iframe
  const handleMessage = useCallback(
    async (event: MessageEvent) => {
      const iframe = iframeRef.current;
      if (!iframe?.contentWindow) return;

      // Only accept messages from our iframe
      if (event.source !== iframe.contentWindow) return;

      const data = event.data;
      if (!data || typeof data !== "object" || data.jsonrpc !== "2.0") return;

      // Handle JSON-RPC requests from the app
      if (data.method) {
        switch (data.method) {
          case "ui/initialize": {
            // Respond with host info and theme
            const response = {
              jsonrpc: "2.0",
              id: data.id,
              result: {
                protocolVersion: "2026-01-26",
                hostCapabilities: {
                  tools: true,
                  openLink: true,
                  message: true,
                },
                hostInfo: {
                  name: "archestra",
                  version: "1.0.0",
                },
                hostContext: {
                  theme: resolvedTheme === "dark" ? "dark" : "light",
                  styles: {
                    variables: getThemeVariables(resolvedTheme),
                  },
                  displayMode: "inline",
                  platform: "web",
                },
              },
            };
            iframe.contentWindow.postMessage(response, "*");
            setIsInitialized(true);

            // Send tool input if available
            if (toolInput) {
              iframe.contentWindow.postMessage(
                {
                  jsonrpc: "2.0",
                  method: "ui/notifications/tool-input",
                  params: { arguments: toolInput },
                },
                "*",
              );
            }

            // Send tool result if available
            if (toolResult) {
              iframe.contentWindow.postMessage(
                {
                  jsonrpc: "2.0",
                  method: "ui/notifications/tool-result",
                  params: {
                    content:
                      typeof toolResult === "string"
                        ? [{ type: "text", text: toolResult }]
                        : Array.isArray(toolResult)
                          ? toolResult
                          : [
                              {
                                type: "text",
                                text: JSON.stringify(toolResult),
                              },
                            ],
                  },
                },
                "*",
              );
            }
            break;
          }

          case "ui/notifications/initialized": {
            // App confirms initialization complete
            break;
          }

          case "tools/call": {
            // App wants to call an MCP tool
            if (onToolCall && data.params) {
              try {
                const result = await onToolCall({
                  name: data.params.name,
                  arguments: data.params.arguments || {},
                });
                if (data.id !== undefined) {
                  iframe.contentWindow.postMessage(
                    {
                      jsonrpc: "2.0",
                      id: data.id,
                      result: {
                        content:
                          typeof result === "string"
                            ? [{ type: "text", text: result }]
                            : result,
                      },
                    },
                    "*",
                  );
                }
              } catch (error) {
                if (data.id !== undefined) {
                  iframe.contentWindow.postMessage(
                    {
                      jsonrpc: "2.0",
                      id: data.id,
                      error: {
                        code: -32603,
                        message:
                          error instanceof Error
                            ? error.message
                            : "Tool call failed",
                      },
                    },
                    "*",
                  );
                }
              }
            }
            break;
          }

          case "ui/open-link": {
            // App wants to open a URL
            if (data.params?.url) {
              window.open(data.params.url, "_blank", "noopener,noreferrer");
            }
            if (data.id !== undefined) {
              iframe.contentWindow.postMessage(
                { jsonrpc: "2.0", id: data.id, result: {} },
                "*",
              );
            }
            break;
          }

          case "ui/message": {
            // App wants to send a message to the chat
            if (onMessage && data.params?.content) {
              onMessage({ content: data.params.content });
            }
            if (data.id !== undefined) {
              iframe.contentWindow.postMessage(
                { jsonrpc: "2.0", id: data.id, result: {} },
                "*",
              );
            }
            break;
          }

          case "ui/request-display-mode": {
            // For now, always stay inline
            if (data.id !== undefined) {
              iframe.contentWindow.postMessage(
                {
                  jsonrpc: "2.0",
                  id: data.id,
                  result: { displayMode: "inline" },
                },
                "*",
              );
            }
            break;
          }

          case "ui/update-model-context": {
            // Accept context updates silently
            if (data.id !== undefined) {
              iframe.contentWindow.postMessage(
                { jsonrpc: "2.0", id: data.id, result: {} },
                "*",
              );
            }
            break;
          }

          default:
            // Unknown method - respond with error if it expects a response
            if (data.id !== undefined) {
              iframe.contentWindow.postMessage(
                {
                  jsonrpc: "2.0",
                  id: data.id,
                  error: {
                    code: -32601,
                    message: `Method not found: ${data.method}`,
                  },
                },
                "*",
              );
            }
        }
      }

      // Handle JSON-RPC responses (from our requests to the app)
      if (data.id !== undefined && (data.result !== undefined || data.error)) {
        const pending = pendingRequestsRef.current.get(data.id);
        if (pending) {
          pendingRequestsRef.current.delete(data.id);
          if (data.error) {
            pending.reject(new Error(data.error.message));
          } else {
            pending.resolve(data.result);
          }
        }
      }
    },
    [resolvedTheme, toolInput, toolResult, onToolCall, onMessage],
  );

  // Listen for postMessage events
  useEffect(() => {
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [handleMessage]);

  // Send tool input updates when they change after initialization
  useEffect(() => {
    if (!isInitialized || !toolInput) return;
    const iframe = iframeRef.current;
    if (!iframe?.contentWindow) return;

    iframe.contentWindow.postMessage(
      {
        jsonrpc: "2.0",
        method: "ui/notifications/tool-input",
        params: { arguments: toolInput },
      },
      "*",
    );
  }, [isInitialized, toolInput]);

  // Send tool result updates when they change after initialization
  useEffect(() => {
    if (!isInitialized || !toolResult) return;
    const iframe = iframeRef.current;
    if (!iframe?.contentWindow) return;

    iframe.contentWindow.postMessage(
      {
        jsonrpc: "2.0",
        method: "ui/notifications/tool-result",
        params: {
          content:
            typeof toolResult === "string"
              ? [{ type: "text", text: toolResult }]
              : Array.isArray(toolResult)
                ? toolResult
                : [{ type: "text", text: JSON.stringify(toolResult) }],
        },
      },
      "*",
    );
  }, [isInitialized, toolResult]);

  // Create blob URL for the iframe content
  const blobUrl = useRef<string | null>(null);
  useEffect(() => {
    const blob = new Blob([preparedHtml], { type: "text/html" });
    blobUrl.current = URL.createObjectURL(blob);
    return () => {
      if (blobUrl.current) {
        URL.revokeObjectURL(blobUrl.current);
      }
    };
  }, [preparedHtml]);

  return (
    <div
      className={cn(
        "w-full rounded-lg overflow-hidden my-2",
        prefersBorder && "border border-border",
        className,
      )}
    >
      <iframe
        ref={iframeRef}
        src={blobUrl.current || "about:blank"}
        sandbox={sandboxAttrs}
        title="MCP App"
        className="w-full border-0"
        style={{ height: `${iframeHeight}px`, minHeight: "200px" }}
        onLoad={() => {
          // Auto-resize iframe based on content
          const iframe = iframeRef.current;
          if (iframe?.contentWindow) {
            try {
              const body = iframe.contentDocument?.body;
              if (body) {
                const newHeight = Math.min(
                  Math.max(body.scrollHeight, 200),
                  800,
                );
                setIframeHeight(newHeight);
              }
            } catch {
              // Cross-origin - use default height
            }
          }
        }}
      />
    </div>
  );
}

// =============================================================================
// Internal helpers
// =============================================================================

function buildSandboxAttrs(
  permissions?: McpAppRendererProps["permissions"],
): string {
  const attrs = ["allow-scripts"];

  // Add permission-specific sandbox relaxations
  if (permissions?.camera || permissions?.microphone) {
    // These require allow-same-origin for getUserMedia
    attrs.push("allow-same-origin");
  }

  return attrs.join(" ");
}

function buildCspMeta(csp?: McpAppRendererProps["csp"]): string {
  const directives: string[] = ["default-src 'none'"];
  directives.push("script-src 'unsafe-inline' 'unsafe-eval'");
  directives.push("style-src 'unsafe-inline'");

  if (csp?.connectDomains?.length) {
    directives.push(
      `connect-src ${csp.connectDomains.map((d) => `https://${d}`).join(" ")}`,
    );
  }

  if (csp?.resourceDomains?.length) {
    const domains = csp.resourceDomains.map((d) => `https://${d}`).join(" ");
    directives.push(`img-src ${domains}`);
    directives.push(`font-src ${domains}`);
  }

  if (csp?.frameDomains?.length) {
    directives.push(
      `frame-src ${csp.frameDomains.map((d) => `https://${d}`).join(" ")}`,
    );
  }

  return `<meta http-equiv="Content-Security-Policy" content="${directives.join("; ")}">`;
}

function prepareHtmlContent(html: string, cspMeta: string): string {
  // Inject CSP meta tag into the HTML head
  if (html.includes("<head>")) {
    return html.replace("<head>", `<head>\n${cspMeta}`);
  }
  if (html.includes("<html>")) {
    return html.replace("<html>", `<html><head>${cspMeta}</head>`);
  }
  // If no head/html tags, wrap the content
  return `<!DOCTYPE html><html><head>${cspMeta}</head><body>${html}</body></html>`;
}

function getThemeVariables(
  theme: string | undefined,
): Record<string, string> {
  const isDark = theme === "dark";
  return {
    "--color-text-primary": isDark ? "#fafafa" : "#171717",
    "--color-text-secondary": isDark ? "#a1a1aa" : "#71717a",
    "--color-bg-primary": isDark ? "#09090b" : "#ffffff",
    "--color-bg-secondary": isDark ? "#18181b" : "#f4f4f5",
    "--color-border": isDark ? "#27272a" : "#e4e4e7",
    "--color-accent": isDark ? "#3b82f6" : "#2563eb",
    "--font-sans": "system-ui, -apple-system, sans-serif",
    "--border-radius-md": "8px",
  };
}
