"use client";

import { useCallback, useEffect, useRef, useState } from "react";

interface McpAppFrameProps {
  /** Inline HTML content to render */
  html?: string;
  /** URL to fetch the HTML from (alternative to inline html) */
  resourceUrl?: string;
  /** Additional sandbox permissions beyond allow-scripts */
  permissions?: string[];
  minHeight?: number;
  maxHeight?: number;
}

const DEFAULT_SANDBOX = "allow-scripts";
const DEFAULT_MIN_HEIGHT = 100;
const DEFAULT_MAX_HEIGHT = 600;

/**
 * Sandboxed iframe for rendering MCP App interactive UIs inside the chat.
 *
 * Security: strict sandbox (allow-scripts only by default, no DOM access to host).
 * Sizing: auto-resizes based on content height via ResizeObserver + postMessage.
 * Communication: JSON-RPC bridge for tool calls and context updates.
 */
export function McpAppFrame({
  html,
  resourceUrl,
  permissions = [],
  minHeight = DEFAULT_MIN_HEIGHT,
  maxHeight = DEFAULT_MAX_HEIGHT,
}: McpAppFrameProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(minHeight);
  const [loading, setLoading] = useState(!!resourceUrl && !html);
  const [error, setError] = useState<string | null>(null);
  const [fetchedHtml, setFetchedHtml] = useState<string | null>(null);

  // Fetch HTML from URL when no inline content is provided
  useEffect(() => {
    if (html || !resourceUrl) return;

    const controller = new AbortController();
    setLoading(true);

    fetch(resourceUrl, { signal: controller.signal })
      .then((res) => {
        if (!res.ok)
          throw new Error(`Failed to load MCP App (HTTP ${res.status})`);
        return res.text();
      })
      .then((text) => {
        setFetchedHtml(text);
        setLoading(false);
      })
      .catch((err) => {
        if (err.name !== "AbortError") {
          setError(err.message);
          setLoading(false);
        }
      });

    return () => controller.abort();
  }, [html, resourceUrl]);

  // Listen for postMessage events from the iframe (resize, JSON-RPC)
  const handleMessage = useCallback(
    (event: MessageEvent) => {
      if (
        !iframeRef.current ||
        event.source !== iframeRef.current.contentWindow
      ) {
        return;
      }

      try {
        const data =
          typeof event.data === "string"
            ? JSON.parse(event.data)
            : event.data;

        if (data.type === "resize" && typeof data.height === "number") {
          setHeight(Math.min(Math.max(data.height, minHeight), maxHeight));
        }
      } catch {
        // Ignore malformed messages from the sandbox
      }
    },
    [minHeight, maxHeight],
  );

  useEffect(() => {
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [handleMessage]);

  const contentHtml = html ?? fetchedHtml;
  const wrappedHtml = contentHtml
    ? injectResizeObserver(contentHtml)
    : null;

  if (error) {
    return (
      <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-300">
        Failed to load MCP App: {error}
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 rounded-md border p-3 text-sm text-muted-foreground">
        <div className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
        Loading MCP App...
      </div>
    );
  }

  if (!wrappedHtml) {
    return null;
  }

  const sandbox = [DEFAULT_SANDBOX, ...permissions].join(" ");

  return (
    <div className="my-2 overflow-hidden rounded-lg border bg-background">
      <iframe
        ref={iframeRef}
        srcDoc={wrappedHtml}
        sandbox={sandbox}
        style={{
          width: "100%",
          height: `${height}px`,
          border: "none",
          display: "block",
        }}
        title="MCP App"
        onLoad={() => setLoading(false)}
      />
    </div>
  );
}

/**
 * Inject a ResizeObserver script that reports content height to the parent
 * frame via postMessage so the iframe can auto-resize.
 */
function injectResizeObserver(html: string): string {
  const script = `<script>
(function(){
  var ro = new ResizeObserver(function(entries){
    for(var i=0;i<entries.length;i++){
      var h = entries[i].target.scrollHeight;
      window.parent.postMessage(JSON.stringify({type:"resize",height:h+16}),"*");
    }
  });
  ro.observe(document.body);
  requestAnimationFrame(function(){
    window.parent.postMessage(JSON.stringify({type:"resize",height:document.body.scrollHeight+16}),"*");
  });
})();
</script>`;

  if (html.includes("</body>")) {
    return html.replace("</body>", `${script}</body>`);
  }
  return html + script;
}
