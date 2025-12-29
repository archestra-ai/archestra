"use client";

import { MCP_SERVER_TOOL_NAME_SEPARATOR } from "@shared";
import { Loader2 } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
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

interface AssignToolsToProfileProps {
  agentId: string;
  showAssignedToolsList: boolean;
  className?: string;
  assignToolsButtonProps?: React.ComponentProps<typeof Button>;
}

export function AssignToolsToProfile({
  agentId,
  showAssignedToolsList,
  className,
  assignToolsButtonProps,
}: AssignToolsToProfileProps) {
  const { data: mcpTools = [], isLoading } = useChatProfileMcpTools(agentId);
  const { data: agent } = useProfile(agentId);
  const [isAssignToolsDialogOpen, setIsAssignToolsDialogOpen] = useState(false);
  const openAssignToolsDialog = useCallback(
    () => setIsAssignToolsDialogOpen(true),
    [],
  );

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

  if (isLoading || !agent) {
    return (
      <div className={className}>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" />
          <span>Loading tools...</span>
        </div>
      </div>
    );
  }

  const assignToolsButton = (
    <Button
      onClick={openAssignToolsDialog}
      title="Add more tools"
      variant="outline"
      {...assignToolsButtonProps}
    >
      Assign tools to profile
    </Button>
  );

  if (Object.keys(groupedTools).length === 0) {
    return (
      <div className={className}>
        <div className="flex flex-wrap gap-2">{assignToolsButton}</div>
        <AssignToolsDialog
          agent={agent}
          open={isAssignToolsDialogOpen}
          onOpenChange={setIsAssignToolsDialogOpen}
        />
      </div>
    );
  }

  return (
    <div className={className}>
      <TooltipProvider>
        <div className="flex flex-wrap gap-2">
          {showAssignedToolsList &&
            Object.entries(groupedTools).map(([serverName, tools]) => (
              <Tooltip key={serverName} delayDuration={300}>
                <TooltipTrigger asChild>
                  <div className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md bg-secondary text-secondary-foreground cursor-default">
                    <span className="font-medium text-xs">{serverName}</span>
                    <span className="text-muted-foreground text-xs">
                      ({tools.length} {tools.length === 1 ? "tool" : "tools"})
                    </span>
                  </div>
                </TooltipTrigger>
                <TooltipContent
                  side="bottom"
                  align="center"
                  avoidCollisions={true}
                  className="max-w-xs max-h-48 overflow-y-auto text-xs"
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
                          className="flex items-start gap-2 text-xs border-l-2 border-primary/30 pl-2 py-0.5"
                        >
                          <div className="flex-1">
                            <div className="font-mono font-medium">
                              {toolName}
                            </div>
                            {tool.description && (
                              <div className="text-muted-foreground mt-0.5">
                                {tool.description}
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </TooltipContent>
              </Tooltip>
            ))}
          {assignToolsButton}
        </div>
      </TooltipProvider>
      <AssignToolsDialog
        agent={agent}
        open={isAssignToolsDialogOpen}
        onOpenChange={setIsAssignToolsDialogOpen}
      />
    </div>
  );
}
