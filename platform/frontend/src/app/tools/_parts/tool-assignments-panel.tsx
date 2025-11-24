"use client";

import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAgents } from "@/lib/agent.query";
import {
  useAgentToolPatchMutation,
  useAllAgentTools,
  useAssignTool,
  useUnassignTool,
} from "@/lib/agent-tools.query";
import { useToolPolicies } from "@/lib/tool-policy.query";
import { cn } from "@/lib/utils";
import type { Tool } from "./types";

export function ToolAssignmentsPanel({ tool }: { tool: Tool }) {
  const [selectedAgent, setSelectedAgent] = useState("all");
  const [selectedPolicy, setSelectedPolicy] = useState("default");

  const { data: agents } = useAgents();
  const assignTool = useAssignTool();
  const unassignTool = useUnassignTool();
  const patchAgentTool = useAgentToolPatchMutation();

  const { data: policies = [] } = useToolPolicies(tool?.id ?? null);

  const { data: assignmentsData, isLoading: isLoadingAssignments } =
    useAllAgentTools({
      pagination: { limit: 100, offset: 0 },
      filters: { toolId: tool?.id },
      enabled: Boolean(tool),
    });

  const assignments = useMemo(() => {
    if (!tool) return [];
    return assignmentsData?.data ?? [];
  }, [assignmentsData, tool]);

  const handleAssign = useCallback(() => {
    if (selectedAgent === "all") {
      toast.error("Select a profile to assign");
      return;
    }
    assignTool.mutate(
      {
        agentId: selectedAgent,
        toolId: tool.id,
        toolPolicyId: selectedPolicy === "default" ? null : selectedPolicy,
      },
      {
        onSuccess: () => {
          toast.success("Tool assigned");
          setSelectedAgent("all");
          setSelectedPolicy("default");
        },
        onError: () => toast.error("Failed to assign tool"),
      },
    );
  }, [assignTool, selectedAgent, selectedPolicy, tool.id]);

  const handlePolicyChangeForAssignment = useCallback(
    (assignmentId: string, newPolicyId: string) => {
      patchAgentTool.mutate({
        id: assignmentId,
        toolPolicyId: newPolicyId === "default" ? null : newPolicyId,
      });
    },
    [patchAgentTool],
  );

  const handleUnassign = useCallback(
    (agentId: string) => {
      unassignTool.mutate(
        {
          agentId,
          toolId: tool.id,
        },
        {
          onSuccess: () => toast.success("Tool removed from profile"),
          onError: () => toast.error("Failed to unassign tool"),
        },
      );
    },
    [unassignTool, tool.id],
  );
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold">Assignments</h3>
          <p className="text-sm text-muted-foreground">
            Assign this tool to profiles and choose a policy.
          </p>
        </div>
      </div>

      <div className="flex flex-col gap-3 rounded-lg border p-4 sm:flex-row sm:items-center">
        <div className="flex-1 space-y-1">
          <div className="text-sm font-medium">Assign to profile</div>
          <Select
            value={selectedAgent}
            onValueChange={(value) => setSelectedAgent(value)}
          >
            <SelectTrigger>
              <SelectValue placeholder="Select profile" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Select profile</SelectItem>
              {(agents ?? []).map((agent) => (
                <SelectItem key={agent.id} value={agent.id}>
                  {agent.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex-1 space-y-1">
          <div className="text-sm font-medium">Policy</div>
          <Select
            value={selectedPolicy}
            onValueChange={(value) => setSelectedPolicy(value)}
          >
            <SelectTrigger>
              <SelectValue placeholder="Default policy" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="default">Default</SelectItem>
              {(policies ?? []).map((policy) => (
                <SelectItem key={policy.id} value={policy.id}>
                  {policy.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Button onClick={handleAssign} className="self-start sm:self-end">
          Assign
        </Button>
      </div>

      <div className="space-y-2">
        <div className="text-sm font-semibold">Currently assigned</div>
        {isLoadingAssignments ? (
          <p className="text-sm text-muted-foreground">Loading assignments…</p>
        ) : assignments.length === 0 ? (
          <div className="rounded border border-dashed p-4 text-sm text-muted-foreground">
            No profiles assigned yet.
          </div>
        ) : (
          <div className="divide-y rounded-lg border">
            {assignments.map((assignment) => (
              <div
                key={assignment.id}
                className="grid gap-3 px-4 py-3 sm:grid-cols-[1fr,1fr,auto] sm:items-center"
              >
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-sm font-medium">
                      {assignment.agent.name}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {assignment.tool.name}
                    </div>
                  </div>
                  <div className="flex justify-end">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleUnassign(assignment.agent.id)}
                    >
                      Unassign
                    </Button>
                  </div>
                </div>

                <div className="space-y-1">
                  <div className="text-xs text-muted-foreground">Policy</div>
                  <Select
                    value={assignment.toolPolicy?.id ?? "default"}
                    onValueChange={(value) =>
                      handlePolicyChangeForAssignment(assignment.id, value)
                    }
                  >
                    <SelectTrigger className={cn("w-full")}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="default">Default</SelectItem>
                      {(policies ?? []).map((policy) => (
                        <SelectItem key={policy.id} value={policy.id}>
                          {policy.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
