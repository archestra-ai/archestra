"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { ExternalLink, FileText, Image as ImageIcon } from "lucide-react";
import { useState } from "react";

export interface MCPContent {
  type: "text" | "image" | "resource";
  text?: string;
  data?: string;
  mimeType?: string;
  resource?: {
    uri: string;
    mimeType?: string;
    text?: string;
    blob?: string;
  };
}

interface MCPUIRendererProps {
  content: MCPContent | MCPContent[];
  className?: string;
}

export function MCPUIRenderer({ content, className }: MCPUIRendererProps) {
  const contents = Array.isArray(content) ? content : [content];

  return (
    <div className={cn("space-y-4", className)}>
      {contents.map((item, index) => (
        <div key={`${item.type}-${index}`}>
          <MCPContentItem item={item} />
        </div>
      ))}
    </div>
  );
}

function MCPContentItem({ item }: { item: MCPContent }) {
  switch (item.type) {
    case "text":
      return <p className="text-sm whitespace-pre-wrap">{item.text}</p>;

    case "image":
      return (
        <div className="rounded-lg overflow-hidden border bg-muted/30">
          <img
            src={`data:${item.mimeType || "image/png"};base64,${item.data}`}
            alt="MCP Generated Content"
            className="max-w-full h-auto object-contain mx-auto"
          />
        </div>
      );

    case "resource":
      return <MCPResourceItem resource={item.resource!} />;

    default:
      return (
        <div className="text-xs text-muted-foreground italic">
          Unsupported MCP content type: {item.type}
        </div>
      );
  }
}

function MCPResourceItem({ resource }: { resource: NonNullable<MCPContent["resource"]> }) {
  const [isExpanded, setIsExpanded] = useState(false);

  // If it's a UI resource (often HTML/React via iframe)
  const isHtml = resource.mimeType === "text/html" || resource.uri.endsWith(".html");

  if (isHtml && resource.text) {
    return (
      <div className="rounded-lg border bg-card overflow-hidden">
        <div className="flex items-center justify-between px-3 py-2 border-b bg-muted/20">
          <div className="flex items-center gap-2">
            <ExternalLink className="w-3.5 h-3.5 text-primary" />
            <span className="text-xs font-medium truncate max-w-[200px]">
              {resource.uri}
            </span>
          </div>
          <button
            type="button"
            onClick={() => setIsExpanded(!isExpanded)}
            className="text-[10px] text-primary hover:underline"
          >
            {isExpanded ? "Collapse" : "Expand UI"}
          </button>
        </div>
        {isExpanded && (
          <div className="aspect-video w-full bg-white">
            <iframe
              srcDoc={resource.text}
              title="MCP UI Resource"
              className="w-full h-full border-none"
              sandbox="allow-scripts allow-forms"
            />
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="rounded-lg border p-3 bg-muted/10">
      <div className="flex items-center gap-2 mb-2">
        <FileText className="w-4 h-4 text-muted-foreground" />
        <span className="text-xs font-medium truncate">{resource.uri}</span>
        {resource.mimeType && (
          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground">
            {resource.mimeType}
          </span>
        )}
      </div>
      {resource.text && (
        <pre className="text-[10px] bg-muted/50 p-2 rounded overflow-x-auto max-h-40">
          {resource.text}
        </pre>
      )}
    </div>
  );
}