"use client";

import type { archestraApiTypes } from "@shared";
import { Plus, Trash2 } from "lucide-react";
import { useCallback, useMemo } from "react";
import { toast } from "sonner";
import type { Tool, ToolPolicyResultTreatmentOption } from "@/app/tools/types";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  useCreateToolPolicy,
  useDeleteToolPolicy,
  useToolInvocationPolicyCreateMutation,
  useToolPolicies,
  useToolResultPoliciesCreateMutation,
  useUpdateToolPolicy,
} from "@/lib/tool-policy.query";
import { formatDate } from "@/lib/utils";
import { ToolDetailShell } from "../_parts/tool-detail-shell";
import { ResponseModifierEditor } from "./_parts/response-modifier-editor";
import { ToolInvocationPolicies } from "./_parts/tool-invocation-policies";
import { ToolResultPolicies } from "./_parts/tool-result-policies";

const TOOL_RESULT_OPTIONS: Record<
  ToolPolicyResultTreatmentOption,
  { label: string; value: ToolPolicyResultTreatmentOption }
> = {
  trusted: { label: "Trusted", value: "trusted" },
  sanitize_with_dual_llm: {
    label: "Sanitize with Dual LLM",
    value: "sanitize_with_dual_llm",
  },
  untrusted: { label: "Untrusted", value: "untrusted" },
};

