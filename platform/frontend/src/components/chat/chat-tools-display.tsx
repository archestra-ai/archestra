"use client";

import {
  isArchestraMcpServerTool,
  MCP_SERVER_TOOL_NAME_SEPARATOR,
} from "@shared";
import { Loader2, Plus, Wrench, X } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import {
  PromptInputButton,
  PromptInputHoverCard,
  PromptInputHoverCardContent,
  PromptInputHoverCardTrigger,
} from "@/components/ai-elements/prompt-input";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useHasPermissions } from "@/lib/auth.query";
import {
  useChatProfileMcpTools,
  useConversationEnabledTools,
  useProfileToolsWithIds,
} from "@/lib/chat.query";
import { Button } from "../ui/button";
import { ManageChatToolsDialog } from "./manage-chat-tools-dialog";

interface ChatToolsDisplayProps {
  agentId: string;
  conversationId: string;
  className?: string;
}

function EnableMoreToolsButton({ onClick }: { onClick: () => void }) {
  return (
    <Button onClick={onClick} title="Enable more tools for this chat">
      <Plus className="h-3 w-3" /> Enable more tools
    </Button>
  );
}

/**
 * Display tools enabled for a chat conversation with ability to disable them.
 * Use this component for chat-level tool management (enable/disable).
 * For profile-level tool assignment, use McpToolsDisplay instead.
 */
export function ChatToolsDisplay({
  agentId,
  conversationId,
  className,
}: ChatToolsDisplayProps) {
  const { data: mcpTools = [], isLoading } = useChatProfileMcpTools(agentId);
  const { data: profileTools = [] } = useProfileToolsWithIds(agentId);

  // State for manage tools dialog
  const [isManageToolsDialogOpen, setIsManageToolsDialogOpen] = useState(false);

  const [initialDisabledToolIds, setInitialDisabledToolIds] = useState<
    string[]
  >([]);

  // Fetch enabled tools for the conversation
  const { data: enabledToolsData } =
    useConversationEnabledTools(conversationId);
  const enabledToolIds = enabledToolsData?.enabledToolIds ?? [];
  const hasCustomSelection = enabledToolsData?.hasCustomSelection ?? false;

  // Handler to open manage tools dialog with specific tools to disable
  const handleOpenManageToolsDialog = (toolIdsToDisable: string[]) => {
    setInitialDisabledToolIds(toolIdsToDisable);
    setIsManageToolsDialogOpen(true);
  };

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
  const handleDisableTool = (toolName: string, event: React.MouseEvent) => {
    event.stopPropagation();
    const toolId = toolNameToId[toolName];
    if (toolId) {
      handleOpenManageToolsDialog([toolId]);
    }
  };

  // Handle disabling all tools from a server
  const handleDisableServer = (serverName: string, event: React.MouseEvent) => {
    event.stopPropagation();
    const serverTools = groupedTools[serverName] || [];
    const toolIds = serverTools
      .map((tool) => toolNameToId[tool.name])
      .filter((id): id is string => !!id);
    if (toolIds.length > 0) {
      handleOpenManageToolsDialog(toolIds);
    }
  };

  // Handle opening manage dialog with no pre-disabled tools
  const handleOpenManageDialog = () => {
    handleOpenManageToolsDialog([]);
  };

  console.log({
    mcpTools,
    profileTools,
    enabledToolsData,
    enabledToolIds,
    hasCustomSelection,
    displayedTools,
    groupedTools,
    hasDisabledTools,
  });

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
      <div className={className}>
        <div className="flex flex-wrap gap-2">
          {hasDisabledTools && (
            <EnableMoreToolsButton onClick={handleOpenManageDialog} />
          )}
        </div>
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
                  {serverName !== "archestra" && (
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
                        {!isArchestraMcpServerTool(tool.name) && (
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
          {hasDisabledTools && (
            <EnableMoreToolsButton onClick={handleOpenManageDialog} />
          )}
        </div>
      </TooltipProvider>
      {conversationId && agentId && (
        <ManageChatToolsDialog
          open={isManageToolsDialogOpen}
          onOpenChange={setIsManageToolsDialogOpen}
          conversationId={conversationId}
          agentId={agentId}
          initialDisabledToolIds={initialDisabledToolIds}
        />
      )}
    </div>
  );
}
