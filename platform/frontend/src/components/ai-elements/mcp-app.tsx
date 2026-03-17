"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

interface McpAppProps {
  serverId: string;
  resourceUri: string;
  className?: string;
}

export function McpApp({ serverId, resourceUri, className }: McpAppProps) {
  const [html, setHtml] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    async function fetchApp() {
      try {
        setIsLoading(true);
        const response = await fetch(
          `/api/mcp_server/${serverId}/resources/read?uri=${encodeURIComponent(
            resourceUri,
          )}`,
        );
        if (!response.ok) {
          throw new Error(`Failed to fetch MCP App: ${response.statusText}`);
        }
        const data = await response.json();
        // data.contents is an array, we want the first one with text
        const content = data.contents?.[0]?.text;
        if (!content) {
          throw new Error("MCP App resource returned no content");
        }
        setHtml(content);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setIsLoading(false);
      }
    }

    fetchApp();
  }, [serverId, resourceUri]);

  useEffect(() => {
    if (!html || !iframeRef.current) return;

    const iframe = iframeRef.current;
    const doc = iframe.contentDocument || iframe.contentWindow?.document;
    if (!doc) return;

    doc.open();
    doc.write(html);
    doc.close();

    // Setup postMessage bridge
    const handleMessage = (event: MessageEvent) => {
      if (event.source !== iframe.contentWindow) return;

      // Handle JSON-RPC from MCP App
      // For now, we just log it. In a real implementation, we would 
      // handle tool calls, etc.
      console.log("MCP App Message:", event.data);
    };

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [html]);

  if (isLoading) {
    return (
      <div className={cn("flex items-center justify-center p-8", className)}>
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error) {
    return (
      <div className={cn("p-4 text-sm text-destructive bg-destructive/10 rounded-md", className)}>
        Error loading MCP App: {error}
      </div>
    );
  }

  return (
    <div className={cn("relative w-full aspect-video border rounded-md overflow-hidden bg-white", className)}>
      <iframe
        ref={iframeRef}
        title="MCP App"
        className="w-full h-full border-none"
        sandbox="allow-scripts allow-forms allow-popups allow-modals"
      />
    </div>
  );
}
