"use client";

import { isAgentTool } from "@shared";
import { Bot, Wrench } from "lucide-react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ExpandableText } from "@/components/ui/expandable-text";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card";
import { useAgentDelegations } from "@/lib/agent-tools.query";
import {
  useChatProfileMcpTools,
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
import { cn } from "@/lib/utils";

// Component to display tools for a specific agent
function AgentToolsList({ agentId }: { agentId: string }) {
  const { data: tools = [], isLoading } = useChatProfileMcpTools(agentId);

  if (isLoading) {
    return <p className="text-xs text-muted-foreground">Loading tools...</p>;
  }

  if (tools.length === 0) {
    return <p className="text-xs text-muted-foreground">No tools available</p>;
  }

  return (
    <div className="space-y-1">
      <p className="text-xs font-medium text-muted-foreground mb-2">
        Available tools ({tools.length}):
      </p>
      <div className="flex flex-wrap gap-1 max-h-[200px] overflow-y-auto">
        {tools.map((tool) => (
          <span
            key={tool.name}
            className="inline-flex items-center gap-1 text-xs bg-muted px-2 py-0.5 rounded"
          >
            <Wrench className="h-3 w-3 opacity-70" />
            {tool.name}
          </span>
        ))}
      </div>
    </div>
  );
}

interface AgentToolsDisplayProps {
  agentId: string;
  conversationId?: string;
  addAgentsButton: ReactNode;
}

/**
 * Display agent delegations (agents this agent can delegate to).
 * Uses database-backed enabled tools state (same as ChatToolsDisplay for MCP tools).
 * Supports enable/disable toggle persisted via conversation_enabled_tools API.
 */
export function AgentToolsDisplay({
  agentId,
  conversationId,
  addAgentsButton,
}: AgentToolsDisplayProps) {
  // Fetch delegated agents for display info (name, description)
  const { data: delegatedAgents = [], isLoading: isLoadingAgents } =
    useAgentDelegations(agentId);

  // Fetch all profile tools to get delegation tool IDs
  const { data: profileTools = [], isLoading: isLoadingTools } =
    useProfileToolsWithIds(agentId);

  // Filter for delegation tools only (tools with name starting with agent__)
  const delegationTools = useMemo(
    () => profileTools.filter((tool) => isAgentTool(tool.name)),
    [profileTools],
  );

  // Create a map from target agent ID to tool ID for quick lookup
  const targetAgentToToolId = useMemo(() => {
    const map = new Map<string, string>();
    for (const tool of delegationTools) {
      if (tool.delegateToAgentId) {
        map.set(tool.delegateToAgentId, tool.id);
      }
    }
    return map;
  }, [delegationTools]);

  // Local pending actions for display (synced with localStorage)
  const [localPendingActions, setLocalPendingActions] = useState<
    PendingToolAction[]
  >([]);

  // Load pending actions from localStorage on mount and when context changes
  useEffect(() => {
    if (!conversationId) {
      const actions = getPendingActions(agentId);
      setLocalPendingActions(actions);
    } else {
      setLocalPendingActions([]);
    }
  }, [agentId, conversationId]);

  // Fetch enabled tools for the conversation
  const { data: enabledToolsData } =
    useConversationEnabledTools(conversationId);
  const enabledToolIds = enabledToolsData?.enabledToolIds ?? [];
  const hasCustomSelection = enabledToolsData?.hasCustomSelection ?? false;

  // Mutation for updating enabled tools
  const updateEnabledTools = useUpdateConversationEnabledTools();

  // Default enabled tools: all delegation tools are enabled by default
  const defaultEnabledToolIds = useMemo(
    () => delegationTools.map((t) => t.id),
    [delegationTools],
  );

  // Compute current enabled tools (same pattern as ChatToolsDisplay)
  const currentEnabledToolIds = useMemo(() => {
    if (conversationId && hasCustomSelection) {
      return enabledToolIds;
    }

    // Start with defaults (all delegation tools enabled)
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

  const enabledToolIdsSet = new Set(currentEnabledToolIds);

  // Check if a delegation is enabled (by target agent ID)
  const isEnabled = useCallback(
    (targetAgentId: string) => {
      const toolId = targetAgentToToolId.get(targetAgentId);
      if (!toolId) return true; // Default to enabled if tool not found
      return enabledToolIdsSet.has(toolId);
    },
    [targetAgentToToolId, enabledToolIdsSet],
  );

  // Handle toggling a delegation (by target agent ID)
  const handleToggle = useCallback(
    (targetAgentId: string) => {
      const toolId = targetAgentToToolId.get(targetAgentId);
      if (!toolId) return;

      const currentlyEnabled = enabledToolIdsSet.has(toolId);

      if (!conversationId) {
        // Store in localStorage and update local state
        const action: PendingToolAction = currentlyEnabled
          ? { type: "disable", toolId }
          : { type: "enable", toolId };
        addPendingAction(action, agentId);
        setLocalPendingActions((prev) => [...prev, action]);
        return;
      }

      // Update via API
      const newEnabledToolIds = currentlyEnabled
        ? currentEnabledToolIds.filter((id) => id !== toolId)
        : [...currentEnabledToolIds, toolId];

      updateEnabledTools.mutateAsync({
        conversationId,
        toolIds: newEnabledToolIds,
      });
    },
    [
      targetAgentToToolId,
      enabledToolIdsSet,
      conversationId,
      agentId,
      currentEnabledToolIds,
      updateEnabledTools,
    ],
  );

  const isLoading = isLoadingAgents || isLoadingTools;

  if (isLoading || delegatedAgents.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {delegatedAgents.map((delegatedAgent) => {
        const enabled = isEnabled(delegatedAgent.id);

        return (
          <HoverCard key={delegatedAgent.id} openDelay={200} closeDelay={100}>
            <HoverCardTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className={cn(
                  "h-7 px-2 gap-1.5 text-xs",
                  !enabled && "opacity-60",
                )}
              >
                <span
                  className={cn(
                    "h-2 w-2 rounded-full",
                    enabled ? "bg-green-500" : "bg-red-500",
                  )}
                />
                <Bot className="h-3 w-3" />
                <span>{delegatedAgent.name}</span>
              </Button>
            </HoverCardTrigger>
            <HoverCardContent className="w-80" align="start">
              <div className="space-y-3">
                <h4 className="text-sm font-semibold">{delegatedAgent.name}</h4>
                {delegatedAgent.description && (
                  <ExpandableText
                    text={delegatedAgent.description}
                    maxLines={2}
                    className="text-xs text-muted-foreground"
                  />
                )}
                <label
                  htmlFor={`chat-subagent-toggle-${delegatedAgent.id}`}
                  className="flex items-center gap-3 cursor-pointer"
                >
                  <Checkbox
                    id={`chat-subagent-toggle-${delegatedAgent.id}`}
                    checked={enabled}
                    onCheckedChange={() => handleToggle(delegatedAgent.id)}
                  />
                  <span className="text-sm font-medium">
                    {enabled ? "Enabled" : "Enable"}
                  </span>
                </label>
                <AgentToolsList agentId={delegatedAgent.id} />
              </div>
            </HoverCardContent>
          </HoverCard>
        );
      })}
      {addAgentsButton}
    </div>
  );
}
