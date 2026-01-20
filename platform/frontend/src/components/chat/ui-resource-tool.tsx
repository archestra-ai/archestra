"use client";

import type { UIActionResult } from "@mcp-ui/client";
import { UIResourceRenderer } from "@mcp-ui/client";
import type { DynamicToolUIPart, ToolUIPart } from "ai";
import { ExternalLinkIcon, LayoutDashboardIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import {
  Tool,
  ToolContent,
  ToolHeader,
  ToolInput,
} from "@/components/ai-elements/tool";
import { cn } from "@/lib/utils";
import { extractUIResource, type UIResource } from "./ui-resource.utils";

const SAFE_PROTOCOLS = ["http:", "https:"];

interface UIResourceToolProps {
  part: ToolUIPart | DynamicToolUIPart;
  toolResultPart: ToolUIPart | DynamicToolUIPart | null;
  toolName: string;
  errorText?: string;
  onToolCall?: (toolName: string, params: Record<string, unknown>) => void;
  onPrompt?: (prompt: string) => void;
}

export function UIResourceTool({
  part,
  toolResultPart,
  toolName,
  errorText,
  onToolCall,
  onPrompt,
}: UIResourceToolProps) {
  const [expanded, setExpanded] = useState(true);

  const output = toolResultPart?.output ?? part.output;
  const resource = extractUIResource(output);

  if (!resource) {
    return null;
  }

  const handleUIAction = async (action: UIActionResult): Promise<unknown> => {
    switch (action.type) {
      case "tool":
        onToolCall?.(action.payload.toolName, action.payload.params);
        return { success: true };
      case "prompt":
        onPrompt?.(action.payload.prompt);
        return { success: true };
      case "link": {
        const url = action.payload.url;
        try {
          const parsed = new URL(url);
          if (!SAFE_PROTOCOLS.includes(parsed.protocol)) {
            return { success: false, error: "Unsafe URL protocol" };
          }
          window.open(url, "_blank", "noopener,noreferrer");
          return { success: true };
        } catch {
          return { success: false, error: "Invalid URL" };
        }
      }
      case "notify": {
        const message =
          typeof action.payload === "object" && action.payload !== null
            ? (action.payload as { message?: string }).message
            : undefined;
        toast.info(message || "Notification from MCP UI");
        return { success: true };
      }
      case "intent":
        onPrompt?.(action.payload.intent);
        return { success: true };
      default:
        return { success: false, error: "Unknown action type" };
    }
  };

  const inputObj =
    part.input && typeof part.input === "object"
      ? (part.input as Record<string, unknown>)
      : null;
  const hasInput = inputObj && Object.keys(inputObj).length > 0;
  const state = getState(part, toolResultPart, errorText);

  return (
    <Tool open={expanded} onOpenChange={setExpanded}>
      <ToolHeader
        type={`tool-${toolName}`}
        title={toolName}
        state={state}
        errorText={errorText}
        icon={<LayoutDashboardIcon className="size-4 text-muted-foreground" />}
        isCollapsible={true}
      />
      <ToolContent>
        {hasInput ? <ToolInput input={inputObj} /> : null}
        <UIResourceOutput resource={resource} onUIAction={handleUIAction} />
      </ToolContent>
    </Tool>
  );
}

function isSafeUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return SAFE_PROTOCOLS.includes(parsed.protocol);
  } catch {
    return false;
  }
}

function UIResourceOutput({
  resource,
  onUIAction,
}: {
  resource: UIResource;
  onUIAction: (action: UIActionResult) => Promise<unknown>;
}) {
  const isExternalUrl = resource.mimeType === "text/uri-list";
  const externalUrl = isExternalUrl && resource.text ? resource.text : null;
  const safeExternalUrl =
    externalUrl && isSafeUrl(externalUrl) ? externalUrl : null;

  return (
    <div className="space-y-2 p-4">
      <div className="flex items-center justify-between">
        <h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
          Interactive UI
        </h4>
        {safeExternalUrl && (
          <a
            href={safeExternalUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1"
          >
            Open in new tab
            <ExternalLinkIcon className="size-3" />
          </a>
        )}
      </div>
      <section
        className={cn(
          "rounded-md border bg-background overflow-hidden",
          "min-h-[200px] max-h-[600px]",
        )}
        aria-label="Interactive MCP UI component"
      >
        <UIResourceRenderer resource={resource} onUIAction={onUIAction} />
      </section>
    </div>
  );
}

function getState(
  part: ToolUIPart | DynamicToolUIPart,
  toolResultPart: ToolUIPart | DynamicToolUIPart | null,
  errorText?: string,
): ToolUIPart["state"] {
  if (errorText) return "output-error";
  if (toolResultPart) return "output-available";
  return part.state || "input-available";
}

export function hasUIResource(output: unknown): boolean {
  return extractUIResource(output) !== null;
}
