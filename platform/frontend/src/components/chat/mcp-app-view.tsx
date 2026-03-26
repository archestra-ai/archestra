import { useCallback, useEffect, useRef, useState } from "react";
import { useMcpAppResource } from "@/hooks/use-mcp-app-resource";

// ── Types ──────────────────────────────────────────────────────────────────────

interface McpAppViewProps {
  /** The ui:// resource URI returned in tool result _meta.ui.resourceUri */
  resourceUri: string;
  /** The original tool call arguments, forwarded to the app after it signals ready */
  toolArgs?: Record<string, unknown>;
  /** The tool result payload, forwarded to the app after it signals ready */
  toolResult?: unknown;
  /** Called when the iframe app sends a tools/call request */
  onToolCall?: (
    toolName: string,
    args: Record<string, unknown>,
  ) => Promise<unknown>;
}

// Messages sent FROM parent → iframe
type ParentToAppMessage =
  | { type: "ui/init"; toolArgs: unknown; toolResult: unknown }
  | { type: "tools/result"; id: string; result: unknown }
  | { type: "tools/error"; id: string; error: string };

// Messages sent FROM iframe → parent
type AppToParentMessage =
  | { type: "ui/ready" }
  | {
      type: "tools/call";
      id: string;
      toolName: string;
      args: Record<string, unknown>;
    }
  | { type: "ui/resize"; height: number };

// ── Component ──────────────────────────────────────────────────────────────────

export function McpAppView({
  resourceUri,
  toolArgs = {},
  toolResult,
  onToolCall,
}: McpAppViewProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const { html, loading, error } = useMcpAppResource(resourceUri);
  const [iframeHeight, setIframeHeight] = useState(400);
  const [appReady, setAppReady] = useState(false);

  // Build a blob URL from the fetched HTML so we can set it as the iframe src.
  // Using srcdoc would work too, but blob URLs give us a cleaner origin boundary.
  const [blobUrl, setBlobUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!html) return;
    const blob = new Blob([html], { type: "text/html" });
    const url = URL.createObjectURL(blob);
    setBlobUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [html]);

  // Send a typed message to the iframe
  const postToApp = useCallback((msg: ParentToAppMessage) => {
    iframeRef.current?.contentWindow?.postMessage(msg, "*");
  }, []);

  // Listen for messages coming FROM the iframe
  useEffect(() => {
    const handler = async (event: MessageEvent) => {
      // Only accept messages from our blob iframe (null origin for blob URLs)
      const msg = event.data as AppToParentMessage;
      if (!msg?.type) return;

      switch (msg.type) {
        case "ui/ready": {
          setAppReady(true);
          postToApp({ type: "ui/init", toolArgs, toolResult });
          break;
        }

        case "ui/resize": {
          setIframeHeight(msg.height);
          break;
        }

        case "tools/call": {
          if (!onToolCall) {
            postToApp({
              type: "tools/error",
              id: msg.id,
              error: "No tool call handler registered",
            });
            return;
          }
          try {
            const result = await onToolCall(msg.toolName, msg.args);
            postToApp({ type: "tools/result", id: msg.id, result });
          } catch (err) {
            postToApp({
              type: "tools/error",
              id: msg.id,
              error: err instanceof Error ? err.message : String(err),
            });
          }
          break;
        }
      }
    };

    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [toolArgs, toolResult, onToolCall, postToApp]);

  // Re-send init if props change after ready (e.g. streaming result arrives)
  useEffect(() => {
    if (appReady) {
      postToApp({ type: "ui/init", toolArgs, toolResult });
    }
  }, [toolArgs, toolResult, appReady, postToApp]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-24 text-sm text-muted-foreground">
        Loading app…
      </div>
    );
  }

  if (error) {
    return (
      <div className="text-sm text-destructive px-3 py-2 rounded border border-destructive/30 bg-destructive/10">
        Failed to load MCP app: {error}
      </div>
    );
  }

  if (!blobUrl) return null;

  return (
    <div className="w-full mt-2 rounded-lg overflow-hidden border border-border">
      <iframe
        ref={iframeRef}
        src={blobUrl}
        style={{ width: "100%", height: iframeHeight, border: "none" }}
        // Restrict what the sandboxed app can do while still allowing scripts and forms
        sandbox="allow-scripts allow-forms allow-popups allow-same-origin"
        title="MCP App View"
      />
    </div>
  );
}
