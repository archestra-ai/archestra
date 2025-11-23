import type { archestraApiTypes } from "@shared";
import { useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import Link from "next/link";
import { useMemo } from "react";
import { toast } from "sonner";
import { Editor } from "@/components/editor";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Button } from "@/components/ui/button";
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
import { formatDate } from "@/lib/utils";
import type { ToolRow } from "./tool-types";

type ToolResultTreatmentOption =
  archestraApiTypes.CreateToolPolicyData["body"]["toolResultTreatment"];

const TOOL_RESULT_OPTIONS: Array<{
  label: string;
  value: ToolResultTreatmentOption;
}> = [
  { label: "Trusted", value: "trusted" },
  { label: "Sanitize with Dual LLM", value: "sanitize_with_dual_llm" },
  { label: "Untrusted", value: "untrusted" },
];

export function ToolPoliciesPanel({ tool }: { tool: ToolRow }) {
  const queryClient = useQueryClient();
  const operatorsQuery = useOperators();

  const { data: rawPolicies = [], isLoading: isLoadingPolicies } =
    useToolPolicies(tool?.id ?? null);
  const policies = useMemo(
    () => (rawPolicies ?? []).filter((policy) => policy.toolId === tool.id),
    [rawPolicies, tool.id],
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

  const operators = operatorsQuery.data ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold">Tool Policies</h3>
          <p className="text-sm text-muted-foreground">
            Create reusable policies and apply them to multiple profiles.
          </p>
        </div>
        <Button onClick={handleCreatePolicy}>
          <Plus className="mr-2 h-4 w-4" />
          New Policy
        </Button>
      </div>

      {isLoadingPolicies ? (
        <p className="text-sm text-muted-foreground">Loading policies…</p>
      ) : policies.length === 0 ? (
        <div className="rounded border border-dashed p-6 text-center text-muted-foreground">
          No policies yet. Create one to customize how this tool behaves.
        </div>
      ) : (
        <div className="space-y-4">
          {policies.map((policy) => {
            const invocationRules = policy.toolInvocationPolicies ?? [];
            const trustedRules = policy.trustedDataPolicies ?? [];
            return (
              <div key={policy.id} className="rounded-lg border p-4 space-y-4">
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
                      checked={policy.allowUsageWhenUntrustedDataIsPresent}
                      onCheckedChange={(checked) =>
                        handlePolicyUpdate(policy.id, {
                          allowUsageWhenUntrustedDataIsPresent: checked,
                        })
                      }
                    />
                  </div>
                  <div className="rounded-md border p-3">
                    <div className="text-sm font-medium">Result treatment</div>
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
                          <SelectItem key={option.value} value={option.value}>
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="rounded-md border p-3">
                    <div className="text-sm font-medium">Last updated</div>
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
                                      argumentName: event.currentTarget.value,
                                    },
                                    { onSuccess: refreshPolicies },
                                  )
                                }
                              />
                              <Button
                                variant="ghost"
                                size="icon"
                                onClick={() =>
                                  deleteInvocationPolicy.mutate(rule.id, {
                                    onSuccess: refreshPolicies,
                                  })
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
                                    <SelectItem key={op.value} value={op.value}>
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
                              placeholder="Reason (optional)"
                              onBlur={(event) =>
                                updateInvocationPolicy.mutate(
                                  {
                                    id: rule.id,
                                    reason: event.currentTarget.value,
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
                        Tool result policies
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
                        Add result rule
                      </Button>
                    </div>
                    {trustedRules.length === 0 ? (
                      <p className="text-sm text-muted-foreground">
                        No result policies.
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
                                defaultValue={rule.attributePath}
                                placeholder="attribute path"
                                onBlur={(event) =>
                                  updateTrustedPolicy.mutate(
                                    {
                                      id: rule.id,
                                      attributePath: event.currentTarget.value,
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
                            <div className="grid grid-cols-2 gap-2">
                              <Select
                                defaultValue={rule.operator}
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
                                  <SelectItem value="contains">
                                    contains
                                  </SelectItem>
                                  <SelectItem value="notContains">
                                    notContains
                                  </SelectItem>
                                  <SelectItem value="equal">equal</SelectItem>
                                  <SelectItem value="notEqual">
                                    notEqual
                                  </SelectItem>
                                  <SelectItem value="startsWith">
                                    startsWith
                                  </SelectItem>
                                  <SelectItem value="endsWith">
                                    endsWith
                                  </SelectItem>
                                  <SelectItem value="matches">
                                    matches
                                  </SelectItem>
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
                                  <SelectItem value="mark_as_untrusted">
                                    Mark as untrusted
                                  </SelectItem>
                                  <SelectItem value="block_always">
                                    Block always
                                  </SelectItem>
                                </SelectContent>
                              </Select>
                            </div>
                            <Input
                              defaultValue={rule.value ?? ""}
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
                            <Textarea
                              defaultValue={rule.description ?? ""}
                              placeholder="Description (optional)"
                              onBlur={(event) =>
                                updateTrustedPolicy.mutate(
                                  {
                                    id: rule.id,
                                    description: event.currentTarget.value,
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
                  <div className="flex items-center justify-between">
                    <h4 className="text-sm font-semibold">
                      Response modifier template
                    </h4>
                    <Link
                      href="https://handlebarsjs.com/guide/"
                      target="_blank"
                      rel="noreferrer"
                      className="text-xs text-primary underline"
                    >
                      Handlebars docs
                    </Link>
                  </div>
                  <Editor
                    language="handlebars"
                    height="200px"
                    value={policy.responseModifierTemplate ?? ""}
                    onChange={(value) =>
                      handlePolicyUpdate(policy.id, {
                        responseModifierTemplate: value ?? null,
                      })
                    }
                    options={{
                      minimap: { enabled: false },
                      fontSize: 13,
                      lineNumbers: "on",
                      scrollBeyondLastLine: false,
                      wordWrap: "on",
                      automaticLayout: true,
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
                                Example 1: Extract text from first element
                              </h4>
                              <p className="text-muted-foreground">
                                MCP tools often return stringified JSON in a
                                text block:
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
                                Template to extract text (use triple braces to
                                prevent HTML escaping):
                              </p>
                              <pre className="bg-muted p-3 rounded-md overflow-x-auto text-xs">
                                {'{{{lookup (lookup response 0) "text"}}}'}
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
                                helper to return the entire response array:
                              </p>
                              <pre className="bg-muted p-3 rounded-md overflow-x-auto text-xs">
                                {"{{{json response}}}"}
                              </pre>
                            </div>

                            <div className="space-y-2">
                              <h4 className="font-medium">Available Helpers</h4>
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
                                  - Parse JSON string or stringify object
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
  );
}
