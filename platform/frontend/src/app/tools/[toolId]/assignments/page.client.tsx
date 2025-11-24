"use client";

import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";
import type { Tool } from "@/app/tools/types";
import { TokenSelect } from "@/components/token-select";
import { Button } from "@/components/ui/button";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { useAgents } from "@/lib/agent.query";
import { useInternalMcpCatalog } from "@/lib/internal-mcp-catalog.query";
import {
  useAgentToolPatchMutation,
  useAllAgentTools,
  useAssignTool,
  useUnassignTool,
} from "@/lib/tool.query";
import { useToolPolicies } from "@/lib/tool-policy.query";
import { ToolDetailShell } from "../_parts/tool-detail-shell";

function ToolAssignments({ tool }: { tool: Tool }) {
  const [selectedAgent, setSelectedAgent] = useState("all");
  const [selectedPolicy, setSelectedPolicy] = useState("default");
  const [credentialSourceMcpServerId, setCredentialSourceMcpServerId] =
    useState<string | null>(null);

  const { data: agents } = useAgents();
  const assignTool = useAssignTool();
  const unassignTool = useUnassignTool();
  const patchAgentTool = useAgentToolPatchMutation();
  const { data: internalCatalog = [] } = useInternalMcpCatalog();

  const { data: policies = [] } = useToolPolicies(tool?.id ?? null);
  const filteredPolicies = useMemo(() => {
    return policies.filter((policy) => policy.toolId === tool?.id);
  }, [policies, tool?.id]);

  const { data: assignmentsData, isLoading: isLoadingAssignments } =
    useAllAgentTools({
      pagination: { limit: 100, offset: 0 },
      filters: { toolId: tool?.id },
      enabled: Boolean(tool),
    });

  const assignments = useMemo(() => {
    if (!tool) return [];
    const allAssignments = assignmentsData?.data ?? [];
    return allAssignments.filter(
      (assignment) => assignment.tool.id === tool.id,
    );
  }, [assignmentsData, tool]);

  const policySelectItems = useMemo(() => {
    return [
      { value: "default", label: "Default" },
      ...filteredPolicies.map((policy) => ({
        value: policy.id,
        label: policy.name,
      })),
    ];
  }, [filteredPolicies]);

  const handleAssign = useCallback(() => {
    if (selectedAgent === "all") {
      toast.error("Select a profile to assign");
      return;
    }

    const catalogItem = internalCatalog.find(
      (item) => item.id === tool.catalogId,
    );

    const needsCredentialSource = catalogItem?.serverType === "remote";
    const needsExecutionSource = catalogItem?.serverType === "local";

    const credentialSourceMcpServerId = needsCredentialSource
      ? (tool.mcpServer?.id ?? null)
      : undefined;
    const executionSourceMcpServerId = needsExecutionSource
      ? (tool.mcpServer?.id ?? null)
      : undefined;

    if (needsCredentialSource && !credentialSourceMcpServerId) {
      toast.error("This remote tool needs credentials from its MCP server");
      return;
    }

    if (needsExecutionSource && !executionSourceMcpServerId) {
      toast.error("Install the MCP server before assigning this tool");
      return;
    }

    assignTool.mutate(
      {
        agentId: selectedAgent,
        toolId: tool.id,
        credentialSourceMcpServerId,
        executionSourceMcpServerId,
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
  }, [assignTool, selectedAgent, selectedPolicy, tool, internalCatalog]);

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
          <SearchableSelect
            value={selectedAgent}
            onValueChange={(value) => setSelectedAgent(value)}
            items={[
              { value: "all", label: "All" },
              ...agents.map((agent) => ({
                value: agent.id,
                label: agent.name,
              })),
            ]}
          />
        </div>
        {tool.catalogId && (
          <div className="flex-1 space-y-1">
            <TokenSelect
              value={credentialSourceMcpServerId}
              onValueChange={(value) => setCredentialSourceMcpServerId(value)}
              catalogId={tool.catalogId}
              shouldSetDefaultValue={true}
            />
          </div>
        )}
        <div className="flex-1 space-y-1">
          <div className="text-sm font-medium">Policy</div>
          <SearchableSelect
            value={selectedPolicy}
            onValueChange={(value) => setSelectedPolicy(value)}
            items={policySelectItems}
          />
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
                  <SearchableSelect
                    value={assignment.toolPolicy?.id ?? "default"}
                    onValueChange={(value) =>
                      handlePolicyChangeForAssignment(assignment.id, value)
                    }
                    items={policySelectItems}
                  />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default function ToolAssignmentsClient({ toolId }: { toolId: string }) {
  return (
    <ToolDetailShell toolId={toolId}>
      {(tool: Tool) => <ToolAssignments tool={tool} />}
    </ToolDetailShell>
  );
}
