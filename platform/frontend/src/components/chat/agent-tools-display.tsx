"use client";

import { Bot, Wrench } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card";
import { useAgentDelegations } from "@/lib/agent-tools.query";
import { useChatProfileMcpTools } from "@/lib/chat.query";
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

// Local storage key for disabled delegations
const getStorageKey = (agentId: string, conversationId?: string) =>
  `disabled-delegations:${agentId}:${conversationId || "initial"}`;

/**
 * Display agent delegations (agents this agent can delegate to).
 * Uses the agent_tools/delegations data like the canvas.
 * Supports enable/disable toggle with state persisted in localStorage.
 */
export function AgentToolsDisplay({
  agentId,
  conversationId,
  addAgentsButton,
}: AgentToolsDisplayProps) {
  // Fetch delegated agents from agent_tools (like canvas)
  const { data: delegatedAgents = [], isLoading } =
    useAgentDelegations(agentId);

  // Track disabled delegation agent IDs
  const [disabledAgentIds, setDisabledAgentIds] = useState<Set<string>>(
    new Set(),
  );

  // Load disabled state from localStorage on mount
  useEffect(() => {
    const storageKey = getStorageKey(agentId, conversationId);
    const stored = localStorage.getItem(storageKey);
    if (stored) {
      try {
        const parsed = JSON.parse(stored);
        if (Array.isArray(parsed)) {
          setDisabledAgentIds(new Set(parsed));
        }
      } catch {
        // Ignore invalid JSON
      }
    } else {
      setDisabledAgentIds(new Set());
    }
  }, [agentId, conversationId]);

  // Save disabled state to localStorage
  const saveDisabledState = useCallback(
    (newDisabled: Set<string>) => {
      const storageKey = getStorageKey(agentId, conversationId);
      localStorage.setItem(storageKey, JSON.stringify([...newDisabled]));
    },
    [agentId, conversationId],
  );

  // Toggle delegation enabled/disabled
  const handleToggle = useCallback(
    (targetAgentId: string) => {
      setDisabledAgentIds((prev) => {
        const newSet = new Set(prev);
        if (newSet.has(targetAgentId)) {
          newSet.delete(targetAgentId);
        } else {
          newSet.add(targetAgentId);
        }
        saveDisabledState(newSet);
        return newSet;
      });
    },
    [saveDisabledState],
  );

  // Check if a delegation is enabled
  const isEnabled = useCallback(
    (targetAgentId: string) => !disabledAgentIds.has(targetAgentId),
    [disabledAgentIds],
  );

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
            <HoverCardContent
              className="w-80 cursor-pointer"
              align="start"
              onClick={() => handleToggle(delegatedAgent.id)}
            >
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <h4 className="text-sm font-semibold">
                    {delegatedAgent.name}
                  </h4>
                  <span
                    className={cn(
                      "text-xs px-2 py-0.5 rounded",
                      enabled
                        ? "bg-green-100 text-green-700"
                        : "bg-red-100 text-red-700",
                    )}
                  >
                    {enabled ? "Enabled" : "Disabled"}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground">
                  Click to {enabled ? "disable" : "enable"} this agent
                </p>
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
