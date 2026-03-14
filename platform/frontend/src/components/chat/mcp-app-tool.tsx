"use client";

import type { DynamicToolUIPart, ToolUIPart } from "ai";
import { AppWindow, Loader2 } from "lucide-react";
import {
  Tool,
  ToolContent,
  ToolHeader,
} from "@/components/ai-elements/tool";
import { useMcpAppResource } from "@/lib/mcp-apps.query";
import { McpAppRenderer } from "./mcp-app-renderer";

/**
 * MCP App Tool component.
 * Renders an interactive MCP App UI for tools that support the MCP Apps extension.
 * Fetches the UI resource (HTML) and renders it in a sandboxed iframe with
 * the MCP Apps postMessage protocol.
 */
export function McpAppTool({
  toolName,
  agentId,
  part,
  toolResultPart,
  resourceUri,
  csp,
  permissions,
  prefersBorder,
}: {
  toolName: string;
  agentId: string;
  part: ToolUIPart | DynamicToolUIPart;
  toolResultPart: ToolUIPart | DynamicToolUIPart | null;
  resourceUri: string;
  csp?: {
    connectDomains?: string[];
    resourceDomains?: string[];
    frameDomains?: string[];
  };
  permissions?: {
    camera?: Record<string, never>;
    microphone?: Record<string, never>;
    geolocation?: Record<string, never>;
    clipboardWrite?: Record<string, never>;
  };
  prefersBorder?: boolean;
}) {
  const { data: resource, isLoading } = useMcpAppResource(
    agentId,
    resourceUri,
  );

  const htmlContent = resource?.text
    ? resource.text
    : resource?.blob
      ? atob(resource.blob)
      : null;

  const toolState =
    toolResultPart || part.state === "output-available"
      ? "output-available"
      : (part.state || "input-available");

  return (
    <Tool defaultOpen={true}>
      <ToolHeader
        type={`tool-${toolName}`}
        state={toolState}
        isCollapsible={true}
        actionButton={
          <span className="flex items-center gap-1 text-xs text-muted-foreground">
            <AppWindow className="size-3" />
            MCP App
          </span>
        }
      />
      <ToolContent>
        {isLoading && (
          <div className="flex items-center justify-center p-8">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
            <span className="ml-2 text-sm text-muted-foreground">
              Loading MCP App...
            </span>
          </div>
        )}

        {!isLoading && htmlContent && (
          <McpAppRenderer
            htmlContent={htmlContent}
            toolInput={part.input as Record<string, unknown>}
            toolResult={
              toolResultPart?.output ?? part.output
            }
            csp={csp}
            permissions={permissions}
            prefersBorder={prefersBorder}
          />
        )}

        {!isLoading && !htmlContent && (
          <div className="p-4 text-sm text-muted-foreground">
            Failed to load MCP App UI resource.
          </div>
        )}
      </ToolContent>
    </Tool>
  );
}
