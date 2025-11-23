import type { archestraApiTypes } from "@shared";
import { useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Editor } from "@/components/editor";
import { TruncatedText } from "@/components/truncated-text";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
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
import { Textarea } from "@/components/ui/textarea";
import { useAgents } from "@/lib/agent.query";
import {
  useAgentToolPatchMutation,
  useAllAgentTools,
  useAssignTool,
  useUnassignTool,
} from "@/lib/agent-tools.query";
import {
  useOperators,
  useToolInvocationPolicyCreateMutation,
  useToolInvocationPolicyDeleteMutation,
  useToolInvocationPolicyUpdateMutation,
  useToolResultPoliciesCreateMutation,
  useToolResultPoliciesDeleteMutation,
  useToolResultPoliciesUpdateMutation,
} from "@/lib/policy.query";
import {
  useCreateToolPolicy,
  useDeleteToolPolicy,
  useToolPolicies,
  useUpdateToolPolicy,
} from "@/lib/tool-policy.query";
import { cn, formatDate } from "@/lib/utils";

type ToolRow = archestraApiTypes.GetToolsResponses["200"]["data"][number];
type ToolResultTreatmentOption =
  archestraApiTypes.CreateToolPolicyData["body"]["toolResultTreatment"];

type TabId = "policies" | "assignments";

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
}: {
  tool: ToolRow | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [activeTab, setActiveTab] = useState<TabId>("policies");
  const [selectedAgent, setSelectedAgent] = useState("all");
  const [selectedPolicy, setSelectedPolicy] = useState("default");
  const queryClient = useQueryClient();
  const operatorsQuery = useOperators();
  const { data: agents } = useAgents();

  const { data: rawPolicies = [], isLoading: isLoadingPolicies } =
    useToolPolicies(tool?.id ?? null);
  const policies = (rawPolicies ?? []).filter((policy) =>
    tool ? policy.toolId === tool.id : true,
  );

  const createPolicy = useCreateToolPolicy();
  const updatePolicy = useUpdateToolPolicy(tool?.id ?? null);
  const deletePolicy = useDeleteToolPolicy(tool?.id ?? null);

  const createInvocationPolicy = useToolInvocationPolicyCreateMutation();
  const updateInvocationPolicy = useToolInvocationPolicyUpdateMutation();
  const deleteInvocationPolicy = useToolInvocationPolicyDeleteMutation();
  const createTrustedPolicy = useToolResultPoliciesCreateMutation();
  const updateTrustedPolicy = useToolResultPoliciesUpdateMutation();
  const deleteTrustedPolicy = useToolResultPoliciesDeleteMutation();

  const assignTool = useAssignTool();
  const unassignTool = useUnassignTool();
  const patchAgentTool = useAgentToolPatchMutation();

  const { data: assignmentsData, isLoading: isLoadingAssignments } =
    useAllAgentTools({
      pagination: { limit: 1000, offset: 0 },
      filters: { search: tool?.name },
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

  if (!tool) return null;

  const refreshPolicies = () => {
    if (tool?.id) {
      queryClient.invalidateQueries({ queryKey: ["tool-policies", tool.id] });
    }
  };

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

  const operators = operatorsQuery.data ?? [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] w-[95vw] max-w-[1200px] flex-col">
        <DialogHeader className="flex-shrink-0 space-y-2">
          <DialogTitle className="text-2xl font-semibold">
            {tool.name}
          </DialogTitle>
          {tool.description && (
            <TruncatedText
              message={tool.description}
              maxLength={500}
              className="text-sm text-muted-foreground"
            />
          )}
          <div className="grid gap-3 md:grid-cols-4">
            <div className="rounded-lg border p-3">
              <div className="text-xs text-muted-foreground">Origin</div>
              <div className="mt-1 text-sm font-medium">
                {tool.mcpServer ? "MCP Catalog" : "LLM Proxy"}
              </div>
              {tool.mcpServer?.name && (
                <div className="text-xs text-muted-foreground">
                  {tool.mcpServer.name}
                </div>
              )}
            </div>
            <div className="rounded-lg border p-3">
              <div className="text-xs text-muted-foreground">Profiles</div>
              <div className="mt-1 text-xl font-semibold">
                {tool.assignedAgentsCount}
              </div>
            </div>
            <div className="rounded-lg border p-3">
              <div className="text-xs text-muted-foreground">Policies</div>
              <div className="mt-1 text-xl font-semibold">
                {tool.policyCount}
              </div>
            </div>
            <div className="rounded-lg border p-3">
              <div className="text-xs text-muted-foreground">Updated</div>
              <div className="mt-1 text-sm text-muted-foreground">
                {formatDate({ date: tool.updatedAt })}
              </div>
            </div>
          </div>
        </DialogHeader>

        <div className="flex flex-1 flex-col gap-4 overflow-y-auto pr-2">
          <div className="flex gap-4 border-b pb-2 text-sm font-medium">
            {[
              { id: "policies", label: "Policies" },
              { id: "assignments", label: "Assignments" },
            ].map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveTab(tab.id as TabId)}
                className={cn(
                  "relative pb-2 transition-colors",
                  activeTab === tab.id
                    ? "text-foreground"
                    : "text-muted-foreground",
                )}
              >
                {tab.label}
                {activeTab === tab.id && (
                  <span className="absolute inset-x-0 bottom-0 h-0.5 bg-primary" />
                )}
              </button>
            ))}
          </div>

          {activeTab === "policies" && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-lg font-semibold">Tool Policies</h3>
                  <p className="text-sm text-muted-foreground">
                    Create reusable policies and apply them to multiple
                    profiles.
                  </p>
                </div>
                <Button onClick={handleCreatePolicy}>
                  <Plus className="mr-2 h-4 w-4" />
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
                  {policies.map((policy) => {
                    const invocationRules = policy.toolInvocationPolicies ?? [];
                    const trustedRules = policy.trustedDataPolicies ?? [];
                    return (
                      <div
                        key={policy.id}
                        className="rounded-lg border p-4 space-y-4"
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
                                Permit usage when context has untrusted data.
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
                              onValueChange={(
                                value: ToolResultTreatmentOption,
                              ) =>
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

                        <div className="grid gap-4 md:grid-cols-2">
                          <div className="space-y-3">
                            <div className="flex items-center justify-between">
                              <div className="text-sm font-medium">
                                Tool invocation policies
                              </div>
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() =>
                                  createInvocationPolicy.mutate(
                                    { toolPolicyId: policy.id },
                                    { onSuccess: refreshPolicies },
                                  )
                                }
                              >
                                <Plus className="mr-2 h-4 w-4" />
                                Add rule
                              </Button>
                            </div>
                            {invocationRules.length === 0 ? (
                              <p className="text-sm text-muted-foreground">
                                No invocation rules.
                              </p>
                            ) : (
                              <div className="space-y-3">
                                {invocationRules.map((rule) => (
                                  <div
                                    key={rule.id}
                                    className="rounded-md border p-3 space-y-2"
                                  >
                                    <div className="flex items-center justify-between gap-2">
                                      <Input
                                        defaultValue={rule.argumentName}
                                        placeholder="argument path"
                                        onBlur={(event) =>
                                          updateInvocationPolicy.mutate(
                                            {
                                              id: rule.id,
                                              argumentName:
                                                event.currentTarget.value,
                                            },
                                            { onSuccess: refreshPolicies },
                                          )
                                        }
                                      />
                                      <Button
                                        variant="ghost"
                                        size="icon"
                                        onClick={() =>
                                          deleteInvocationPolicy.mutate(
                                            rule.id,
                                            {
                                              onSuccess: refreshPolicies,
                                            },
                                          )
                                        }
                                      >
                                        <Trash2 className="h-4 w-4 text-muted-foreground" />
                                      </Button>
                                    </div>
                                    <div className="grid grid-cols-2 gap-2">
                                      <Select
                                        defaultValue={rule.operator as string}
                                        onValueChange={(value) =>
                                          updateInvocationPolicy.mutate(
                                            {
                                              id: rule.id,
                                              operator:
                                                value as archestraApiTypes.CreateToolInvocationPolicyData["body"]["operator"],
                                            },
                                            { onSuccess: refreshPolicies },
                                          )
                                        }
                                      >
                                        <SelectTrigger>
                                          <SelectValue placeholder="Operator" />
                                        </SelectTrigger>
                                        <SelectContent>
                                          {(operators ?? []).map((op) => (
                                            <SelectItem
                                              key={op.value}
                                              value={op.value}
                                            >
                                              {op.label}
                                            </SelectItem>
                                          ))}
                                        </SelectContent>
                                      </Select>
                                      <Select
                                        defaultValue={rule.action}
                                        onValueChange={(value) =>
                                          updateInvocationPolicy.mutate(
                                            {
                                              id: rule.id,
                                              action:
                                                value as archestraApiTypes.CreateToolInvocationPolicyData["body"]["action"],
                                            },
                                            { onSuccess: refreshPolicies },
                                          )
                                        }
                                      >
                                        <SelectTrigger>
                                          <SelectValue placeholder="Action" />
                                        </SelectTrigger>
                                        <SelectContent>
                                          <SelectItem value="allow_when_context_is_untrusted">
                                            Allow when context untrusted
                                          </SelectItem>
                                          <SelectItem value="block_always">
                                            Block always
                                          </SelectItem>
                                        </SelectContent>
                                      </Select>
                                    </div>
                                    <Input
                                      defaultValue={rule.value}
                                      placeholder="Value to match"
                                      onBlur={(event) =>
                                        updateInvocationPolicy.mutate(
                                          {
                                            id: rule.id,
                                            value: event.currentTarget.value,
                                          },
                                          { onSuccess: refreshPolicies },
                                        )
                                      }
                                    />
                                    <Textarea
                                      defaultValue={rule.reason ?? ""}
                                      placeholder="Optional reason"
                                      rows={2}
                                      onBlur={(event) =>
                                        updateInvocationPolicy.mutate(
                                          {
                                            id: rule.id,
                                            reason:
                                              event.currentTarget.value ||
                                              undefined,
                                          },
                                          { onSuccess: refreshPolicies },
                                        )
                                      }
                                    />
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>

                          <div className="space-y-3">
                            <div className="flex items-center justify-between">
                              <div className="text-sm font-medium">
                                Trusted data policies
                              </div>
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() =>
                                  createTrustedPolicy.mutate(
                                    { toolPolicyId: policy.id },
                                    { onSuccess: refreshPolicies },
                                  )
                                }
                              >
                                <Plus className="mr-2 h-4 w-4" />
                                Add policy
                              </Button>
                            </div>
                            {trustedRules.length === 0 ? (
                              <p className="text-sm text-muted-foreground">
                                No trusted data policies.
                              </p>
                            ) : (
                              <div className="space-y-3">
                                {trustedRules.map((rule) => (
                                  <div
                                    key={rule.id}
                                    className="rounded-md border p-3 space-y-2"
                                  >
                                    <div className="flex items-center justify-between gap-2">
                                      <Input
                                        defaultValue={rule.description ?? ""}
                                        placeholder="Description"
                                        onBlur={(event) =>
                                          updateTrustedPolicy.mutate(
                                            {
                                              id: rule.id,
                                              description:
                                                event.currentTarget.value,
                                            },
                                            { onSuccess: refreshPolicies },
                                          )
                                        }
                                      />
                                      <Button
                                        variant="ghost"
                                        size="icon"
                                        onClick={() =>
                                          deleteTrustedPolicy.mutate(rule.id, {
                                            onSuccess: refreshPolicies,
                                          })
                                        }
                                      >
                                        <Trash2 className="h-4 w-4 text-muted-foreground" />
                                      </Button>
                                    </div>
                                    <Input
                                      defaultValue={rule.attributePath}
                                      placeholder="Attribute path"
                                      onBlur={(event) =>
                                        updateTrustedPolicy.mutate(
                                          {
                                            id: rule.id,
                                            attributePath:
                                              event.currentTarget.value,
                                          },
                                          { onSuccess: refreshPolicies },
                                        )
                                      }
                                    />
                                    <div className="grid grid-cols-2 gap-2">
                                      <Select
                                        defaultValue={rule.operator as string}
                                        onValueChange={(value) =>
                                          updateTrustedPolicy.mutate(
                                            {
                                              id: rule.id,
                                              operator:
                                                value as archestraApiTypes.CreateTrustedDataPolicyData["body"]["operator"],
                                            },
                                            { onSuccess: refreshPolicies },
                                          )
                                        }
                                      >
                                        <SelectTrigger>
                                          <SelectValue placeholder="Operator" />
                                        </SelectTrigger>
                                        <SelectContent>
                                          {(operators ?? []).map((op) => (
                                            <SelectItem
                                              key={op.value}
                                              value={op.value}
                                            >
                                              {op.label}
                                            </SelectItem>
                                          ))}
                                        </SelectContent>
                                      </Select>
                                      <Select
                                        defaultValue={rule.action}
                                        onValueChange={(value) =>
                                          updateTrustedPolicy.mutate(
                                            {
                                              id: rule.id,
                                              action:
                                                value as archestraApiTypes.CreateTrustedDataPolicyData["body"]["action"],
                                            },
                                            { onSuccess: refreshPolicies },
                                          )
                                        }
                                      >
                                        <SelectTrigger>
                                          <SelectValue placeholder="Action" />
                                        </SelectTrigger>
                                        <SelectContent>
                                          <SelectItem value="mark_as_trusted">
                                            Mark as trusted
                                          </SelectItem>
                                          <SelectItem value="block_always">
                                            Block always
                                          </SelectItem>
                                          <SelectItem value="sanitize_with_dual_llm">
                                            Sanitize with dual LLM
                                          </SelectItem>
                                        </SelectContent>
                                      </Select>
                                    </div>
                                    <Input
                                      defaultValue={rule.value}
                                      placeholder="Value to match"
                                      onBlur={(event) =>
                                        updateTrustedPolicy.mutate(
                                          {
                                            id: rule.id,
                                            value: event.currentTarget.value,
                                          },
                                          { onSuccess: refreshPolicies },
                                        )
                                      }
                                    />
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        </div>

                        <div className="space-y-2">
                          <div className="text-sm font-medium">
                            Response modifier
                          </div>
                          <Editor
                            height="180px"
                            defaultLanguage="handlebars"
                            defaultValue={policy.responseModifierTemplate ?? ""}
                            onChange={(value) =>
                              handlePolicyUpdate(policy.id, {
                                responseModifierTemplate: value || null,
                              })
                            }
                            options={{
                              minimap: { enabled: false },
                              wordWrap: "on",
                            }}
                          />
                          <Accordion type="single" collapsible className="mt-6">
                            <AccordionItem
                              value="cheat-sheet"
                              className="border border-border rounded-lg bg-card"
                            >
                              <AccordionTrigger className="px-4 hover:no-underline">
                                <span className="text-sm font-medium">
                                  📖 MCP Response Templating Cheat Sheet
                                </span>
                              </AccordionTrigger>
                              <AccordionContent className="px-4 pb-4">
                                <div className="space-y-4 text-sm">
                                  <p className="text-muted-foreground">
                                    MCP tool responses follow the{" "}
                                    <Link
                                      href="https://modelcontextprotocol.io/specification/2025-06-18/server/tools#calling-tools"
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      className="underline hover:text-foreground"
                                    >
                                      MCP specification
                                    </Link>
                                    . Use{" "}
                                    <Link
                                      href="https://handlebarsjs.com/"
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      className="underline hover:text-foreground"
                                    >
                                      Handlebars
                                    </Link>{" "}
                                    templates to transform responses. Access the
                                    response with{" "}
                                    <code className="text-xs bg-muted px-1 py-0.5 rounded">
                                      {"{{response}}"}
                                    </code>
                                    .
                                  </p>

                                  <div className="space-y-6">
                                    <div className="space-y-2">
                                      <h4 className="font-medium">
                                        Example 1: Extract text from first
                                        element
                                      </h4>
                                      <p className="text-muted-foreground">
                                        MCP tools often return stringified JSON
                                        in a text block:
                                      </p>
                                      <pre className="bg-muted p-3 rounded-md overflow-x-auto text-xs">
                                        {`[
  {
    "type": "text",
    "text": "{\\"issues\\":[{\\"id\\":816,\\"title\\":\\"Add authentication\\"}]}"
  }
]`}
                                      </pre>
                                      <p className="text-muted-foreground mt-2">
                                        Template to extract text (use triple
                                        braces to prevent HTML escaping):
                                      </p>
                                      <pre className="bg-muted p-3 rounded-md overflow-x-auto text-xs">
                                        {
                                          '{{{lookup (lookup response 0) "text"}}}'
                                        }
                                      </pre>
                                    </div>

                                    <div className="space-y-2">
                                      <h4 className="font-medium">
                                        Example 2: Parse and transform JSON
                                      </h4>
                                      <p className="text-muted-foreground">
                                        Use nested{" "}
                                        <code className="bg-muted px-1 rounded">
                                          with
                                        </code>{" "}
                                        blocks with{" "}
                                        <code className="bg-muted px-1 rounded">
                                          json
                                        </code>{" "}
                                        and{" "}
                                        <code className="bg-muted px-1 rounded">
                                          escapeJson
                                        </code>{" "}
                                        helpers:
                                      </p>
                                      <pre className="bg-muted p-3 rounded-md overflow-x-auto text-xs">
                                        {`{{#with (lookup response 0)}}{{#with (json this.text)}}
{
  {{#each this.issues}}
    "{{this.id}}": "{{{escapeJson this.title}}}"{{#unless @last}},{{/unless}}
  {{/each}}
}
{{/with}}{{/with}}`}
                                      </pre>
                                      <p className="text-muted-foreground mt-2">
                                        Transforms GitHub issues to{" "}
                                        <code className="bg-muted px-1 rounded">
                                          {"{ id: title }"}
                                        </code>{" "}
                                        format
                                      </p>
                                    </div>

                                    <div className="space-y-2">
                                      <h4 className="font-medium">
                                        Example 3: Return full response as-is
                                      </h4>
                                      <p className="text-muted-foreground">
                                        Use the{" "}
                                        <code className="bg-muted px-1 rounded">
                                          json
                                        </code>{" "}
                                        helper to return the entire response
                                        array:
                                      </p>
                                      <pre className="bg-muted p-3 rounded-md overflow-x-auto text-xs">
                                        {"{{{json response}}}"}
                                      </pre>
                                    </div>

                                    <div className="space-y-2">
                                      <h4 className="font-medium">
                                        Available Helpers
                                      </h4>
                                      <ul className="list-disc list-inside text-muted-foreground space-y-1">
                                        <li>
                                          <code className="bg-muted px-1 rounded">
                                            {"{{lookup array index}}"}
                                          </code>{" "}
                                          - Access array element by index
                                        </li>
                                        <li>
                                          <code className="bg-muted px-1 rounded">
                                            {"{{#with expression}}"}
                                          </code>{" "}
                                          - Change context scope
                                        </li>
                                        <li>
                                          <code className="bg-muted px-1 rounded">
                                            {"{{json value}}"}
                                          </code>{" "}
                                          - Parse JSON string or stringify
                                          object
                                        </li>
                                        <li>
                                          <code className="bg-muted px-1 rounded">
                                            {"{{{escapeJson string}}}"}
                                          </code>{" "}
                                          - Escape quotes/special chars for JSON
                                        </li>
                                        <li>
                                          <code className="bg-muted px-1 rounded">
                                            {"{{#each array}}"}
                                          </code>{" "}
                                          - Iterate over arrays
                                        </li>
                                        <li>
                                          <code className="bg-muted px-1 rounded">
                                            {"{{{...}}}"}
                                          </code>{" "}
                                          - Triple braces prevent HTML escaping
                                          (required for JSON)
                                        </li>
                                      </ul>
                                    </div>
                                  </div>
                                </div>
                              </AccordionContent>
                            </AccordionItem>
                          </Accordion>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {activeTab === "assignments" && (
            <div className="space-y-6">
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
                <h3 className="mb-2 text-lg font-semibold">
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
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
