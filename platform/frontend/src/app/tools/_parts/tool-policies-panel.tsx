"use client";

import type { archestraApiTypes } from "@shared";
import { Plus, Trash2 } from "lucide-react";
import { useCallback, useMemo } from "react";
import { toast } from "sonner";
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
import {
  useCreateToolPolicy,
  useDeleteToolPolicy,
  useToolPolicies,
  useUpdateToolPolicy,
} from "@/lib/tool-policy.query";
import { formatDate } from "@/lib/utils";
import { ResponseModifierEditor } from "./response-modifier-editor";
import { ToolInvocationPolicies } from "./tool-invocation-policies";
import { ToolResultPolicies } from "./tool-result-policies";
import type { Tool, ToolPolicyResultTreatmentOption } from "./types";

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

export function ToolPoliciesPanel({ tool }: { tool: Tool }) {
  const { data: rawPolicies = [], isLoading: isLoadingPolicies } =
    useToolPolicies(tool?.id ?? null);
  const policies = useMemo(
    () => (rawPolicies ?? []).filter((policy) => policy.toolId === tool.id),
    [rawPolicies, tool.id],
  );

  const createPolicy = useCreateToolPolicy();
  const updatePolicy = useUpdateToolPolicy(tool?.id ?? null);
  const deletePolicy = useDeleteToolPolicy(tool?.id ?? null);

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

                <div className="grid gap-4 md:grid-cols-2">
                  <ToolInvocationPolicies
                    policyId={policy.id}
                    rules={invocationRules}
                  />

                  <ToolResultPolicies
                    policyId={policy.id}
                    rules={trustedRules}
                  />
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
