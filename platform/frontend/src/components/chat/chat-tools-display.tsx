"use client";

import {
  AGENT_TOOL_PREFIX,
  ARCHESTRA_MCP_SERVER_NAME,
  MCP_SERVER_TOOL_NAME_SEPARATOR,
} from "@shared";
import { Loader2, Plus, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { PromptInputButton } from "@/components/ai-elements/prompt-input";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  useConversationEnabledTools,
  useProfileToolsWithIds,
  useUpdateConversationEnabledTools,
} from "@/lib/chat.query";
import { usePromptAgents } from "@/lib/prompt-agents.query";
import { Button } from "../ui/button";

interface ChatToolsDisplayProps {
  agentId: string;
  conversationId: string;
  promptId?: string | null;
  className?: string;
}

/**
 * Display tools enabled for a chat conversation with ability to disable them.
 * Use this component for chat-level tool management (enable/disable).
 * For profile-level tool assignment, use McpToolsDisplay instead.
 */
/**
 * Convert a name to a URL-safe slug (must match backend slugify function)
 */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export function ChatToolsDisplay({
  agentId,
  conversationId,
  promptId,
  className,
}: ChatToolsDisplayProps) {
  const { data: profileTools = [], isLoading: isLoadingProfileTools } =
    useProfileToolsWithIds(agentId);

  // Fetch prompt agents (for agent delegation tools)
  const { data: promptAgents = [], isLoading: isLoadingPromptAgents } =
    usePromptAgents(promptId ?? undefined);

  // Generate agent delegation tools from prompt agents
  const agentDelegationTools = useMemo(() => {
    return promptAgents.map((agent) => ({
      id: `agent-tool-${agent.agentPromptId}`, // Virtual ID for agent tools
      name: `${AGENT_TOOL_PREFIX}${slugify(agent.name)}`,
      description:
        agent.systemPrompt?.substring(0, 100) || `Agent: ${agent.name}`,
      isAgentTool: true,
    }));
  }, [promptAgents]);

  const isLoading = isLoadingProfileTools || isLoadingPromptAgents;

  // State for tooltip open state per server
  const [openTooltip, setOpenTooltip] = useState<string | null>(null);
  const componentRef = useRef<HTMLDivElement>(null);
  const tooltipContentRef = useRef<HTMLDivElement | null>(null);

  // Handle click outside to close tooltips
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node;

      // Check if click is within the component
      if (componentRef.current?.contains(target)) {
        return;
      }

      // Check if click is within the main tooltip content
      if (tooltipContentRef.current?.contains(target)) {
        return;
      }

      // If we got here, click was outside everything
      setOpenTooltip(null);
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, []);

  // Fetch enabled tools for the conversation
  const { data: enabledToolsData } =
    useConversationEnabledTools(conversationId);
  const enabledToolIds = enabledToolsData?.enabledToolIds ?? [];
  const hasCustomSelection = enabledToolsData?.hasCustomSelection ?? false;

  // Mutation for updating enabled tools
  const updateEnabledTools = useUpdateConversationEnabledTools();

  // Get the current list of enabled tools
  // If no custom selection, all profile tools are enabled by default
  const currentEnabledToolIds = hasCustomSelection
    ? enabledToolIds
    : profileTools.map((t) => t.id);

  // Create a map of tool name -> tool ID for quick lookup
  const toolNameToId: Record<string, string> = {};
  for (const tool of profileTools) {
    toolNameToId[tool.name] = tool.id;
  }

  // Create enabled tool IDs set for quick lookup
  // Use currentEnabledToolIds to handle both custom and default states
  const enabledToolIdsSet = new Set(currentEnabledToolIds);

  // Combine profile tools with agent delegation tools
  type ToolItem = {
    id: string;
    name: string;
    description: string | null;
    isAgentTool?: boolean;
  };
  const allTools: ToolItem[] = [...profileTools, ...agentDelegationTools];

  // Group ALL tools by MCP server name (don't filter by enabled status)
  const groupedTools: Record<string, ToolItem[]> = {};
  for (const tool of allTools) {
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

  // Helper to check if a tool ID is an agent tool (virtual ID)
  const isAgentToolId = (toolId: string) => toolId.startsWith("agent-tool-");

  // Filter out agent tool IDs - they can't be stored in the database
  const filterOutAgentToolIds = (toolIds: string[]) =>
    toolIds.filter((id) => !isAgentToolId(id));

  // Handle enabling a tool
  const handleEnableTool = (toolId: string, event: React.MouseEvent) => {
    event.stopPropagation();
    // Skip agent tools - they can't be persisted
    if (isAgentToolId(toolId)) return;
    const newEnabledToolIds = [...currentEnabledToolIds, toolId];
    updateEnabledTools.mutateAsync({
      conversationId,
      toolIds: filterOutAgentToolIds(newEnabledToolIds),
    });
  };

  // Handle disabling a tool
  const handleDisableTool = (toolId: string, event: React.MouseEvent) => {
    event.stopPropagation();
    // Skip agent tools - they can't be persisted
    if (isAgentToolId(toolId)) return;
    const newEnabledToolIds = currentEnabledToolIds.filter(
      (id) => id !== toolId,
    );
    updateEnabledTools.mutateAsync({
      conversationId,
      toolIds: filterOutAgentToolIds(newEnabledToolIds),
    });
  };

  // Handle disabling all enabled tools for a server
  const handleDisableAll = (toolIds: string[], event: React.MouseEvent) => {
    event.stopPropagation();
    const newEnabledToolIds = currentEnabledToolIds.filter(
      (id) => !toolIds.includes(id),
    );
    updateEnabledTools.mutateAsync({
      conversationId,
      toolIds: filterOutAgentToolIds(newEnabledToolIds),
    });
  };

  // Handle enabling all disabled tools for a server
  const handleEnableAll = (toolIds: string[], event: React.MouseEvent) => {
    event.stopPropagation();
    // Filter out agent tool IDs before saving
    const profileToolIds = toolIds.filter((id) => !isAgentToolId(id));
    const newEnabledToolIds = [
      ...new Set([...currentEnabledToolIds, ...profileToolIds]),
    ];
    updateEnabledTools.mutateAsync({
      conversationId,
      toolIds: filterOutAgentToolIds(newEnabledToolIds),
    });
  };

  // Render a single tool row
  const renderToolRow = (
    tool: ToolItem,
    isDisabled: boolean,
    _currentServerName: string,
  ) => {
    const parts = tool.name.split(MCP_SERVER_TOOL_NAME_SEPARATOR);
    const toolName = parts.length > 1 ? parts[parts.length - 1] : tool.name;
    const borderColor = isDisabled ? "border-red-500" : "border-green-500";
    const isAgentTool = tool.isAgentTool === true;

    return (
      <div key={tool.id} className={`border-l-2 ${borderColor} pl-2 ml-1 py-1`}>
        <div className="flex items-center gap-2">
          <span className="font-medium text-sm">{toolName}</span>
          <div className="flex-1" />
          {/* Agent tools can't be toggled - they're always enabled */}
          {!isAgentTool &&
            (isDisabled ? (
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
            ))}
        </div>
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

  if (Object.keys(groupedTools).length === 0) {
    return (
      <div className={className}>
        <div className="flex flex-wrap gap-2" />
      </div>
    );
  }

  return (
    <div className={className} ref={componentRef}>
      <TooltipProvider>
        <div className="flex flex-wrap gap-2">
          {sortedServerEntries.map(([serverName]) => {
            // Get all tools for this server from allTools (profile tools + agent tools)
            const allServerTools = allTools.filter((tool) => {
              const parts = tool.name.split(MCP_SERVER_TOOL_NAME_SEPARATOR);
              const toolServerName =
                parts.length > 1
                  ? parts.slice(0, -1).join(MCP_SERVER_TOOL_NAME_SEPARATOR)
                  : "default";
              return toolServerName === serverName;
            });

            // Split into enabled and disabled using the consistent enabledToolIdsSet
            // Agent tools are always considered enabled
            const enabledTools: ToolItem[] = [];
            const disabledTools: ToolItem[] = [];

            for (const tool of allServerTools) {
              // Agent tools are always enabled - they can't be disabled (no DB persistence)
              // Profile tools: check the enabledToolIdsSet
              const isEnabled =
                tool.isAgentTool || enabledToolIdsSet.has(tool.id);

              if (isEnabled) {
                enabledTools.push(tool);
              } else {
                disabledTools.push(tool);
              }
            }

            const totalToolsCount = allServerTools.length;
            const isOpen = openTooltip === serverName;

            return (
              <Tooltip key={serverName} open={isOpen} onOpenChange={() => {}}>
                <TooltipTrigger asChild>
                  <PromptInputButton
                    className="w-[fit-content]"
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setOpenTooltip(isOpen ? null : serverName);
                    }}
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
                  ref={tooltipContentRef}
                  side="top"
                  align="center"
                  className="min-w-80 max-h-96 p-0 overflow-y-auto"
                  sideOffset={10}
                  onWheel={(e) => e.stopPropagation()}
                  onTouchMove={(e) => e.stopPropagation()}
                  onPointerDownOutside={(e) => {
                    e.preventDefault();
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
                          {/* Only show Disable All if there are non-agent tools */}
                          {enabledTools.some((t) => !t.isAgentTool) && (
                            <Button
                              variant="outline"
                              size="sm"
                              className="text-xs"
                              onClick={(e) =>
                                handleDisableAll(
                                  enabledTools
                                    .filter((t) => !t.isAgentTool)
                                    .map((t) => t.id),
                                  e,
                                )
                              }
                            >
                              Disable All
                            </Button>
                          )}
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
        </div>
      </TooltipProvider>
    </div>
  );
}
