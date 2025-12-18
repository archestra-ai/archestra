"use client";

import {
  ARCHESTRA_MCP_SERVER_NAME,
  MCP_SERVER_TOOL_NAME_SEPARATOR,
} from "@shared";
import { Info, Loader2, Plus, Settings, X } from "lucide-react";
import { useState } from "react";
import { PromptInputButton } from "@/components/ai-elements/prompt-input";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  useChatProfileMcpTools,
  useConversationEnabledTools,
  useProfileToolsWithIds,
  useUpdateConversationEnabledTools,
} from "@/lib/chat.query";
import { Button } from "../ui/button";
import { ManageChatToolsDialog } from "./manage-chat-tools-dialog";

interface ChatToolsDisplayProps {
  agentId: string;
  conversationId: string;
  className?: string;
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

  // State for tooltip open state per server
  const [openTooltips, setOpenTooltips] = useState<Record<string, boolean>>({});
  // Track hover state to prevent closing when hovering over nested tooltips
  const [hoveringTooltip, setHoveringTooltip] = useState<
    Record<string, boolean>
  >({});

  // Fetch enabled tools for the conversation
  const { data: enabledToolsData } =
    useConversationEnabledTools(conversationId);
  const enabledToolIds = enabledToolsData?.enabledToolIds ?? [];
  const hasCustomSelection = enabledToolsData?.hasCustomSelection ?? false;

  // Mutation for updating enabled tools
  const updateEnabledTools = useUpdateConversationEnabledTools();

  // Handler to open manage tools dialog with specific tools to disable
  const handleOpenManageToolsDialog = (toolIdsToDisable: string[]) => {
    setInitialDisabledToolIds(toolIdsToDisable);
    setIsManageToolsDialogOpen(true);
  };

  // Create a map of tool name -> tool ID for quick lookup
  const toolNameToId: Record<string, string> = {};
  for (const tool of profileTools) {
    toolNameToId[tool.name] = tool.id;
  }

  // Create enabled tool IDs set for quick lookup
  const enabledToolIdsSet = new Set(enabledToolIds);

  // Filter tools based on enabled status (only when custom selection exists)
  let displayedTools = mcpTools;
  if (hasCustomSelection && enabledToolIds.length > 0) {
    displayedTools = mcpTools.filter((tool) => {
      const toolId = toolNameToId[tool.name];
      return toolId && enabledToolIdsSet.has(toolId);
    });
  }

  // Group tools by MCP server name (everything before the last __)
  const groupedTools: Record<string, typeof displayedTools> = {};
  for (const tool of displayedTools) {
    const parts = tool.name.split(MCP_SERVER_TOOL_NAME_SEPARATOR);
    const serverName =
      parts.length > 1
        ? parts.slice(0, -1).join(MCP_SERVER_TOOL_NAME_SEPARATOR)
        : "default";
    if (!groupedTools[serverName]) {
      groupedTools[serverName] = [];
    }
    groupedTools[serverName].push(tool);
  }

  // Sort server entries to always show Archestra first
  const sortedServerEntries = Object.entries(groupedTools).sort(([a], [b]) => {
    if (a === ARCHESTRA_MCP_SERVER_NAME) return -1;
    if (b === ARCHESTRA_MCP_SERVER_NAME) return 1;
    return a.localeCompare(b);
  });

  // Handle enabling a tool
  const handleEnableTool = (toolId: string, event: React.MouseEvent) => {
    event.stopPropagation();
    let newEnabledToolIds: string[];
    if (hasCustomSelection) {
      newEnabledToolIds = [...enabledToolIds, toolId];
    } else {
      // If no custom selection, get all tool IDs and add this one
      newEnabledToolIds = [...profileTools.map((t) => t.id), toolId];
    }
    updateEnabledTools.mutateAsync({
      conversationId,
      toolIds: newEnabledToolIds,
    });
  };

  // Handle disabling a tool
  const handleDisableTool = (toolId: string, event: React.MouseEvent) => {
    event.stopPropagation();
    let newEnabledToolIds: string[];
    if (hasCustomSelection) {
      newEnabledToolIds = enabledToolIds.filter((id) => id !== toolId);
    } else {
      // If no custom selection, get all tool IDs except this one
      newEnabledToolIds = profileTools
        .map((t) => t.id)
        .filter((id) => id !== toolId);
    }
    updateEnabledTools.mutateAsync({
      conversationId,
      toolIds: newEnabledToolIds,
    });
  };

