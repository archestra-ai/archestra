"use client";

import {
  isArchestraMcpServerTool,
  MCP_SERVER_TOOL_NAME_SEPARATOR,
} from "@shared";
import {
  GlobeIcon,
  ListChecks,
  ListTodo,
  Loader2,
  Plus,
  Wrench,
  WrenchIcon,
  X,
} from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import {
  PromptInputButton,
  PromptInputCommand,
  PromptInputCommandEmpty,
  PromptInputCommandGroup,
  PromptInputCommandInput,
  PromptInputCommandItem,
  PromptInputCommandList,
  PromptInputCommandSeparator,
  PromptInputHeader,
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
import Divider from "../divider";
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

  const enableMoreToolsButton = (
    <Button
      onClick={handleOpenManageDialog}
      title="Enable more tools for this chat"
      variant="ghost"
      size="sm"
      className="text-xs"
    >
      <ListTodo className="h-2 w-2" /> Toggle tools
    </Button>
  );

  if (Object.keys(groupedTools).length === 0) {
    return (
      <div className={className}>
        <div className="flex flex-wrap gap-2">
          {hasDisabledTools && enableMoreToolsButton}
        </div>
      </div>
    );
  }

  return (
    <div className={className}>
      <TooltipProvider>
        <div className="flex flex-wrap gap-2">
          {Object.entries(groupedTools).map(([serverName, tools]) => (
            <PromptInputHoverCard key={serverName}>
              <PromptInputHoverCardTrigger>
                <PromptInputButton
                  className="w-[fit-content]"
                  size="sm"
                  variant="outline"
                >
                  {/* <WrenchIcon className="h-3 w-3" /> */}
                  <span className="font-medium text-xs">{serverName}</span>
                  <span className="text-muted-foreground text-xs">
                    ({tools.length} {tools.length === 1 ? "tool" : "tools"})
                  </span>
                </PromptInputButton>
              </PromptInputHoverCardTrigger>
              <PromptInputHoverCardContent
                side="bottom"
                align="center"
                avoidCollisions
                className="w-[300px] max-h-200 overflow-y-auto text-xs"
                onWheel={(e) => e.stopPropagation()}
                onTouchMove={(e) => e.stopPropagation()}
              >
                <PromptInputCommand>
                  <PromptInputCommandInput
                    className="border-none focus-visible:ring-0"
                    placeholder="Search tools..."
                  />
                  <PromptInputCommandList>
                    <PromptInputCommandEmpty className="p-3 text-muted-foreground text-sm">
                      No results found.
                    </PromptInputCommandEmpty>
                    <PromptInputCommandGroup heading="Enabled">
                      <div className="space-y-1">
                        {tools.map((tool) => {
                          const parts = tool.name.split(
                            MCP_SERVER_TOOL_NAME_SEPARATOR,
                          );
                          const toolName =
                            parts.length > 1
                              ? parts[parts.length - 1]
                              : tool.name;
                          return (
                            <PromptInputCommandItem
                              key={tool.name}
                              // className="group/tool flex items-start justify-between gap-2 text-xs border-l-2 border-primary/30 py-0.5"
                            >
                              <div className="flex-1">
                                <div className="font-mono font-medium">
                                  {toolName}
                                </div>
                                {/* {tool.description && (
                                  <div className="text-muted-foreground mt-0.5">
                                    {tool.description}
                                  </div>
                                )} */}
                              </div>
                              {!isArchestraMcpServerTool(tool.name) && (
                                <Button
                                  className="opacity-0 group-hover/tool:opacity-100 hover:text-destructive transition-opacity shrink-0 mt-0.5"
                                  onClick={(e) =>
                                    handleDisableTool(tool.name, e)
                                  }
                                  title={`Disable ${toolName} for this chat`}
                                >
                                  <X className="h-3 w-3" />
                                </Button>
                              )}
                            </PromptInputCommandItem>
                          );
                        })}
                      </div>
                      {/* <PromptInputCommandItem>
                        <GlobeIcon />
                        <span>Active Tabs</span>
                        <span className="ml-auto text-muted-foreground">✓</span>
                      </PromptInputCommandItem> */}
                    </PromptInputCommandGroup>
                    <PromptInputCommandSeparator />
                    {/* <PromptInputCommandGroup heading="Other Files">
                        {tools.map((tool, index) => (
                          <PromptInputCommandItem key={`${tool.name}-${index}`}>
                            <GlobeIcon className="text-primary" />
                            <div className="flex flex-col">
                              <span className="font-medium text-sm">
                                {tool.name}
                              </span>
                              <span className="text-muted-foreground text-xs">
                                {tool.description}
                              </span>
                            </div>
                          </PromptInputCommandItem>
                        ))}
                      </PromptInputCommandGroup> */}
                  </PromptInputCommandList>
                </PromptInputCommand>
              </PromptInputHoverCardContent>
            </PromptInputHoverCard>
          ))}
          {hasDisabledTools && enableMoreToolsButton}
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
