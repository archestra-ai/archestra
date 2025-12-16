"use client";

import { MCP_SERVER_TOOL_NAME_SEPARATOR } from "@shared";
import { Loader2, Plus, X } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { AssignToolsDialog } from "@/app/profiles/assign-tools-dialog";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useProfile } from "@/lib/agent.query";
import { useChatProfileMcpTools } from "@/lib/chat.query";

interface McpToolsDisplayProps {
  agentId: string;
  className?: string;
  disabledToolNames?: Set<string>;
  onDisableTools?: (toolNames: string[]) => void;
  onEnableTools?: (toolNames: string[]) => void;
}

function AssignToolsButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md border bg-background text-foreground text-xs hover:bg-accent hover:text-accent-foreground cursor-pointer"
      onClick={onClick}
      title="Assign tools to profile"
    >
      <Plus className="h-3 w-3" />
      Assign tools to profile
    </button>
  );
}

function EnableToolsButton({
  disabledGroups,
  onEnableTools,
}: {
  disabledGroups: Record<string, { name: string; description: string }[]>;
  onEnableTools: (toolNames: string[]) => void;
}) {
  const [isOpen, setIsOpen] = useState(false);

  const handleEnableGroup = (serverName: string, tools: { name: string }[]) => {
    onEnableTools(tools.map((t) => t.name));
    // Close popover if all groups are now enabled
    const remainingGroups = Object.keys(disabledGroups).filter(
      (name) => name !== serverName,
    );
    if (remainingGroups.length === 0) {
      setIsOpen(false);
    }
  };

  return (
    <Popover open={isOpen} onOpenChange={setIsOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md border bg-background text-foreground text-xs hover:bg-accent hover:text-accent-foreground cursor-pointer"
          title="Enable more tools"
        >
          <Plus className="h-3 w-3" />
          Enable tools
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-64 p-2 max-h-64 overflow-y-auto"
      >
        <div className="text-xs font-medium mb-2 text-muted-foreground">
          Disabled tools
        </div>
        <div className="space-y-1">
          {Object.entries(disabledGroups).map(([serverName, tools]) => (
            <button
              key={serverName}
              type="button"
              className="w-full flex items-center justify-between gap-2 px-2 py-1.5 rounded-md hover:bg-accent text-left text-xs"
              onClick={() => handleEnableGroup(serverName, tools)}
            >
              <div className="flex items-center gap-1.5 min-w-0">
                <span className="font-medium truncate">{serverName}</span>
                <span className="text-muted-foreground shrink-0">
                  ({tools.length})
                </span>
              </div>
              <Plus className="h-3 w-3 shrink-0 text-muted-foreground" />
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

export function McpToolsDisplay({
  agentId,
  className,
  disabledToolNames = new Set(),
  onDisableTools,
  onEnableTools,
}: McpToolsDisplayProps) {
  const { data: mcpTools = [], isLoading } = useChatProfileMcpTools(agentId);
  const { data: agent } = useProfile(agentId);
  const [isAssignToolsDialogOpen, setIsAssignToolsDialogOpen] = useState(false);
  const openAssignToolsDialog = useCallback(
    () => setIsAssignToolsDialogOpen(true),
    [],
  );

  // Group all tools by MCP server name
  const allGroupedTools = useMemo(
    () =>
      mcpTools.reduce(
        (acc, tool) => {
          const parts = tool.name.split(MCP_SERVER_TOOL_NAME_SEPARATOR);
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

  // Separate enabled and disabled tool groups
  const { enabledGroups, disabledGroups } = useMemo(() => {
    const enabled: Record<string, typeof mcpTools> = {};
    const disabled: Record<string, typeof mcpTools> = {};

    for (const [serverName, tools] of Object.entries(allGroupedTools)) {
      const enabledTools = tools.filter((t) => !disabledToolNames.has(t.name));
      const disabledToolsList = tools.filter((t) =>
        disabledToolNames.has(t.name),
      );

      if (enabledTools.length > 0) {
        enabled[serverName] = enabledTools;
      }
      if (disabledToolsList.length > 0) {
        disabled[serverName] = disabledToolsList;
      }
    }

    return { enabledGroups: enabled, disabledGroups: disabled };
  }, [allGroupedTools, disabledToolNames]);

  const handleDisableGroup = useCallback(
    (serverName: string) => {
      const tools = allGroupedTools[serverName];
      if (tools && onDisableTools) {
        onDisableTools(tools.map((t) => t.name));
      }
    },
    [allGroupedTools, onDisableTools],
  );

  const hasDisabledTools = Object.keys(disabledGroups).length > 0;

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

  if (Object.keys(allGroupedTools).length === 0) {
    return (
      <>
        <AssignToolsButton onClick={openAssignToolsDialog} />
        <AssignToolsDialog
          agent={agent}
          open={isAssignToolsDialogOpen}
          onOpenChange={setIsAssignToolsDialogOpen}
        />
      </>
    );
  }

  return (
    <div className={className}>
      <TooltipProvider>
        <div className="flex flex-wrap gap-2">
          {Object.entries(enabledGroups).map(([serverName, tools]) => (
            <Tooltip key={serverName} delayDuration={300}>
              <TooltipTrigger asChild>
                <div className="group inline-flex items-center gap-1.5 px-2 py-1 rounded-md bg-secondary text-secondary-foreground">
                  <span className="font-medium text-xs">{serverName}</span>
                  <span className="text-muted-foreground text-xs">
                    ({tools.length} {tools.length === 1 ? "tool" : "tools"})
                  </span>
                  {onDisableTools && (
                    <button
                      type="button"
                      className="ml-0.5 p-0.5 rounded hover:bg-destructive/20 opacity-0 group-hover:opacity-100 transition-opacity"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDisableGroup(serverName);
                      }}
                      title={`Disable ${serverName} tools for this chat`}
                    >
                      <X className="h-3 w-3 text-muted-foreground hover:text-destructive" />
                    </button>
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
          {hasDisabledTools && onEnableTools && (
            <EnableToolsButton
              disabledGroups={disabledGroups}
              onEnableTools={onEnableTools}
            />
          )}
          <AssignToolsButton onClick={openAssignToolsDialog} />
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