function ToolPolicies({ tool }: { tool: Tool }) {
  const { data: rawPolicies = [], isLoading: isLoadingPolicies } =
    useToolPolicies(tool?.id ?? null);
  const policies = useMemo(
    () => (rawPolicies ?? []).filter((policy) => policy.toolId === tool.id),
    [rawPolicies, tool.id],
  );

  const createPolicy = useCreateToolPolicy();
  const updatePolicy = useUpdateToolPolicy(tool?.id ?? null);
  const deletePolicy = useDeleteToolPolicy(tool?.id ?? null);

  const createTrustedPolicy = useToolResultPoliciesCreateMutation();
  const createInvocationPolicy = useToolInvocationPolicyCreateMutation();

  const handleCreatePolicy = useCallback(() => {
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
  }, [createPolicy, tool.id, policies.length]);

  const handlePolicyUpdate = useCallback(
    (
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
    },
    [updatePolicy],
  );

  const handlePolicyDelete = useCallback(
    (policyId: string) => {
      deletePolicy.mutate(policyId, {
        onSuccess: () => toast.success("Policy deleted"),
        onError: () => toast.error("Failed to delete policy"),
      });
    },
    [deletePolicy],
  );

  const handleCreateTrustedPolicy = useCallback(
    (policyId: string) => {
      createTrustedPolicy.mutate({ toolPolicyId: policyId });
    },
    [createTrustedPolicy],
  );

  const handleCreateInvocationPolicy = useCallback(
    (policyId: string) => {
      createInvocationPolicy.mutate({ toolPolicyId: policyId });
    },
    [createInvocationPolicy],
  );

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <CardTitle>Tool Policies</CardTitle>
            <CardDescription>
              Create reusable policies and apply them to multiple profiles.
            </CardDescription>
          </div>
          <Button
            onClick={handleCreatePolicy}
            className="sm:ml-auto w-full sm:w-auto"
          >
            <Plus className="mr-2 h-4 w-4" />
            New Policy
          </Button>
        </CardHeader>
        <CardContent>
          {isLoadingPolicies ? (
            <p className="text-sm text-muted-foreground">Loading policies…</p>
          ) : policies.length === 0 ? (
            <div className="rounded border border-dashed p-6 text-center text-muted-foreground">
              No policies yet.
            </div>
          ) : (
            <div className="space-y-6">
              {policies.map((policy) => {
                const invocationRules = policy.toolInvocationPolicies ?? [];
                const trustedRules = policy.trustedDataPolicies ?? [];

                return (
                  <Card key={policy.id} className="border-muted">
                    <CardHeader className="space-y-4">
                      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                        <div>
                          <CardTitle className="text-base font-semibold">
                            {policy.name}
                          </CardTitle>
                          <CardDescription>
                            Updated {formatDate({ date: policy.updatedAt })}
                          </CardDescription>
                        </div>
                        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                          <Input
                            defaultValue={policy.name}
                            onBlur={(event) =>
                              handlePolicyUpdate(policy.id, {
                                name: event.currentTarget.value,
                              })
                            }
                            className="sm:w-64"
                          />
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => handlePolicyDelete(policy.id)}
                          >
                            <Trash2 className="h-4 w-4 text-muted-foreground" />
                          </Button>
                        </div>
                      </div>
                    </CardHeader>
                    <CardContent className="space-y-6">
                      <div className="grid gap-4 md:grid-cols-3">
                        <Card className="border-muted bg-muted/30">
                          <CardContent className="flex items-center justify-between p-4">
                            <div>
                              <p className="text-sm font-medium">
                                Allow untrusted data
                              </p>
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
                          </CardContent>
                        </Card>
                        <Card className="border-muted">
                          <CardContent className="p-4">
                            <p className="text-sm font-medium">
                              Result treatment
                            </p>
                            <Select
                              defaultValue={policy.toolResultTreatment}
                              onValueChange={(
                                value: ToolPolicyResultTreatmentOption,
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
                                {Object.values(TOOL_RESULT_OPTIONS).map(
                                  (option) => (
                                    <SelectItem
                                      key={option.value}
                                      value={option.value}
                                    >
                                      {option.label}
                                    </SelectItem>
                                  ),
                                )}
                              </SelectContent>
                            </Select>
                          </CardContent>
                        </Card>
                        <Card className="border-muted bg-muted/30">
                          <CardContent className="p-4">
                            <p className="text-sm font-medium">Last updated</p>
                            <p className="mt-1 text-sm text-muted-foreground">
                              {formatDate({ date: policy.updatedAt })}
                            </p>
                          </CardContent>
                        </Card>
                      </div>

                      <Card className="border-muted">
                        <CardHeader className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
                          <div>
                            <CardTitle className="text-base">
                              Tool invocation policies
                            </CardTitle>
                            <CardDescription>
                              TODO: Add description.{" "}
                              <a
                                href="https://archestra.ai/docs/platform-dynamic-tools"
                                target="_blank"
                                rel="noopener noreferrer"
                                className="underline hover:text-foreground"
                              >
                                Read more about Dynamic Tools.
                              </a>
                            </CardDescription>
                          </div>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() =>
                              handleCreateInvocationPolicy(policy.id)
                            }
                          >
                            <Plus className="mr-2 h-4 w-4" />
                            Add rule
                          </Button>
                        </CardHeader>
                        <CardContent>
                          <ToolInvocationPolicies rules={invocationRules} />
                        </CardContent>
                      </Card>

                      <Card className="border-muted">
                        <CardHeader className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
                          <div>
                            <CardTitle className="text-base">
                              Tool Result Policies
                            </CardTitle>
                            <CardDescription>
                              Tool results impact agent decisions and actions.
                              Mark results as trusted or untrusted to prevent
                              acting on untrusted data.{" "}
                              <a
                                href="https://archestra.ai/docs/platform-dynamic-tools"
                                target="_blank"
                                rel="noopener noreferrer"
                                className="underline hover:text-foreground"
                              >
                                Read more about Dynamic Tools.
                              </a>
                            </CardDescription>
                          </div>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => handleCreateTrustedPolicy(policy.id)}
                          >
                            <Plus className="mr-2 h-4 w-4" />
                            Add rule
                          </Button>
                        </CardHeader>
                        <CardContent>
                          <ToolResultPolicies rules={trustedRules} />
                        </CardContent>
                      </Card>

                      <ResponseModifierEditor toolPolicy={policy} />
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export default function ToolPoliciesClient({ toolId }: { toolId: string }) {
  return (
    <ToolDetailShell toolId={toolId}>
      {(tool: Tool) => <ToolPolicies tool={tool} />}
    </ToolDetailShell>
  );
}
