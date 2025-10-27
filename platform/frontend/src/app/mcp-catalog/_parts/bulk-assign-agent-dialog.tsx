"use client";

import { Search } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
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
import { Input } from "@/components/ui/input";
import { useAgents } from "@/lib/agent.query";
import { useAssignTool } from "@/lib/agent-tools.query";

interface BulkAssignAgentDialogProps {
  tools: Array<{
    id: string;
    name: string;
    description: string | null;
    parameters: Record<string, unknown>;
    createdAt: string;
  }> | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function BulkAssignAgentDialog({
  tools,
  open,
  onOpenChange,
}: BulkAssignAgentDialogProps) {
  const { data: agents } = useAgents({});
  const assignMutation = useAssignTool();
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedAgentIds, setSelectedAgentIds] = useState<string[]>([]);

  const filteredAgents = useMemo(() => {
    if (!agents || !searchQuery.trim()) return agents || [];

    const query = searchQuery.toLowerCase();
    return agents.filter((agent) => agent.name.toLowerCase().includes(query));
  }, [agents, searchQuery]);

  const handleAssign = useCallback(async () => {
    if (!tools || tools.length === 0 || selectedAgentIds.length === 0) return;

    // Helper function to check if an error is a duplicate key error
    const isDuplicateError = (error: unknown): boolean => {
      if (!error) return false;
      const errorStr = JSON.stringify(error).toLowerCase();
      return (
        errorStr.includes("duplicate key") ||
        errorStr.includes("agent_tools_agent_id_tool_id_unique") ||
        errorStr.includes("already assigned")
      );
    };

    // Assign each tool to each selected agent
    const assignments = tools.flatMap((tool) =>
      selectedAgentIds.map((agentId) => ({
        agentId,
        toolId: tool.id,
        toolName: tool.name,
      })),
    );

    const results = await Promise.allSettled(
      assignments.map((assignment) =>
        assignMutation.mutateAsync({
          agentId: assignment.agentId,
          toolId: assignment.toolId,
        }),
      ),
    );

    const succeeded = results.filter((r) => r.status === "fulfilled").length;
    const failed = results.filter((r) => r.status === "rejected").length;
    const totalAttempted = results.length;

    // Check if failures are due to duplicates
    const duplicates = results.filter(
      (r) => r.status === "rejected" && isDuplicateError(r.reason),
    ).length;

    const actualFailures = failed - duplicates;

    if (succeeded > 0) {
      if (duplicates > 0 && actualFailures === 0) {
        toast.success(
          `Successfully assigned ${succeeded} tool assignment${succeeded !== 1 ? "s" : ""}. ${duplicates} ${duplicates === 1 ? "was" : "were"} already assigned.`,
        );
      } else if (actualFailures > 0) {
        toast.warning(
          `Assigned ${succeeded} of ${totalAttempted} tool${totalAttempted !== 1 ? "s" : ""}. ${actualFailures} failed.`,
        );
      } else {
        toast.success(
          `Successfully assigned ${succeeded} tool assignment${succeeded !== 1 ? "s" : ""}`,
        );
      }
    } else if (duplicates === failed) {
      toast.info(
        "All selected tools are already assigned to the selected agents",
      );
    } else {
      toast.error("Failed to assign tools");
      console.error("Bulk assignment errors:", results);
    }

    setSelectedAgentIds([]);
    setSearchQuery("");
    onOpenChange(false);
  }, [tools, selectedAgentIds, assignMutation, onOpenChange]);

  const toggleAgent = useCallback((agentId: string) => {
    setSelectedAgentIds((prev) =>
      prev.includes(agentId)
        ? prev.filter((id) => id !== agentId)
        : [...prev, agentId],
    );
  }, []);

  return (
    <Dialog
      open={open}
      onOpenChange={(newOpen) => {
        onOpenChange(newOpen);
        if (!newOpen) {
          setSelectedAgentIds([]);
          setSearchQuery("");
        }
      }}
    >
      <DialogContent className="max-w-2xl max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>Bulk Assign Tools to Agents</DialogTitle>
          <DialogDescription>
            Select one or more agents to assign {tools?.length || 0} tool
            {tools && tools.length !== 1 ? "s" : ""} to.
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-hidden flex flex-col">
          <div className="mb-4">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Search agents..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-9"
              />
            </div>
          </div>

          <div className="flex-1 overflow-y-auto border rounded-md">
            {filteredAgents.length === 0 ? (
              <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
                {searchQuery
                  ? "No agents match your search"
                  : "No agents available"}
              </div>
            ) : (
              <div className="divide-y">
                {filteredAgents.map((agent) => (
                  <div
                    key={agent.id}
                    className="flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-muted/50 w-full text-left"
                  >
                    <Checkbox
                      checked={selectedAgentIds.includes(agent.id)}
                      onCheckedChange={() => toggleAgent(agent.id)}
                    />
                    <span className="text-sm">{agent.name}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => {
              setSelectedAgentIds([]);
              setSearchQuery("");
              onOpenChange(false);
            }}
          >
            Cancel
          </Button>
          <Button
            onClick={handleAssign}
            disabled={selectedAgentIds.length === 0 || assignMutation.isPending}
          >
            {assignMutation.isPending
              ? "Assigning..."
              : `Assign to ${selectedAgentIds.length} agent${selectedAgentIds.length !== 1 ? "s" : ""}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
