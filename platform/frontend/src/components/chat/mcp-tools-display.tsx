"use client";

import {
  isArchestraMcpServerTool,
  MCP_SERVER_TOOL_NAME_SEPARATOR,
} from "@shared";
import { Loader2, Plus, X } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { AssignToolsDialog } from "@/app/profiles/assign-tools-dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useProfile } from "@/lib/agent.query";
import {
  useChatProfileMcpTools,
  useProfileToolsWithIds,
} from "@/lib/chat.query";
import { Button } from "../ui/button";

interface McpToolsDisplayProps {
  agentId: string;
  className?: string;
  /** Whether conversation has custom tool selection */
  hasCustomSelection?: boolean;
  /** Currently enabled tool IDs (empty = all enabled) */
  enabledToolIds?: string[];
  /** Callback to open manage tools dialog with specific tools to disable */
  onOpenManageDialog?: (toolIdsToDisable: string[]) => void;
}

function AssignToolsButton({ onClick }: { onClick: () => void }) {
  return (
    <Button onClick={onClick} title="Add more tools">
      <Plus className="h-3 w-3" />
      Assign tools to profile
    </Button>
  );
}

function EnableMoreToolsButton({ onClick }: { onClick: () => void }) {
  return (
    <Button onClick={onClick} title="Enable more tools for this chat">
      <Plus className="h-3 w-3" /> Enable more tools
    </Button>
  );
}

export function McpToolsDisplay({
  agentId,
  className,
  hasCustomSelection = false,
  enabledToolIds = [],
  onOpenManageDialog,
}: McpToolsDisplayProps) {
  const { data: mcpTools = [], isLoading } = useChatProfileMcpTools(agentId);
  const { data: profileTools = [] } = useProfileToolsWithIds(agentId);
  const { data: agent } = useProfile(agentId);
  const [isAssignToolsDialogOpen, setIsAssignToolsDialogOpen] = useState(false);
  const openAssignToolsDialog = useCallback(
    () => setIsAssignToolsDialogOpen(true),
    [],
  );

  // Create a map of tool name -> tool ID for quick lookup
  const toolNameToId = useMemo(
    () =>
      profileTools.reduce(
        (acc, tool) => {
          acc[tool.name] = tool.id;
          return acc;
        },
        {} as Record<string, string>,
      ),
    [profileTools],
  );

  // Create enabled tool IDs set for quick lookup
  const enabledToolIdsSet = useMemo(
    () => new Set(enabledToolIds),
    [enabledToolIds],
  );

  // Filter tools based on enabled status (only when custom selection exists)
  const displayedTools = useMemo(() => {
    if (!hasCustomSelection || enabledToolIds.length === 0) {
      return mcpTools;
    }
    return mcpTools.filter((tool) => {
      const toolId = toolNameToId[tool.name];
      return toolId && enabledToolIdsSet.has(toolId);
    });
  }, [
    mcpTools,
    hasCustomSelection,
    enabledToolIds,
    toolNameToId,
    enabledToolIdsSet,
  ]);

  // Check if some tools are disabled
  const hasDisabledTools = useMemo(
    () => hasCustomSelection && displayedTools.length < mcpTools.length,
    [hasCustomSelection, displayedTools.length, mcpTools.length],
  );

  // Group tools by MCP server name (everything before the last __)
  const groupedTools = useMemo(
    () =>
      displayedTools.reduce(
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
        {} as Record<string, typeof displayedTools>,
      ),
    [displayedTools],
  );

  // Handle disabling a single tool
  const handleDisableTool = useCallback(
    (toolName: string, event: React.MouseEvent) => {
      event.stopPropagation();
      const toolId = toolNameToId[toolName];
      if (toolId && onOpenManageDialog) {
        onOpenManageDialog([toolId]);
      }
    },
    [toolNameToId, onOpenManageDialog],
  );

  // Handle disabling all tools from a server
  const handleDisableServer = useCallback(
    (serverName: string, event: React.MouseEvent) => {
      event.stopPropagation();
      const serverTools = groupedTools[serverName] || [];
      const toolIds = serverTools
        .map((tool) => toolNameToId[tool.name])
        .filter((id): id is string => !!id);
      if (toolIds.length > 0 && onOpenManageDialog) {
        onOpenManageDialog(toolIds);
      }
    },
    [groupedTools, toolNameToId, onOpenManageDialog],
  );

  // Handle opening manage dialog with no pre-disabled tools
  const handleOpenManageDialog = useCallback(() => {
    if (onOpenManageDialog) {
      onOpenManageDialog([]);
    }
  }, [onOpenManageDialog]);

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

  if (Object.keys(groupedTools).length === 0) {
    return (
      <div className={className}>
        <div className="flex flex-wrap gap-2">
          <AssignToolsButton onClick={openAssignToolsDialog} />
          {hasDisabledTools && onOpenManageDialog && (
            <EnableMoreToolsButton onClick={handleOpenManageDialog} />
          )}
        </div>
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
          {Object.entries(groupedTools).map(([serverName, tools]) => (
            <Tooltip key={serverName} delayDuration={300}>
              <TooltipTrigger asChild>
                <div className="group inline-flex items-center gap-1.5 px-2 py-1 rounded-md bg-secondary text-secondary-foreground cursor-default">
                  <span className="font-medium text-xs">{serverName}</span>
                  <span className="text-muted-foreground text-xs">
                    ({tools.length} {tools.length === 1 ? "tool" : "tools"})
                  </span>
                  {onOpenManageDialog && serverName !== "archestra" && (
                    <Button
                      className="ml-1 opacity-0 group-hover:opacity-100 hover:text-destructive transition-opacity"
                      onClick={(e) => handleDisableServer(serverName, e)}
                      title={`Disable all ${serverName} tools for this chat`}
                    >
                      <X className="h-3 w-3" />
                    </Button>
                  )}
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
                        className="group/tool flex items-start justify-between gap-2 text-xs border-l-2 border-primary/30 pl-2 py-0.5"
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
                        {onOpenManageDialog &&
                          !isArchestraMcpServerTool(tool.name) && (
                            <Button
                              className="opacity-0 group-hover/tool:opacity-100 hover:text-destructive transition-opacity shrink-0 mt-0.5"
                              onClick={(e) => handleDisableTool(tool.name, e)}
                              title={`Disable ${toolName} for this chat`}
                            >
                              <X className="h-3 w-3" />
                            </Button>
                          )}
                      </div>
                    );
                  })}
                </div>
              </TooltipContent>
            </Tooltip>
          ))}
          <AssignToolsButton onClick={openAssignToolsDialog} />
          {hasDisabledTools && onOpenManageDialog && (
            <EnableMoreToolsButton onClick={handleOpenManageDialog} />
          )}
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
