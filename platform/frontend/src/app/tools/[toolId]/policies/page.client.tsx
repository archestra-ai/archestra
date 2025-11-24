"use client";

import type { archestraApiTypes } from "@shared";
import { Plus, Trash2 } from "lucide-react";
import { useCallback, useMemo } from "react";
import { toast } from "sonner";
import type { Tool, ToolPolicyResultTreatmentOption } from "@/app/tools/types";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
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
          No policies yet.
        </div>
      ) : (
        <div className="space-y-4">
          {policies.map((policy) => {
            const invocationRules = policy.toolInvocationPolicies ?? [];
            const trustedRules = policy.trustedDataPolicies ?? [];

            return (
              <div key={policy.id}>
                <div className="px-4 text-left hover:no-underline">
                  <span className="text-sm font-medium">{policy.name}</span>
                </div>
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
                      onValueChange={(value: ToolPolicyResultTreatmentOption) =>
                        handlePolicyUpdate(policy.id, {
                          toolResultTreatment: value,
                        })
                      }
                    >
                      <SelectTrigger className="mt-2">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {Object.values(TOOL_RESULT_OPTIONS).map((option) => (
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

                <div className="rounded-md px-3 py-2 text-sm font-medium hover:no-underline">
                  <div className="flex items-center justify-between">
                    <div>
                      <h3 className="text-sm font-semibold mb-1">
                        Tool invocation policies
                      </h3>
                      <p className="text-sm text-muted-foreground">
                        FOO BAR BAZ TODO: Add description.{" "}
                        <a
                          href="https://archestra.ai/docs/platform-dynamic-tools"
                          target="_blank"
                          rel="noopener noreferrer"
                          className="underline hover:text-foreground"
                        >
                          Read more about Dynamic Tools.
                        </a>
                      </p>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleCreateInvocationPolicy(policy.id)}
                    >
                      <Plus className="mr-2 h-4 w-4" />
                      Add rule
                    </Button>
                  </div>
                  <Card>
                    <CardContent>
                      <ToolInvocationPolicies rules={invocationRules} />
                    </CardContent>
                  </Card>
                </div>

                <div className="rounded-md px-3 py-2 text-sm font-medium hover:no-underline">
                  <div className="flex items-center justify-between">
                    <div>
                      <h3 className="text-sm font-semibold mb-1">
                        Tool Result Policies
                      </h3>
                      <p className="text-sm text-muted-foreground">
                        Tool results impact agent decisions and actions. This
                        policy allows to mark tool results as
                        &ldquo;trusted&rdquo; or &ldquo;untrusted&rdquo; to
                        prevent agent acting on untrusted data.{" "}
                        <a
                          href="https://archestra.ai/docs/platform-dynamic-tools"
                          target="_blank"
                          rel="noopener noreferrer"
                          className="underline hover:text-foreground"
                        >
                          Read more about Dynamic Tools.
                        </a>
                      </p>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleCreateTrustedPolicy(policy.id)}
                    >
                      <Plus className="mr-2 h-4 w-4" />
                      Add result rule
                    </Button>
                  </div>

                  <Card>
                    <CardContent>
                      <ToolResultPolicies rules={trustedRules} />
                    </CardContent>
                  </Card>
                </div>

                <ResponseModifierEditor toolPolicy={policy} />
              </div>
            );
          })}
        </div>
      )}
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
