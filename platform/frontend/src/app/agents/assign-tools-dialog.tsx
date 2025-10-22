"use client";

import { Loader2, Server } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  useAgentTools,
  useAssignTool,
  useUnassignTool,
} from "@/lib/agent-tools.query";
import type { GetAgentsResponses } from "@/lib/clients/api";
import { useTools } from "@/lib/tool.query";

interface AssignToolsDialogProps {
  agent: GetAgentsResponses["200"][number];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function AssignToolsDialog({
  agent,
  open,
  onOpenChange,
}: AssignToolsDialogProps) {
  // Fetch all tools and filter for MCP tools
  const { data: allTools, isLoading: isLoadingAllTools } = useTools({});
  const mcpTools = allTools?.filter((tool) => tool.mcpServer !== null) || [];

  // Fetch currently assigned tools for this agent
  const { data: agentTools, isLoading: isLoadingAgentTools } = useAgentTools(
    agent.id,
  );

  // Track selected tool IDs
  const [selectedToolIds, setSelectedToolIds] = useState<Set<string>>(
    new Set(),
  );

  // Initialize selected tools when agent tools load
  useEffect(() => {
    if (agentTools) {
      const mcpToolIds = agentTools
        .filter((tool) => tool.mcpServerId !== null)
        .map((tool) => tool.id);
      setSelectedToolIds(new Set(mcpToolIds));
    }
  }, [agentTools]);

  const assignTool = useAssignTool();
  const unassignTool = useUnassignTool();

  const isLoading = isLoadingAllTools || isLoadingAgentTools;
  const isSaving = assignTool.isPending || unassignTool.isPending;

  const handleToggleTool = useCallback((toolId: string) => {
    setSelectedToolIds((prev) => {
      const next = new Set(prev);
      if (next.has(toolId)) {
        next.delete(toolId);
      } else {
        next.add(toolId);
      }
      return next;
    });
  }, []);

  const handleSave = useCallback(async () => {
    if (!agentTools) return;

    // Get current MCP tool IDs assigned to this agent
    const currentToolIds = new Set(
      agentTools
        .filter((tool) => tool.mcpServerId !== null)
        .map((tool) => tool.id),
    );

    // Determine which tools to assign and unassign
    const toAssign = Array.from(selectedToolIds).filter(
      (id) => !currentToolIds.has(id),
    );
    const toUnassign = Array.from(currentToolIds).filter(
      (id) => !selectedToolIds.has(id),
    );

    try {
      // Assign new tools
      for (const toolId of toAssign) {
        await assignTool.mutateAsync({ agentId: agent.id, toolId });
      }

      // Unassign removed tools
      for (const toolId of toUnassign) {
        await unassignTool.mutateAsync({ agentId: agent.id, toolId });
      }

      toast.success(`Successfully updated tools for ${agent.name}`);

      onOpenChange(false);
    } catch (_error) {
      toast.error("Failed to update tool assignments");
    }
  }, [
    agent,
    agentTools,
    assignTool,
    unassignTool,
    onOpenChange,
    selectedToolIds,
  ]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>Assign Tools to {agent.name}</DialogTitle>
          <DialogDescription>
            Select which MCP server tools this agent can access.
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto pr-2 -mr-2">
          {isLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : mcpTools.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-8 text-center">
              <Server className="h-12 w-12 text-muted-foreground mb-2" />
              <p className="text-sm text-muted-foreground">
                No MCP server tools available.
              </p>
              <p className="text-xs text-muted-foreground mt-1">
                Install an MCP server to get started.
              </p>
            </div>
          ) : (
            <div className="space-y-4">
              {mcpTools.map((tool) => (
                <div
                  key={tool.id}
                  className="flex items-start space-x-3 rounded-lg border p-4 hover:bg-muted/50 transition-colors"
                >
                  <Checkbox
                    id={`tool-${tool.id}`}
                    checked={selectedToolIds.has(tool.id)}
                    onCheckedChange={() => handleToggleTool(tool.id)}
                    disabled={isSaving}
                  />
                  <div className="flex-1 space-y-1">
                    <Label
                      htmlFor={`tool-${tool.id}`}
                      className="text-sm font-medium leading-none cursor-pointer"
                    >
                      {tool.name}
                    </Label>
                    {tool.description && (
                      <p className="text-sm text-muted-foreground">
                        {tool.description}
                      </p>
                    )}
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <Server className="h-3 w-3" />
                      <span>MCP Server Tool</span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isSaving}
          >
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={isLoading || isSaving}>
            {isSaving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Save Changes
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