  // Handle disabling all enabled tools for a server
  const handleDisableAll = (toolIds: string[], event: React.MouseEvent) => {
    event.stopPropagation();
    let newEnabledToolIds: string[];
    if (hasCustomSelection) {
      newEnabledToolIds = enabledToolIds.filter((id) => !toolIds.includes(id));
    } else {
      // If no custom selection, get all tool IDs except these
      newEnabledToolIds = profileTools
        .map((t) => t.id)
        .filter((id) => !toolIds.includes(id));
    }
    updateEnabledTools.mutateAsync({
      conversationId,
      toolIds: newEnabledToolIds,
    });
  };

  // Handle enabling all disabled tools for a server
  const handleEnableAll = (toolIds: string[], event: React.MouseEvent) => {
    event.stopPropagation();
    let newEnabledToolIds: string[];
    if (hasCustomSelection) {
      newEnabledToolIds = [...enabledToolIds, ...toolIds];
    } else {
      // If no custom selection, get all tool IDs and add these
      newEnabledToolIds = [...profileTools.map((t) => t.id), ...toolIds];
    }
    updateEnabledTools.mutateAsync({
      conversationId,
      toolIds: newEnabledToolIds,
    });
  };

  // Handle opening manage dialog with no pre-disabled tools
  const handleOpenManageDialog = () => {
    handleOpenManageToolsDialog([]);
  };

  // Render a single tool row
  const renderToolRow = (
    tool: { id: string; name: string; description: string | null },
    isDisabled: boolean,
    currentServerName: string,
  ) => {
    const parts = tool.name.split(MCP_SERVER_TOOL_NAME_SEPARATOR);
    const toolName = parts.length > 1 ? parts[parts.length - 1] : tool.name;
    const borderColor = isDisabled ? "border-red-500" : "border-green-500";

    return (
      <div
        key={tool.id}
        className={`flex items-center gap-2 border-l-2 ${borderColor} pl-2 ml-1 py-1`}
      >
        <span className="font-medium text-sm">{toolName}</span>
        {tool.description && (
          <Tooltip delayDuration={0}>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-4 w-4 p-0 cursor-help"
                onMouseEnter={() => {
                  setHoveringTooltip((prev) => ({
                    ...prev,
                    [currentServerName]: true,
                  }));
                }}
              >
                <Info className="h-4 w-4 text-muted-foreground" />
              </Button>
            </TooltipTrigger>
            <TooltipContent
              className="max-w-[300px]"
              onMouseEnter={() => {
                setHoveringTooltip((prev) => ({
                  ...prev,
                  [currentServerName]: true,
                }));
              }}
              onMouseLeave={() => {
                // Small delay to allow moving back to main tooltip
                setTimeout(() => {
                  setHoveringTooltip((prev) => ({
                    ...prev,
                    [currentServerName]: false,
                  }));
                }, 30);
              }}
            >
              {tool.description}
            </TooltipContent>
          </Tooltip>
        )}
        <div className="flex-1" />
        {isDisabled ? (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 w-6 p-0 rounded-full"
            onClick={(e) => handleEnableTool(tool.id, e)}
            title={`Enable ${toolName} for this chat`}
          >
            <Plus className="h-3 w-3" />
          </Button>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 w-6 p-0 hover:text-destructive"
            onClick={(e) => handleDisableTool(tool.id, e)}
            title={`Disable ${toolName} for this chat`}
          >
            <X className="h-3 w-3" />
          </Button>
        )}
      </div>
    );
  };

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

  const editToolsButton = (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          onClick={handleOpenManageDialog}
          variant="ghost"
          size="sm"
          className="text-xs"
        >
          <Settings className="h-2 w-2" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        <p>Enable or disable tools for this chat</p>
      </TooltipContent>
    </Tooltip>
  );

  if (Object.keys(groupedTools).length === 0) {
    return (
      <div className={className}>
        <div className="flex flex-wrap gap-2">{editToolsButton}</div>
      </div>
    );
  }

