"use client";

import {
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
import {
  addPendingAction,
  applyPendingActions,
  getPendingActions,
  type PendingToolAction,
} from "@/lib/pending-tool-state";
import { Button } from "../ui/button";

interface ChatToolsDisplayProps {
  agentId: string;
  promptId?: string | null;
  /** Required for enable/disable functionality. Optional for read-only display. */
  conversationId?: string;
  className?: string;
  /** When true, hides enable/disable buttons and shows all tools as enabled */
  readOnly?: boolean;
}

/**
 * Display tools enabled for a chat conversation with ability to disable them.
 * Use this component for chat-level tool management (enable/disable).
 * For profile-level tool assignment, use McpToolsDisplay instead.
 *
 * When no conversation exists, pending actions are stored in localStorage
 * and applied when the conversation is created via first message.
 */
export function ChatToolsDisplay({
  agentId,
  promptId,
  conversationId,
  className,
  readOnly = false,
}: ChatToolsDisplayProps) {
  const { data: profileTools = [], isLoading } =
    useProfileToolsWithIds(agentId);

  // State for tooltip open state per server
  const [openTooltip, setOpenTooltip] = useState<string | null>(null);
  const tooltipContentRef = useRef<HTMLDivElement | null>(null);

  // Local pending actions for display (synced with localStorage)
  const [localPendingActions, setLocalPendingActions] = useState<
    PendingToolAction[]
  >([]);

  // Load pending actions from localStorage on mount and when context changes
  useEffect(() => {
    if (!conversationId) {
      const actions = getPendingActions(agentId, promptId ?? null);
      setLocalPendingActions(actions);
    } else {
      setLocalPendingActions([]);
    }
  }, [agentId, promptId, conversationId]);

  // Handle click outside to close tooltips
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node;

      // Check if click is within the main tooltip content
      if (tooltipContentRef.current?.contains(target)) {
        return;
      }

      // Check if click is on any of the tool buttons
      const clickedButton = (target as HTMLElement).closest(
        "[data-tool-button]",
      );
      if (clickedButton) {
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

  // Fetch enabled tools for the conversation (skip in readOnly mode or without conversationId)
  const { data: enabledToolsData } = useConversationEnabledTools(
    readOnly || !conversationId ? undefined : conversationId,
  );
  const enabledToolIds = enabledToolsData?.enabledToolIds ?? [];
  const hasCustomSelection = enabledToolsData?.hasCustomSelection ?? false;

  // Mutation for updating enabled tools
  const updateEnabledTools = useUpdateConversationEnabledTools();

  // Default enabled tools logic (matches backend ConversationModel.create):
  // - Disable all Archestra tools (archestra__*) by default
  // - Except archestra__todo_write and archestra__artifact_write which stay enabled
  // - All other tools (non-Archestra, agent delegation) remain enabled
  const defaultEnabledToolIds = useMemo(
    () =>
      profileTools
        .filter(
          (tool) =>
            !tool.name.startsWith("archestra__") ||
            tool.name === "archestra__todo_write" ||
            tool.name === "archestra__artifact_write",
        )
        .map((t) => t.id),
    [profileTools],
  );

  // Compute current enabled tools:
  // - If conversation exists with custom selection, use that
  // - If conversation exists without custom selection, use defaults
  // - If no conversation, apply pending actions to defaults
  const currentEnabledToolIds = useMemo(() => {
    if (conversationId && hasCustomSelection) {
      return enabledToolIds;
    }

    // Start with defaults
    const baseIds = defaultEnabledToolIds;

    // If no conversation, apply pending actions for display
    if (!conversationId && localPendingActions.length > 0) {
      return applyPendingActions(baseIds, localPendingActions);
    }

    return baseIds;
  }, [
    conversationId,
    hasCustomSelection,
    enabledToolIds,
    defaultEnabledToolIds,
    localPendingActions,
  ]);

  // Create enabled tool IDs set for quick lookup
  const enabledToolIdsSet = new Set(currentEnabledToolIds);

  // Use only profile tools (agent tools are displayed separately in the header)
  type ToolItem = {
    id: string;
    name: string;
    description: string | null;
  };
  const allTools: ToolItem[] = profileTools;

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

  // Handle enabling a tool
  const handleEnableTool = (toolId: string, event: React.MouseEvent) => {
    event.stopPropagation();
    if (!conversationId) {
      // Store in localStorage and update local state
      const action: PendingToolAction = { type: "enable", toolId };
      addPendingAction(action, agentId, promptId ?? null);
      setLocalPendingActions((prev) => [...prev, action]);
      return;
    }
    const newEnabledToolIds = [...currentEnabledToolIds, toolId];
    updateEnabledTools.mutateAsync({
      conversationId,
      toolIds: newEnabledToolIds,
    });
  };

  // Handle disabling a tool
  const handleDisableTool = (toolId: string, event: React.MouseEvent) => {
    event.stopPropagation();
    if (!conversationId) {
      // Store in localStorage and update local state
      const action: PendingToolAction = { type: "disable", toolId };
      addPendingAction(action, agentId, promptId ?? null);
      setLocalPendingActions((prev) => [...prev, action]);
      return;
    }
    const newEnabledToolIds = currentEnabledToolIds.filter(
      (id) => id !== toolId,
    );
    updateEnabledTools.mutateAsync({
      conversationId,
      toolIds: newEnabledToolIds,
    });
  };

  // Handle disabling all enabled tools for a server
  const handleDisableAll = (toolIds: string[], event: React.MouseEvent) => {
    event.stopPropagation();
    if (!conversationId) {
      // Store in localStorage and update local state
      const action: PendingToolAction = { type: "disableAll", toolIds };
      addPendingAction(action, agentId, promptId ?? null);
      setLocalPendingActions((prev) => [...prev, action]);
      return;
    }
    const newEnabledToolIds = currentEnabledToolIds.filter(
      (id) => !toolIds.includes(id),
    );
    updateEnabledTools.mutateAsync({
      conversationId,
      toolIds: newEnabledToolIds,
    });
  };

  // Handle enabling all disabled tools for a server
  const handleEnableAll = (toolIds: string[], event: React.MouseEvent) => {
    event.stopPropagation();
    if (!conversationId) {
      // Store in localStorage and update local state
      const action: PendingToolAction = { type: "enableAll", toolIds };
      addPendingAction(action, agentId, promptId ?? null);
      setLocalPendingActions((prev) => [...prev, action]);
      return;
    }
    const newEnabledToolIds = [
      ...new Set([...currentEnabledToolIds, ...toolIds]),
    ];
    updateEnabledTools.mutateAsync({
      conversationId,
      toolIds: newEnabledToolIds,
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

    return (
      <div key={tool.id} className={`border-l-2 ${borderColor} pl-2 ml-1 py-1`}>
        <div className="flex items-center gap-2">
          <span className="font-medium text-sm">{toolName}</span>
          <div className="flex-1" />
          {!readOnly &&
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
    return null;
  }

  const toolButtons = sortedServerEntries.map(([serverName]) => {
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
    // In readOnly mode, treat all tools as "enabled" for display purposes
    const enabledTools: ToolItem[] = [];
    const disabledTools: ToolItem[] = [];

    for (const tool of allServerTools) {
      if (readOnly || enabledToolIdsSet.has(tool.id)) {
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
            data-tool-button
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
              {readOnly
                ? `(${totalToolsCount})`
                : `(${enabledTools.length}/${totalToolsCount})`}
            </span>
          </PromptInputButton>
        </TooltipTrigger>
        <TooltipContent
          ref={tooltipContentRef}
          side="top"
          align="center"
          className="min-w-80 max-h-96 p-0 overflow-y-auto"
          sideOffset={4}
          noArrow
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
                    {readOnly
                      ? `Tools (${enabledTools.length})`
                      : `Enabled (${enabledTools.length})`}
                  </span>
                  {!readOnly && (
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
                  )}
                </div>
                <div className="space-y-1 px-2 pb-2">
                  {enabledTools.map((tool) =>
                    renderToolRow(tool, false, serverName),
                  )}
                </div>
              </div>
            )}

            {/* Disabled section - hide in readOnly mode */}
            {!readOnly && disabledTools.length > 0 && (
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
  });

  return <TooltipProvider>{toolButtons}</TooltipProvider>;
}
