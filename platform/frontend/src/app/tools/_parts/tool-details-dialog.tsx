import type { archestraApiTypes } from "@shared";
import { Plus, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { useAgents } from "@/lib/agent.query";
import {
  useAgentToolPatchMutation,
  useAllAgentTools,
  useAssignTool,
  useUnassignTool,
} from "@/lib/agent-tools.query";
import {
  useCreateToolPolicy,
  useDeleteToolPolicy,
  useToolPolicies,
  useUpdateToolPolicy,
} from "@/lib/tool-policy.query";
import { formatDate } from "@/lib/utils";

type ToolRow = archestraApiTypes.GetToolsResponses["200"]["data"][number];
type ToolResultTreatmentOption =
  archestraApiTypes.CreateToolPolicyData["body"]["toolResultTreatment"];

interface ToolDetailsDialogProps {
  tool: ToolRow | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const TOOL_RESULT_OPTIONS: Array<{
  label: string;
  value: ToolResultTreatmentOption;
}> = [
  { label: "Trusted", value: "trusted" },
  { label: "Sanitize with Dual LLM", value: "sanitize_with_dual_llm" },
  { label: "Untrusted", value: "untrusted" },
];

export function ToolDetailsDialog({
  tool,
  open,
  onOpenChange,
}: ToolDetailsDialogProps) {
  const [activeTab, setActiveTab] = useState("overview");
  const { data: policies = [], isLoading: isLoadingPolicies } = useToolPolicies(
    tool?.id ?? null,
  );
  const createPolicy = useCreateToolPolicy();
  const updatePolicy = useUpdateToolPolicy(tool?.id ?? null);
  const deletePolicy = useDeleteToolPolicy(tool?.id ?? null);
  const assignTool = useAssignTool();
  const unassignTool = useUnassignTool();
  const patchAgentTool = useAgentToolPatchMutation();
  const { data: agents } = useAgents();

  const { data: assignmentsData, isLoading: isLoadingAssignments } =
    useAllAgentTools({
      pagination: { limit: 1000, offset: 0 },
      filters: {
        search: tool?.name,
      },
      enabled: Boolean(tool),
    });

  const assignments = useMemo(() => {
    if (!tool) return [];
    return (
      assignmentsData?.data.filter(
        (assignment) => assignment.tool.id === tool.id,
      ) ?? []
    );
  }, [assignmentsData, tool]);

  const [selectedAgent, setSelectedAgent] = useState("all");
  const [selectedPolicy, setSelectedPolicy] = useState("default");

  if (!tool) return null;

  const handleCreatePolicy = () => {
    createPolicy.mutate(
      {
        toolId: tool.id,
        name: `Policy ${policies.length + 1}`,
        allowUsageWhenUntrustedDataIsPresent: false,
        toolResultTreatment: "untrusted",
        responseModifierTemplate: null,
      },
      {
        onSuccess: () => toast.success("Policy created"),
        onError: () => toast.error("Failed to create policy"),
      },
    );
  };

  const handlePolicyUpdate = (
    policyId: string,
    data: archestraApiTypes.UpdateToolPolicyData["body"],
  ) => {
    updatePolicy.mutate(
      {
        policyId,
        ...data,
      },
      {
        onError: () => toast.error("Failed to update policy"),
      },
    );
  };

  const handlePolicyDelete = (policyId: string) => {
    deletePolicy.mutate(policyId, {
      onSuccess: () => toast.success("Policy deleted"),
      onError: () => toast.error("Failed to delete policy"),
    });
  };

  const handleAssign = () => {
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
  };

  const handlePolicyChangeForAssignment = (
    assignmentId: string,
    newPolicyId: string,
  ) => {
    patchAgentTool.mutate({
      id: assignmentId,
      toolPolicyId: newPolicyId === "default" ? null : newPolicyId,
    });
  };

  const handleUnassign = (agentId: string) => {
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
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[95vw] max-w-[1200px] max-h-[85vh] flex flex-col">
        <DialogHeader className="flex-shrink-0">
          <DialogTitle>{tool.name}</DialogTitle>
          {tool.description && (
            <p className="text-sm text-muted-foreground mt-2">
              {tool.description}
            </p>
          )}
        </DialogHeader>

        <Tabs
          value={activeTab}
          onValueChange={setActiveTab}
          className="flex flex-1 flex-col overflow-hidden"
        >
          <TabsList className="w-full justify-start">
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="policies">Policies</TabsTrigger>
            <TabsTrigger value="assignments">Assignments</TabsTrigger>
          </TabsList>

          <div className="flex-1 overflow-y-auto pr-2 pt-4">
            <TabsContent value="overview" className="space-y-4">
              <div className="grid gap-4 md:grid-cols-2">
                <div className="rounded-lg border p-4">
                  <div className="text-sm text-muted-foreground">Origin</div>
                  <div className="mt-1 text-base font-medium">
                    {tool.mcpServer ? "MCP Catalog" : "LLM Proxy"}
                  </div>
                  {tool.mcpServer?.name && (
                    <div className="text-sm text-muted-foreground">
                      {tool.mcpServer.name}
                    </div>
                  )}
                </div>
                <div className="rounded-lg border p-4">
                  <div className="text-sm text-muted-foreground">
                    Assigned Profiles
                  </div>
                  <div className="mt-1 text-2xl font-semibold">
                    {tool.assignedAgentsCount}
                  </div>
                </div>
                <div className="rounded-lg border p-4">
                  <div className="text-sm text-muted-foreground">
                    Policy Count
                  </div>
                  <div className="mt-1 text-2xl font-semibold">
                    {tool.policyCount}
                  </div>
                </div>
                <div className="rounded-lg border p-4">
                  <div className="text-sm text-muted-foreground">
                    Last Updated
                  </div>
                  <div className="mt-1 text-base font-medium">
                    {formatDate({ date: tool.updatedAt })}
                  </div>
                </div>
              </div>
            </TabsContent>

            <TabsContent value="policies" className="space-y-4">
              <div className="flex justify-between items-center">
                <div>
                  <h3 className="text-lg font-semibold">Tool Policies</h3>
                  <p className="text-sm text-muted-foreground">
                    Create reusable policies and apply them to multiple
                    profiles.
                  </p>
                </div>
                <Button onClick={handleCreatePolicy}>
                  <Plus className="h-4 w-4 mr-2" />
                  New Policy
                </Button>
              </div>

              {isLoadingPolicies ? (
                <p className="text-sm text-muted-foreground">
                  Loading policies…
                </p>
              ) : policies.length === 0 ? (
                <div className="rounded border border-dashed p-6 text-center text-muted-foreground">
                  No policies yet. Create one to customize how this tool
                  behaves.
                </div>
              ) : (
                <div className="space-y-4">
                  {policies.map((policy) => (
                    <div
                      key={policy.id}
                      className="rounded-lg border p-4 space-y-3"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <Input
                          defaultValue={policy.name}
                          onBlur={(event) =>
                            handlePolicyUpdate(policy.id, {
                              name: event.currentTarget.value,
                            })
                          }
                        />
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => handlePolicyDelete(policy.id)}
                        >
                          <Trash2 className="h-4 w-4 text-muted-foreground" />
                        </Button>
                      </div>
                      <div className="grid gap-4 md:grid-cols-3">
                        <div className="flex items-center justify-between rounded-md border p-3">
                          <div>
                            <div className="text-sm font-medium">
                              Allow untrusted data
                            </div>
                            <p className="text-xs text-muted-foreground">
                              Permit usage even when context contains untrusted
                              data.
                            </p>
                          </div>
                          <Switch
                            checked={
                              policy.allowUsageWhenUntrustedDataIsPresent
                            }
                            onCheckedChange={(checked) =>
                              handlePolicyUpdate(policy.id, {
                                allowUsageWhenUntrustedDataIsPresent: checked,
                              })
                            }
                          />
                        </div>
                        <div className="rounded-md border p-3">
                          <div className="text-sm font-medium">
                            Result treatment
                          </div>
                          <Select
                            defaultValue={policy.toolResultTreatment}
                            onValueChange={(value: ToolResultTreatmentOption) =>
                              handlePolicyUpdate(policy.id, {
                                toolResultTreatment: value,
                              })
                            }
                          >
                            <SelectTrigger className="mt-2">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {TOOL_RESULT_OPTIONS.map((option) => (
                                <SelectItem
                                  key={option.value}
                                  value={option.value}
                                >
                                  {option.label}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                        <div className="rounded-md border p-3">
                          <div className="text-sm font-medium">
                            Last updated
                          </div>
                          <div className="mt-1 text-sm text-muted-foreground">
                            {formatDate({ date: policy.updatedAt })}
                          </div>
                        </div>
                      </div>
                      <div>
                        <div className="flex items-center justify-between">
                          <div className="text-sm font-medium">
                            Response modifier template
                          </div>
                        </div>
                        <Textarea
                          className="mt-2"
                          defaultValue={policy.responseModifierTemplate ?? ""}
                          placeholder="Optional Handlebars template"
                          rows={4}
                          onBlur={(event) =>
                            handlePolicyUpdate(policy.id, {
                              responseModifierTemplate:
                                event.currentTarget.value || null,
                            })
                          }
                        />
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </TabsContent>

            <TabsContent value="assignments" className="space-y-6">
              <div className="rounded-lg border p-4 space-y-4">
                <div>
                  <h3 className="text-lg font-semibold">Assign to Profile</h3>
                  <p className="text-sm text-muted-foreground">
                    Choose a profile and optional policy to link this tool.
                  </p>
                </div>
                <div className="grid gap-4 md:grid-cols-3">
                  <Select
                    value={selectedAgent}
                    onValueChange={setSelectedAgent}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Select profile" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">Select profile</SelectItem>
                      {agents?.map((agent) => (
                        <SelectItem key={agent.id} value={agent.id}>
                          {agent.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Select
                    value={selectedPolicy}
                    onValueChange={setSelectedPolicy}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Policy (optional)" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="default">Default rules</SelectItem>
                      {policies.map((policy) => (
                        <SelectItem key={policy.id} value={policy.id}>
                          {policy.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button onClick={handleAssign}>Assign Tool</Button>
                </div>
              </div>

              <div>
                <h3 className="text-lg font-semibold mb-2">
                  Assigned Profiles
                </h3>
                {isLoadingAssignments ? (
                  <p className="text-sm text-muted-foreground">
                    Loading assignments…
                  </p>
                ) : assignments.length === 0 ? (
                  <div className="rounded border border-dashed p-6 text-center text-muted-foreground">
                    This tool is not assigned to any profiles yet.
                  </div>
                ) : (
                  <div className="space-y-3">
                    {assignments.map((assignment) => (
                      <div
                        key={assignment.id}
                        className="flex flex-col gap-3 rounded-lg border p-4 md:flex-row md:items-center md:justify-between"
                      >
                        <div>
                          <div className="font-medium">
                            {assignment.agent.name}
                          </div>
                          <div className="text-sm text-muted-foreground">
                            Assigned{" "}
                            {formatDate({ date: assignment.createdAt })}
                          </div>
                        </div>
                        <div className="flex flex-col gap-2 md:flex-row md:items-center md:gap-4">
                          <Select
                            value={assignment.toolPolicy?.id ?? "default"}
                            onValueChange={(value) =>
                              handlePolicyChangeForAssignment(
                                assignment.id,
                                value,
                              )
                            }
                          >
                            <SelectTrigger className="w-[220px]">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="default">
                                Default security rules
                              </SelectItem>
                              {policies.map((policy) => (
                                <SelectItem key={policy.id} value={policy.id}>
                                  {policy.name}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          <Button
                            variant="ghost"
                            onClick={() => handleUnassign(assignment.agent.id)}
                          >
                            Remove
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </TabsContent>
          </div>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