  return (
    <div className={className}>
      <TooltipProvider>
        <div className="flex flex-wrap gap-2">
          {sortedServerEntries.map(([serverName]) => {
            // Get all tools for this server from profileTools
            const allServerTools = profileTools.filter((tool) => {
              const parts = tool.name.split(MCP_SERVER_TOOL_NAME_SEPARATOR);
              const toolServerName =
                parts.length > 1
                  ? parts.slice(0, -1).join(MCP_SERVER_TOOL_NAME_SEPARATOR)
                  : "default";
              return toolServerName === serverName;
            });

            // Split into enabled and disabled
            let enabledTools: typeof allServerTools = [];
            let disabledTools: typeof allServerTools = [];

            if (hasCustomSelection) {
              for (const tool of allServerTools) {
                if (enabledToolIdsSet.has(tool.id)) {
                  enabledTools.push(tool);
                } else {
                  disabledTools.push(tool);
                }
              }
            } else {
              // All tools are enabled when no custom selection
              enabledTools = allServerTools;
              disabledTools = [];
            }

            const totalToolsCount = allServerTools.length;
            const isOpen = openTooltips[serverName] ?? false;

            return (
              <Tooltip
                key={serverName}
                open={isOpen || hoveringTooltip[serverName]}
                onOpenChange={(open) => {
                  // Update openTooltips, but keep tooltip open if hovering
                  setOpenTooltips((prev) => ({
                    ...prev,
                    [serverName]: open,
                  }));
                }}
              >
                <TooltipTrigger asChild>
                  <PromptInputButton
                    className="w-[fit-content]"
                    size="sm"
                    variant="outline"
                  >
                    <span className="font-medium text-xs text-foreground">
                      {serverName}
                    </span>
                    <span className="text-muted-foreground text-xs">
                      ({enabledTools.length}/{totalToolsCount})
                    </span>
                  </PromptInputButton>
                </TooltipTrigger>
                <TooltipContent
                  side="top"
                  align="center"
                  className="min-w-80 max-h-96 p-0 overflow-y-auto"
                  sideOffset={10}
                  onWheel={(e) => e.stopPropagation()}
                  onTouchMove={(e) => e.stopPropagation()}
                  onMouseEnter={() => {
                    setHoveringTooltip((prev) => ({
                      ...prev,
                      [serverName]: true,
                    }));
                  }}
                  onMouseLeave={() => {
                    // Delay to allow moving to nested tooltip
                    setTimeout(() => {
                      setHoveringTooltip((prev) => ({
                        ...prev,
                        [serverName]: false,
                      }));
                      // Also close the tooltip
                      setOpenTooltips((prev) => ({
                        ...prev,
                        [serverName]: false,
                      }));
                    }, 30);
                  }}
                >
                  <ScrollArea className="max-h-96">
                    {/* Enabled section */}
                    {enabledTools.length > 0 && (
                      <div>
                        <div className="flex items-center justify-between px-3 py-2">
                          <span className="text-xs font-semibold text-muted-foreground">
                            Enabled ({enabledTools.length})
                          </span>
                          <Button
                            variant="outline"
                            size="sm"
                            className="text-xs"
                            onClick={(e) =>
                              handleDisableAll(
                                enabledTools.map((t) => t.id),
                                e,
                              )
                            }
                          >
                            Disable All
                          </Button>
                        </div>
                        <div className="space-y-1 px-2 pb-2">
                          {enabledTools.map((tool) =>
                            renderToolRow(tool, false, serverName),
                          )}
                        </div>
                      </div>
                    )}

                    {/* Disabled section */}
                    {disabledTools.length > 0 && (
                      <div>
                        <div className="flex items-center justify-between px-3 py-2">
                          <span className="text-xs font-semibold text-muted-foreground">
                            Disabled ({disabledTools.length})
                          </span>
                          <Button
                            variant="outline"
                            size="sm"
                            className="text-xs"
                            onClick={(e) =>
                              handleEnableAll(
                                disabledTools.map((t) => t.id),
                                e,
                              )
                            }
                          >
                            Enable All
                          </Button>
                        </div>
                        <div className="space-y-1 px-2 pb-2">
                          {disabledTools.map((tool) =>
                            renderToolRow(tool, true, serverName),
                          )}
                        </div>
                      </div>
                    )}
                  </ScrollArea>
                </TooltipContent>
              </Tooltip>
            );
          })}
          {editToolsButton}
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
