"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export type McpToolOutput = {
  content: string;
  _meta?: Record<string, unknown>;
  structuredContent?: Record<string, unknown>;
  rawContent?: Array<{
    type: string;
    text?: string;
    mimeType?: string;
    blob?: string;
    uri?: string;
  }>;
};

export function hasMcpAppContent(output: unknown): output is McpToolOutput {
  if (!output || typeof output !== "object") {
    if (typeof output === "string") {
      try {
        const parsed = JSON.parse(output);
        return hasMcpAppContent(parsed);
      } catch {
        return (
          output.includes("<!DOCTYPE") ||
          output.includes("<html") ||
          output.includes("text/html")
        );
      }
    }
    return false;
  }

  const obj = output as Record<string, unknown>;

  if (obj.structuredContent || obj._meta) return true;

  if (Array.isArray(obj.rawContent)) {
    return obj.rawContent.some(
      (item: Record<string, unknown>) =>
        item.mimeType === "text/html" || item.blob || item.uri,
    );
  }

  return false;
}

function extractHtmlContent(output: unknown): string | null {
  let data: McpToolOutput;

  if (typeof output === "string") {
    try {
      data = JSON.parse(output);
    } catch {
      if (output.includes("<html") || output.includes("<!DOCTYPE")) {
        return output;
      }
      return null;
    }
  } else {
    data = output as McpToolOutput;
  }

  if (Array.isArray(data.rawContent)) {
    for (const item of data.rawContent) {
      if (item.mimeType === "text/html" && item.text) {
        return item.text;
      }
      if (item.blob) {
        try {
          return atob(item.blob);
        } catch {
          return item.blob;
        }
      }
    }
  }

  if (data.structuredContent) {
    const sc = data.structuredContent as Record<string, unknown>;
    if (typeof sc.html === "string") return sc.html;
    if (typeof sc.content === "string" && sc.content.includes("<")) {
      return sc.content;
    }
  }

  if (typeof data.content === "string") {
    if (data.content.includes("<html") || data.content.includes("<!DOCTYPE")) {
      return data.content;
    }
  }

  return null;
}

const MIN_HEIGHT = 100;
const MAX_HEIGHT = 600;
const DEFAULT_HEIGHT = 300;

export function MCPAppRenderer({
  output,
  toolName,
  agentId: _agentId,
}: {
  output: unknown;
  toolName: string;
  agentId?: string;
}) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(DEFAULT_HEIGHT);

  const htmlContent = extractHtmlContent(output);

  const blobUrl = useMemo(() => {
    if (!htmlContent) return null;
    const blob = new Blob([htmlContent], { type: "text/html" });
    return URL.createObjectURL(blob);
  }, [htmlContent]);

  useEffect(() => {
    return () => {
      if (blobUrl) {
        URL.revokeObjectURL(blobUrl);
      }
    };
  }, [blobUrl]);

  const handleMessage = useCallback((event: MessageEvent) => {
    if (!iframeRef.current || event.source !== iframeRef.current.contentWindow) {
      return;
    }

    const { data } = event;
    if (!data || typeof data !== "object" || !("jsonrpc" in data)) return;

    const request = data as {
      jsonrpc: string;
      method?: string;
      id?: string | number | null;
      params?: Record<string, unknown>;
    };

    const method = request.method;
    const id = request.id;
    const params = request.params;

    const respond = (
      result: unknown,
      error?: { code: number; message: string },
    ) => {
      iframeRef.current?.contentWindow?.postMessage(
        {
          jsonrpc: "2.0",
          id,
          ...(error ? { error } : { result }),
        },
        "*",
      );
    };

    switch (method) {
      case "ui/initialize":
        respond({ capabilities: { tools: true } });
        break;
      case "tools/call":
        respond(null, {
          code: -32601,
          message: "Tool calls from MCP Apps not yet supported",
        });
        break;
      case "ui/sendOpenLink": {
        const url = params?.url;
        if (typeof url === "string" && url.startsWith("https://")) {
          window.open(url, "_blank", "noopener,noreferrer");
          respond({});
        } else {
          respond(null, {
            code: -32602,
            message: "Only https: URLs are allowed",
          });
        }
        break;
      }
      case "ui/resize": {
        const requestedHeight = params?.height;
        if (typeof requestedHeight === "number") {
          setHeight(Math.min(Math.max(requestedHeight, MIN_HEIGHT), MAX_HEIGHT));
        }
        respond({});
        break;
      }
      case "ui/updateContext":
        respond({});
        break;
      default:
        respond(null, {
          code: -32601,
          message: `Method not found: ${String(method)}`,
        });
    }
  }, []);

  useEffect(() => {
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [handleMessage]);

  if (!htmlContent || !blobUrl) return null;

  return (
    <div className="my-2 overflow-hidden rounded-lg border border-border">
      <div className="flex items-center gap-2 border-b border-border bg-muted/50 px-3 py-1.5">
        <div className="h-2 w-2 rounded-full bg-green-500" />
        <span className="text-xs text-muted-foreground">MCP App: {toolName}</span>
      </div>
      <iframe
        ref={iframeRef}
        src={blobUrl}
        sandbox="allow-scripts allow-forms"
        style={{ width: "100%", height: `${height}px`, border: "none" }}
        title={`MCP App: ${toolName}`}
      />
    </div>
  );
}
