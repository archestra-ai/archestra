"use client";

import { UIResourceRenderer as McpUIResourceRenderer } from "@mcp-ui/client";
import type { ComponentProps } from "react";
import { useCallback } from "react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

type UIResource = {
  uri: string;
  mimeType: "text/html" | "text/uri-list" | "application/vnd.mcp-ui.remote-dom";
  text?: string;
  blob?: string;
};

export type UIResourceRendererProps = {
  resource: UIResource;
  className?: string;
  onToolCall?: (toolName: string, params: Record<string, unknown>) => void;
  onPrompt?: (prompt: string) => void;
};

/**
 * Renders MCP UI resources (HTML, external URLs, or Remote DOM)
 * Handles UI actions like tool calls, prompts, notifications, and links
 */
export const UIResourceRenderer = ({
  resource,
  className,
  onToolCall,
  onPrompt,
}: UIResourceRendererProps) => {
  const handleUIAction = useCallback(
    (action: {
      type: "tool" | "intent" | "prompt" | "notify" | "link";
      payload: Record<string, unknown>;
      messageId?: string;
    }) => {
      switch (action.type) {
        case "tool":
          if (onToolCall) {
            const { toolName, params } = action.payload as {
              toolName: string;
              params: Record<string, unknown>;
            };
            onToolCall(toolName, params);
          }
          break;

        case "prompt":
          if (onPrompt) {
            const { prompt } = action.payload as { prompt: string };
            onPrompt(prompt);
          }
          break;

        case "intent":
          // Convert intent to prompt
          if (onPrompt) {
            const { intent, params } = action.payload as {
              intent: string;
              params?: Record<string, unknown>;
            };
            const promptText = params
              ? `${intent} ${JSON.stringify(params)}`
              : intent;
            onPrompt(promptText);
          }
          break;

        case "notify":
          const { message } = action.payload as { message: string };
          toast.info(message);
          break;

        case "link":
          const { url } = action.payload as { url: string };
          window.open(url, "_blank", "noopener,noreferrer");
          break;

        default:
          console.warn("Unknown UI action type:", action.type);
      }
    },
    [onToolCall, onPrompt],
  );

  return (
    <div className={cn("mcp-ui-resource-container w-full", className)}>
      <McpUIResourceRenderer
        resource={resource}
        onUIAction={handleUIAction}
        htmlProps={{
          autoResizeIframe: { height: true },
          iframeProps: {
            className: "w-full rounded-md border",
            sandbox:
              "allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox",
          },
        }}
      />
    </div>
  );
};
