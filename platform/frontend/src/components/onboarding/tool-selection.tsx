"use client";

import { Check, Loader2 } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { assignToolToAgent } from "@/lib/clients/api";
import { useUnassignedTools } from "@/lib/tool.query";
import OnboardingStep from "../onboarding-step";

interface ToolSelectionProps {
  isActive: boolean;
  isTransitioning: boolean;
  agentId: string;
  mcpServerId: string | null;
  mcpServerName?: string;
  onComplete: () => void;
}

export function ToolSelection({
  isActive,
  isTransitioning,
  agentId,
  mcpServerId,
  mcpServerName,
  onComplete,
}: ToolSelectionProps) {
  const [selectedToolIds, setSelectedToolIds] = useState<Set<string>>(
    new Set(),
  );
  const [isAssigningTools, setIsAssigningTools] = useState(false);

  const { data: unassignedTools } = useUnassignedTools({});

  // Filter tools by MCP server ID
  const tools = useMemo(() => {
    if (!unassignedTools || !mcpServerId) return [];
    return unassignedTools.filter((tool) => tool.mcpServer?.id === mcpServerId);
  }, [unassignedTools, mcpServerId]);

  const toggleTool = (toolId: string) => {
    const newSelected = new Set(selectedToolIds);
    if (newSelected.has(toolId)) {
      newSelected.delete(toolId);
    } else {
      newSelected.add(toolId);
    }
    setSelectedToolIds(newSelected);
  };

  const handleAssignTools = async () => {
    if (!agentId || selectedToolIds.size === 0) return;

    setIsAssigningTools(true);
    try {
      // Assign all selected tools to the agent
      await Promise.all(
        Array.from(selectedToolIds).map((toolId) =>
          assignToolToAgent({
            path: {
              agentId,
              toolId,
            },
          }),
        ),
      );

      onComplete();
    } catch (error) {
      toast.error("Failed to assign tools. Please try again.");
    } finally {
      setIsAssigningTools(false);
    }
  };

  return (
    <OnboardingStep
      title="Select Tools to Assign"
      description={`Choose which tools from ${mcpServerName || "the MCP server"} to assign to your agent`}
      isActive={isActive}
      isTransitioning={isTransitioning}
      primaryAction={{
        label: isAssigningTools ? "Assigning tools..." : "Continue",
        onClick: handleAssignTools,
        disabled: selectedToolIds.size === 0 || isAssigningTools,
      }}
    >
      <div className="space-y-3 max-h-96 overflow-y-auto">
        {tools.length === 0 ? (
          <div className="text-sm text-slate-400">
            No tools available from this MCP server
          </div>
        ) : (
          tools.map((tool) => (
            <label
              key={tool.id}
              className="flex items-start gap-3 p-3 rounded border border-slate-700 hover:border-slate-600 cursor-pointer transition-colors"
            >
              <input
                type="checkbox"
                checked={selectedToolIds.has(tool.id)}
                onChange={() => toggleTool(tool.id)}
                className="mt-1 cursor-pointer"
              />
              <div className="flex-1 min-w-0">
                <div className="font-medium text-sm text-slate-100">
                  {tool.name}
                </div>
                {tool.description && (
                  <div className="text-xs text-slate-400 mt-1">
                    {tool.description}
                  </div>
                )}
              </div>
              {selectedToolIds.has(tool.id) && (
                <Check className="h-4 w-4 text-green-500 flex-shrink-0 mt-1" />
              )}
            </label>
          ))
        )}
      </div>

      {isAssigningTools && (
        <div className="flex items-center gap-2 text-sm text-slate-400 mt-4">
          <Loader2 className="h-4 w-4 animate-spin" />
          Assigning tools to agent...
        </div>
      )}
    </OnboardingStep>
  );
}
