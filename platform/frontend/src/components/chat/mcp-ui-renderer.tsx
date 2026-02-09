"use client";

import type { McpUiResource } from "@shared";
import { useCallback, useEffect, useRef, useState } from "react";

interface McpUiRendererProps {
  resource: McpUiResource;
  className?: string;
}

/**
 * Renders an MCP-UI resource inside a sandboxed iframe.
 *
 * Supports three MIME types:
 * - text/html: inline HTML rendered via srcDoc
 * - text/uri-list: external URL loaded in iframe
 * - application/vnd.mcp-ui.remote-dom: remote DOM script (future)
 *
 * Security: iframe uses sandbox="allow-scripts" only (no allow-same-origin)
 * to prevent the guest from accessing the host page.
 */
export function McpUiRenderer({ resource, className }: McpUiRendererProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [iframeHeight, setIframeHeight] = useState(300);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Listen for resize messages from the guest iframe
  const handleMessage = useCallback((event: MessageEvent) => {
    // Only accept messages from our iframe
    if (iframeRef.current && event.source === iframeRef.current.contentWindow) {
      try {
        const data =
          typeof event.data === "string" ? JSON.parse(event.data) : event.data;

        // Handle resize messages
        if (data.type === "mcp-ui-resize" && typeof data.height === "number") {
          setIframeHeight(Math.min(Math.max(data.height, 100), 800));
        }
      } catch {
        // Ignore unparseable messages
      }
    }
  }, []);

  useEffect(() => {
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [handleMessage]);

  // Determine content to render
  const content = resource.text ?? (resource.blob ? atob(resource.blob) : null);

  if (!content) {
    return (
      <div className="text-sm text-muted-foreground italic p-3 border rounded-md">
        MCP-UI resource has no content
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="text-sm text-destructive p-3 border border-destructive/20 rounded-md">
        Failed to load MCP-UI: {loadError}
      </div>
    );
  }

  // Wrap HTML content with auto-resize script
  const wrappedHtml =
    resource.mimeType === "text/html"
      ? wrapHtmlWithResizeScript(content)
      : content;

  if (resource.mimeType === "text/uri-list") {
    // External URL: load in iframe with src
    const url = content.trim().split("\n")[0];
    return (
      <iframe
        ref={iframeRef}
        src={url}
        title="MCP-UI Resource"
        sandbox="allow-scripts"
        style={{ height: `${iframeHeight}px` }}
        className={`w-full rounded-lg border bg-background ${className ?? ""}`}
        onError={() => setLoadError("Failed to load external resource")}
      />
    );
  }

  // text/html or remote-dom: inline via srcDoc
  return (
    <iframe
      ref={iframeRef}
      srcDoc={wrappedHtml}
      title="MCP-UI Resource"
      sandbox="allow-scripts"
      style={{ height: `${iframeHeight}px` }}
      className={`w-full rounded-lg border bg-background ${className ?? ""}`}
      onError={() => setLoadError("Failed to render MCP-UI content")}
    />
  );
}

// =============================================================================
// Internal helpers
// =============================================================================

/** Inject an auto-resize script into HTML content so the iframe adjusts height */
function wrapHtmlWithResizeScript(html: string): string {
  const resizeScript = `
<script>
(function() {
  function sendHeight() {
    var height = Math.max(
      document.body.scrollHeight,
      document.body.offsetHeight,
      document.documentElement.scrollHeight
    );
    parent.postMessage(JSON.stringify({ type: 'mcp-ui-resize', height: height }), '*');
  }
  // Send height on load and on resize
  if (document.readyState === 'complete') sendHeight();
  else window.addEventListener('load', sendHeight);
  window.addEventListener('resize', sendHeight);
  // Also observe DOM mutations for dynamic content
  var observer = new MutationObserver(sendHeight);
  observer.observe(document.body, { childList: true, subtree: true, attributes: true });
})();
</script>`;

  // Insert before </body> if it exists, otherwise append
  if (html.includes("</body>")) {
    return html.replace("</body>", `${resizeScript}</body>`);
  }
  return html + resizeScript;
}
