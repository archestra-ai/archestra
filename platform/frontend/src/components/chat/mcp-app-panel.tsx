"use client";

import { X } from "lucide-react";
import { Button } from "@/components/ui/button";

interface McpAppPanelProps {
  url: string;
  title: string;
  onClose: () => void;
}

/**
 * MCP App Panel - The visual container for third-party MCP Apps (e.g. Excalidraw)
 */
export function McpAppPanel({ url, title, onClose }: McpAppPanelProps) {
  return (
    <div className="flex flex-col h-full bg-background border-l">
      <div className="flex items-center justify-between p-3 border-b">
        <h3 className="text-sm font-semibold truncate">{title}</h3>
        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onClose}>
          <X className="h-4 w-4" />
        </Button>
      </div>
      <div className="flex-1 w-full h-full overflow-hidden">
        <iframe
          src={url}
          className="w-full h-full border-none"
          title={`MCP App: ${title}`}
          sandbox="allow-scripts allow-same-origin allow-forms"
        />
      </div>
    </div>
  );
}
