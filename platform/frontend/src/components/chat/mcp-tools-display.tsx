"use client";

import { MCP_SERVER_TOOL_NAME_SEPARATOR } from "@shared";
import { useMemo } from "react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useChatAgentMcpTools } from "@/lib/chat.query";

interface McpToolsDisplayProps {
  agentId: string;
  className?: string;
}

export function McpToolsDisplay({ agentId, className }: McpToolsDisplayProps) {
  const { data: mcpTools = [] } = useChatAgentMcpTools(agentId);

  // Group tools by MCP server name (everything before the last __)
  const groupedTools = useMemo(
    () =>
      mcpTools.reduce(
        (acc, tool) => {
          const parts = tool.name.split(MCP_SERVER_TOOL_NAME_SEPARATOR);
          // Last part is tool name, everything else is server name
          const serverName =
            parts.length > 1
              ? parts.slice(0, -1).join(MCP_SERVER_TOOL_NAME_SEPARATOR)
              : "default";
          if (!acc[serverName]) {
            acc[serverName] = [];
          }
          acc[serverName].push(tool);
          return acc;
        },
        {} as Record<string, typeof mcpTools>,
      ),
    [mcpTools],
  );

  if (Object.keys(groupedTools).length === 0) {
    return null;
  }

  return (
    <div className={className}>
      <TooltipProvider>
        <div className="flex flex-wrap gap-2">
          {Object.entries(groupedTools).map(([serverName, tools]) => (
            <Tooltip key={serverName}>
              <TooltipTrigger asChild>
                <div className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md bg-secondary text-foreground cursor-default">
                  <span className="font-medium text-xs">{serverName}</span>
                  <span className="text-muted-foreground text-xs">
                    ({tools.length} {tools.length === 1 ? "tool" : "tools"})
                  </span>
                </div>
              </TooltipTrigger>
              <TooltipContent
                side="top"
                className="max-w-sm max-h-64 overflow-y-auto"
              >
                <div className="space-y-1">
                  {tools.map((tool) => {
                    const parts = tool.name.split(
                      MCP_SERVER_TOOL_NAME_SEPARATOR,
                    );
                    const toolName =
                      parts.length > 1 ? parts[parts.length - 1] : tool.name;
                    return (
                      <div
                        key={tool.name}
                        className="text-xs border-l-2 border-primary/30 pl-2 py-0.5"
                      >
                        <div className="font-mono font-medium">{toolName}</div>
                        {tool.description && (
                          <div className="text-muted-foreground mt-0.5">
                            {tool.description}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </TooltipContent>
            </Tooltip>
          ))}
        </div>
      </TooltipProvider>
    </div>
  );
}
