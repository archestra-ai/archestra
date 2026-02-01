"use client";

import { ExternalLink, FileText } from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils";

/**
 * MCP content item types as defined by the MCP protocol.
 * Tool results can contain text, image, and resource items.
 */
export interface MCPContentItem {
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

interface McpUiRendererProps {
  content: MCPContentItem[];
  className?: string;
}

/**
 * Renders MCP content items including text, images, and UI resources.
 * For resource items with ui:// URIs, renders interactive content in sandboxed iframes.
 * Supports both inline HTML resources and text/blob resources.
 */
export function McpUiRenderer({ content, className }: McpUiRendererProps) {
  if (!Array.isArray(content) || content.length === 0) {
    return null;
  }

  return (
    <div className={cn("space-y-3", className)}>
      {content.map((item, index) => (
        <McpContentItemRenderer
          key={`mcp-content-${item.type}-${index}`}
          item={item}
        />
      ))}
    </div>
  );
}

function McpContentItemRenderer({ item }: { item: MCPContentItem }) {
  switch (item.type) {
    case "text":
      return <p className="text-sm whitespace-pre-wrap">{item.text}</p>;

    case "image":
      return (
        <div className="rounded-lg overflow-hidden border bg-muted/30">
          <img
            src={`data:${item.mimeType || "image/png"};base64,${item.data}`}
            alt="MCP generated content"
            className="max-w-full h-auto object-contain mx-auto"
          />
        </div>
      );

    case "resource":
      if (!item.resource) {
        return (
          <div className="text-xs text-muted-foreground italic">
            Missing resource data
          </div>
        );
      }
      return <McpResourceRenderer resource={item.resource} />;

    default:
      return (
        <div className="text-xs text-muted-foreground italic">
          Unsupported MCP content type: {item.type}
        </div>
      );
  }
}

/**
 * Renders an MCP resource item.
 * - HTML resources (text/html, text/html;profile=mcp-app) are rendered in sandboxed iframes
 * - Other resources show metadata and content preview
 */
function McpResourceRenderer({
  resource,
}: {
  resource: NonNullable<MCPContentItem["resource"]>;
}) {
  const [isExpanded, setIsExpanded] = useState(false);

  const isHtml =
    resource.mimeType === "text/html" ||
    resource.mimeType === "text/html;profile=mcp-app" ||
    resource.uri.endsWith(".html");

  const isUiResource = resource.uri?.startsWith("ui://");

  // HTML UI resources rendered in sandboxed iframes
  if ((isHtml || isUiResource) && resource.text) {
    return (
      <div className="rounded-lg border bg-card overflow-hidden">
        <div className="flex items-center justify-between px-3 py-2 border-b bg-muted/20">
          <div className="flex items-center gap-2">
            <ExternalLink className="w-3.5 h-3.5 text-primary" />
            <span className="text-xs font-medium truncate max-w-[250px]">
              {resource.uri}
            </span>
            {isUiResource && (
              <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-primary/10 text-primary">
                MCP UI
              </span>
            )}
          </div>
          <button
            type="button"
            onClick={() => setIsExpanded(!isExpanded)}
            className="text-[10px] text-primary hover:underline cursor-pointer"
          >
            {isExpanded ? "Collapse" : "Expand UI"}
          </button>
        </div>
        {isExpanded && (
          <div className="w-full bg-white" style={{ minHeight: "200px" }}>
            <iframe
              srcDoc={resource.text}
              title={`MCP UI Resource: ${resource.uri}`}
              className="w-full border-none"
              style={{ minHeight: "300px", height: "400px" }}
              sandbox="allow-scripts"
            />
          </div>
        )}
      </div>
    );
  }

  // Blob-based HTML resources
  if ((isHtml || isUiResource) && resource.blob) {
    const decodedHtml = atob(resource.blob);
    return (
      <div className="rounded-lg border bg-card overflow-hidden">
        <div className="flex items-center justify-between px-3 py-2 border-b bg-muted/20">
          <div className="flex items-center gap-2">
            <ExternalLink className="w-3.5 h-3.5 text-primary" />
            <span className="text-xs font-medium truncate max-w-[250px]">
              {resource.uri}
            </span>
          </div>
          <button
            type="button"
            onClick={() => setIsExpanded(!isExpanded)}
            className="text-[10px] text-primary hover:underline cursor-pointer"
          >
            {isExpanded ? "Collapse" : "Expand UI"}
          </button>
        </div>
        {isExpanded && (
          <div className="w-full bg-white" style={{ minHeight: "200px" }}>
            <iframe
              srcDoc={decodedHtml}
              title={`MCP UI Resource: ${resource.uri}`}
              className="w-full border-none"
              style={{ minHeight: "300px", height: "400px" }}
              sandbox="allow-scripts"
            />
          </div>
        )}
      </div>
    );
  }

  // Non-HTML resources: show metadata and text preview
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

/**
 * Checks if a string output from a tool result contains MCP content items.
 * MCP content is a JSON array where items have type "text", "image", or "resource".
 */
export function parseMcpContent(output: unknown): MCPContentItem[] | null {
  if (typeof output !== "string") return null;

  try {
    const parsed = JSON.parse(output);
    if (!Array.isArray(parsed)) return null;

    // Validate that it looks like MCP content (array of items with type field)
    const isMcpContent = parsed.every(
      (item: unknown) =>
        typeof item === "object" &&
        item !== null &&
        "type" in item &&
        typeof (item as Record<string, unknown>).type === "string",
    );

    if (!isMcpContent) return null;

    // Check if any items are resources (especially ui:// resources) or images
    const hasRichContent = parsed.some(
      (item: MCPContentItem) =>
        item.type === "resource" || item.type === "image",
    );

    if (!hasRichContent) return null;

    return parsed as MCPContentItem[];
  } catch {
    return null;
  }
}
