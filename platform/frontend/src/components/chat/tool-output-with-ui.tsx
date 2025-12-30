"use client";

import { extractUIResourceFromOutput } from "@shared/mcp-ui.types";
import { useTheme } from "next-themes";
import { useMemo } from "react";
import { McpUIResourceRenderer } from "./mcp-ui-resource-renderer";

interface ToolOutputWithUIProps {
  label: string;
  output: unknown;
  errorText?: string;
  onToolCall?: (toolName: string, params: Record<string, unknown>) => void;
  onPromptSubmit?: (prompt: string) => void;
  onIntent?: (intent: string, params: Record<string, unknown>) => void;
}

export function ToolOutputWithUI({
  label,
  output,
  errorText,
  onToolCall,
  onPromptSubmit,
  onIntent,
}: ToolOutputWithUIProps) {
  const { resolvedTheme } = useTheme();
  const uiResource = useMemo(
    () => extractUIResourceFromOutput(output),
    [output],
  );

  const formattedOutput = useMemo(() => {
    if (typeof output === "string") {
      try {
        return JSON.stringify(JSON.parse(output), null, 2);
      } catch {
        return output;
      }
    }
    return JSON.stringify(output, null, 2);
  }, [output]);

  if (uiResource) {
    return (
      <div className="mt-2">
        <div className="text-xs font-medium text-muted-foreground mb-1">
          {label}
        </div>
        <McpUIResourceRenderer
          resource={uiResource.resource}
          onToolCall={onToolCall}
          onPromptSubmit={onPromptSubmit}
          onIntent={onIntent}
          className="mt-2"
          iframeRenderData={{ theme: resolvedTheme }}
        />
      </div>
    );
  }

  return (
    <div className="mt-2">
      <div className="text-xs font-medium text-muted-foreground mb-1">
        {label}
      </div>
      <pre
        className={`text-xs p-2 rounded-md overflow-x-auto max-h-64 overflow-y-auto ${
          errorText
            ? "bg-destructive/10 text-destructive"
            : "bg-muted text-foreground"
        }`}
      >
        {errorText || formattedOutput}
      </pre>
    </div>
  );
}
