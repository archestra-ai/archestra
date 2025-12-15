"use client";

import { MCP_SERVER_TOOL_NAME_SEPARATOR } from "@shared";
import { Loader2, Plus } from "lucide-react";
import { useMemo, useState } from "react";
import { AssignToolsDialog } from "@/app/profiles/assign-tools-dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useProfile } from "@/lib/agent.query";
import { useChatProfileMcpTools } from "@/lib/chat.query";
import { Button } from "../ui/button";

interface McpToolsDisplayProps {
  agentId: string;
  className?: string;
}

export function McpToolsDisplay({ agentId, className }: McpToolsDisplayProps) {
  const { data: mcpTools = [], isLoading } = useChatProfileMcpTools(agentId);
  const { data: agent } = useProfile(agentId);
  const [isAssignToolsDialogOpen, setIsAssignToolsDialogOpen] = useState(false);

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

  if (isLoading) {
    return (
      <div className={className}>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" />
          <span>Loading tools...</span>
        </div>
      </div>
    );
  }

  if (Object.keys(groupedTools).length === 0) {
    return (
      <>
        {agent && (
          <Button
            variant="outline"
            className="inline-flex items-center justify-center"
            onClick={() => setIsAssignToolsDialogOpen(true)}
            title="Add more tools"
          >
            <Plus className="h-3 w-3" />
            Assign tools to profile
          </Button>
        )}
        {agent && (
          <AssignToolsDialog
            agent={agent}
            open={isAssignToolsDialogOpen}
            onOpenChange={setIsAssignToolsDialogOpen}
          />
        )}
      </>
    );
  }

  return (
    <div className={className}>
      <TooltipProvider>
        <div className="flex flex-wrap gap-2">
          {Object.entries(groupedTools).map(([serverName, tools]) => (
            <Tooltip key={serverName}>
              <TooltipTrigger asChild>
                <div className="inline-flex items-center gap-1.5 px-2 h-9 rounded-md bg-secondary text-secondary-foreground cursor-default">
                  <span className="font-medium text-xs">{serverName}</span>
                  <span className="text-muted-foreground text-xs">
                    ({tools.length} {tools.length === 1 ? "tool" : "tools"})
                  </span>
                </div>
              </TooltipTrigger>
              <TooltipContent
                side="top"
                className="max-w-sm max-h-64 overflow-y-auto"
                onWheel={(e) => e.stopPropagation()}
                onTouchMove={(e) => e.stopPropagation()}
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
          {agent && (
            <Button
              variant="outline"
              className="inline-flex items-center justify-center"
              onClick={() => setIsAssignToolsDialogOpen(true)}
              title="Add more tools"
            >
              <Plus className="h-3 w-3" />
              Assign tools to profile
            </Button>
          )}
        </div>
      </TooltipProvider>
      {agent && (
        <AssignToolsDialog
          agent={agent}
          open={isAssignToolsDialogOpen}
          onOpenChange={setIsAssignToolsDialogOpen}
        />
      )}
    </div>
  );
}
