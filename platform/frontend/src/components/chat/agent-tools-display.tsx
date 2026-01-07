"use client";

import { Bot } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  useConversationEnabledTools,
  usePromptTools,
  useUpdateConversationEnabledTools,
} from "@/lib/chat.query";
import { usePrompts } from "@/lib/prompts.query";
import { cn } from "@/lib/utils";

// Pending action to apply after conversation is created
type PendingAgentAction = {
  type: "toggle";
  toolId: string;
  shouldDisable: boolean;
};

interface AgentToolsDisplayProps {
  promptId: string | null;
  conversationId?: string;
  /** Called when user toggles an agent in initial state (no conversation) */
  onCreateConversation?: () => void;
}

export function AgentToolsDisplay({
  promptId,
  conversationId,
  onCreateConversation,
}: AgentToolsDisplayProps) {
  // Always fetch prompt tools - they exist regardless of conversation
  const { data: promptTools = [], isLoading } = usePromptTools(
    promptId ?? undefined,
  );

  const { data: allPrompts = [] } = usePrompts();

  // Track pending action to apply after conversation is created
  const [pendingAction, setPendingAction] = useState<PendingAgentAction | null>(
    null,
  );
  const prevConversationId = useRef<string | undefined>(undefined);

  // Fetch enabled tools for the conversation
  const { data: enabledToolsData } =
    useConversationEnabledTools(conversationId);

  // Mutation for updating enabled tools
  const updateEnabledTools = useUpdateConversationEnabledTools();

  // Derived values
  const enabledToolIds = enabledToolsData?.enabledToolIds ?? [];

  // Map promptTools to their display names
  const agentToolsWithNames = useMemo(() => {
    return promptTools.map((tool) => {
      const promptName = tool.name.replace(/^agent__/, "");
      const matchingPrompt = allPrompts.find(
        (p) => p.name.toLowerCase().replace(/\s+/g, "_") === promptName,
      );
      return {
        ...tool,
        displayName: matchingPrompt?.name ?? promptName.replace(/_/g, " "),
      };
    });
  }, [promptTools, allPrompts]);

  // Default: all agent tools are enabled (matches backend behavior)
  const defaultEnabledAgentToolIds = promptTools.map((t) => t.id);

  // Check if conversation has custom tool selection
  const hasCustomSelection = enabledToolsData?.hasCustomSelection ?? false;

  // Current enabled tool IDs:
  // - If custom selection exists, use it
  // - Otherwise use default (all agents enabled) - this is stable like ChatToolsDisplay
  const currentEnabledToolIds = hasCustomSelection
    ? enabledToolIds
    : defaultEnabledAgentToolIds;

  // Check if a tool is enabled (considering pending action for visual feedback)
  const isToolEnabled = (toolId: string) => {
    // If we have a pending action for this tool, show the pending state
    if (pendingAction?.toolId === toolId) {
      return !pendingAction.shouldDisable;
    }
    return currentEnabledToolIds.includes(toolId);
  };

  // Handle toggle - works for both initial and conversation states
  const handleToggle = (toolId: string) => {
    const isCurrentlyEnabled = isToolEnabled(toolId);

    if (!conversationId) {
      // No conversation yet - set pending action and create conversation
      setPendingAction({
        type: "toggle",
        toolId,
        shouldDisable: isCurrentlyEnabled,
      });
      onCreateConversation?.();
      return;
    }

    // Has conversation - update directly
    let newEnabledToolIds: string[];
    if (isCurrentlyEnabled) {
      newEnabledToolIds = enabledToolIds.filter((id) => id !== toolId);
    } else {
      newEnabledToolIds = [...enabledToolIds, toolId];
    }

    updateEnabledTools.mutate({
      conversationId,
      toolIds: newEnabledToolIds,
    });
  };

  // Apply pending action when conversation is created
  useEffect(() => {
    // Detect when conversationId changes from undefined to defined
    if (
      pendingAction &&
      conversationId &&
      prevConversationId.current === undefined &&
      enabledToolsData
    ) {
      const { toolId, shouldDisable } = pendingAction;

      let newEnabledToolIds: string[];
      if (shouldDisable) {
        newEnabledToolIds = enabledToolIds.filter((id) => id !== toolId);
      } else {
        newEnabledToolIds = [...new Set([...enabledToolIds, toolId])];
      }

      updateEnabledTools.mutate(
        {
          conversationId,
          toolIds: newEnabledToolIds,
        },
        {
          onSettled: () => {
            // Clear pending action only after mutation completes and query invalidates
            setPendingAction(null);
          },
        },
      );

      // Only update prevConversationId AFTER applying pending action
      prevConversationId.current = conversationId;
    } else if (!pendingAction) {
      // No pending action - just track the conversationId
      prevConversationId.current = conversationId;
    }
    // If there IS a pending action but conditions aren't met yet,
    // DON'T update prevConversationId - keep it undefined so we can retry
  }, [
    conversationId,
    pendingAction,
    enabledToolsData,
    enabledToolIds,
    updateEnabledTools,
  ]);

  if (isLoading || agentToolsWithNames.length === 0) {
    return null;
  }

  return (
    <TooltipProvider>
      <div className="flex items-center gap-1">
        {agentToolsWithNames.map((tool) => {
          const isEnabled = isToolEnabled(tool.id);

          return (
            <Tooltip key={tool.id}>
              <TooltipTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  className={cn(
                    "h-7 px-2 gap-1.5 text-xs",
                    !isEnabled && "opacity-60",
                  )}
                  onClick={() => handleToggle(tool.id)}
                >
                  <span
                    className={cn(
                      "h-2 w-2 rounded-full",
                      isEnabled ? "bg-green-500" : "bg-red-500",
                    )}
                  />
                  <Bot className="h-3 w-3" />
                  <span>{tool.displayName}</span>
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                <p>
                  {isEnabled
                    ? `Click to disable ${tool.displayName}`
                    : `Click to enable ${tool.displayName}`}
                </p>
              </TooltipContent>
            </Tooltip>
          );
        })}
      </div>
    </TooltipProvider>
  );
}
