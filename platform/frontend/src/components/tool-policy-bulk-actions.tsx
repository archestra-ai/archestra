"use client";

import { Loader2, Wand2 } from "lucide-react";
import { useCallback, useState } from "react";
import { toast } from "sonner";
import { LoadingSpinner } from "@/components/loading";
import { WithPermissions } from "@/components/roles/with-permissions";
import { PermissionButton } from "@/components/ui/permission-button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useAutoConfigurePolicies } from "@/lib/agent-tools.query";
import {
  useBulkCallPolicyMutation,
  useBulkResultPolicyMutation,
  useToolInvocationPolicies,
  useToolResultPolicies,
} from "@/lib/policy.query";
import {
  type CallPolicyAction,
  RESULT_POLICY_ACTION_OPTIONS,
  type ResultPolicyAction,
} from "@/lib/policy.utils";

/**
 * Bulk policy actions for a selection of tools: apply a call policy or a
 * result policy to every selected tool (skipping tools that carry custom
 * conditioned policies), or let a subagent configure sensible defaults.
 *
 * Shared between the full guardrails table and the MCP server setup wizard's
 * Tools & Guardrails step. Renders its own desktop and mobile layouts and
 * owns the mutation/in-flight state; callers only supply the selected tool
 * ids.
 */
export function ToolPolicyBulkActionsBar({
  selectedToolIds,
}: {
  selectedToolIds: readonly string[];
}) {
  const bulkCallPolicyMutation = useBulkCallPolicyMutation();
  const bulkResultPolicyMutation = useBulkResultPolicyMutation();
  const autoConfigureMutation = useAutoConfigurePolicies();
  const { data: invocationPolicies } = useToolInvocationPolicies();
  const { data: resultPolicies } = useToolResultPolicies();

  const [isBulkUpdating, setIsBulkUpdating] = useState(false);
  const [bulkCallPolicyValue, setBulkCallPolicyValue] = useState<string>("");
  const [bulkResultPolicyValue, setBulkResultPolicyValue] =
    useState<string>("");

  const hasSelection = selectedToolIds.length > 0;

  const handleBulkAction = useCallback(
    async (
      field: "callPolicy" | "resultPolicyAction",
      value: CallPolicyAction | ResultPolicyAction,
    ) => {
      // Filter out tools with custom policies (non-empty conditions)
      const toolIds = selectedToolIds.filter((toolId) => {
        const policies =
          field === "callPolicy"
            ? invocationPolicies?.byProfileToolId[toolId] || []
            : resultPolicies?.byProfileToolId[toolId] || [];

        // Check if tool has custom policies (non-empty conditions array)
        const hasCustomPolicy = policies.some(
          (policy) => policy.conditions.length > 0,
        );

        return !hasCustomPolicy;
      });

      if (toolIds.length === 0) {
        return;
      }
      try {
        setIsBulkUpdating(true);

        if (field === "callPolicy") {
          await bulkCallPolicyMutation.mutateAsync({
            toolIds,
            action: value as CallPolicyAction,
          });
        } else {
          await bulkResultPolicyMutation.mutateAsync({
            toolIds,
            action: value as ResultPolicyAction,
          });
        }
      } finally {
        setIsBulkUpdating(false);
        setBulkCallPolicyValue("");
        setBulkResultPolicyValue("");
      }
    },
    [
      selectedToolIds,
      bulkCallPolicyMutation,
      bulkResultPolicyMutation,
      invocationPolicies,
      resultPolicies,
    ],
  );

  const handleAutoConfigurePolicies = useCallback(async () => {
    if (selectedToolIds.length === 0) {
      toast.error("No tools selected to configure");
      return;
    }

    try {
      const result = await autoConfigureMutation.mutateAsync([
        ...selectedToolIds,
      ]);
      if (!result) return;

      const successCount = result.results.filter(
        (r: { success: boolean }) => r.success,
      ).length;
      const failureCount = result.results.filter(
        (r: { success: boolean }) => !r.success,
      ).length;

      if (failureCount === 0) {
        toast.success(
          `Default policies configured for ${successCount} tool(s). Custom policies are preserved.`,
        );
      } else {
        toast.warning(
          `Default policies configured for ${successCount} tool(s), failed ${failureCount}. Custom policies are preserved.`,
        );
      }

      // Reset bulk action dropdowns to placeholder
      setBulkCallPolicyValue("");
      setBulkResultPolicyValue("");
    } catch (error) {
      const errorMessage =
        error instanceof Error
          ? error.message
          : "Failed to auto-configure policies";
      toast.error(errorMessage);
    }
  }, [selectedToolIds, autoConfigureMutation]);

  const configureWithSubagentButton = (className?: string) => (
    <Tooltip>
      <TooltipTrigger asChild>
        <PermissionButton
          permissions={{ agent: ["update"], toolPolicy: ["update"] }}
          size="sm"
          variant="outline"
          className={className}
          onClick={handleAutoConfigurePolicies}
          disabled={
            !hasSelection || isBulkUpdating || autoConfigureMutation.isPending
          }
        >
          {autoConfigureMutation.isPending ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              Configuring...
            </>
          ) : (
            <>
              <Wand2 className="h-4 w-4" />
              Configure with Subagent
            </>
          )}
        </PermissionButton>
      </TooltipTrigger>
      <TooltipContent>
        <p>Automatically configure default policies using AI analysis</p>
      </TooltipContent>
    </Tooltip>
  );

  const callPolicySelect = (triggerClassName: string) => (
    <WithPermissions
      permissions={{ toolPolicy: ["update"] }}
      noPermissionHandle="tooltip"
    >
      {({ hasPermission }) => (
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted-foreground">
            Call Policy:
          </span>
          <Select
            disabled={!hasSelection || isBulkUpdating || !hasPermission}
            value={bulkCallPolicyValue}
            onValueChange={(value: CallPolicyAction) => {
              setBulkCallPolicyValue(value);
              handleBulkAction("callPolicy", value);
            }}
          >
            <SelectTrigger
              aria-label="Bulk call policy action"
              className={triggerClassName}
              size="sm"
            >
              <SelectValue placeholder="Select action" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="allow_when_context_is_untrusted">
                Allow always
              </SelectItem>
              <SelectItem value="block_when_context_is_untrusted">
                Block in sensitive context
              </SelectItem>
              <SelectItem
                value="require_approval"
                description="Requires user confirmation before executing in chat. In autonomous agent sessions (A2A, API, MS Teams, subagents), the tool call is blocked."
              >
                Require approval
              </SelectItem>
              <SelectItem value="block_always">Block always</SelectItem>
            </SelectContent>
          </Select>
        </div>
      )}
    </WithPermissions>
  );

  const resultPolicySelect = (triggerClassName: string) => (
    <WithPermissions
      permissions={{ toolPolicy: ["update"] }}
      noPermissionHandle="tooltip"
    >
      {({ hasPermission }) => (
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted-foreground">
            Results are:
          </span>
          <Select
            disabled={!hasSelection || isBulkUpdating || !hasPermission}
            value={bulkResultPolicyValue}
            onValueChange={(value: ResultPolicyAction) => {
              setBulkResultPolicyValue(value);
              handleBulkAction("resultPolicyAction", value);
            }}
          >
            <SelectTrigger
              aria-label="Bulk result policy action"
              className={triggerClassName}
              size="sm"
            >
              <SelectValue placeholder="Select action" />
            </SelectTrigger>
            <SelectContent>
              {RESULT_POLICY_ACTION_OPTIONS.map(({ value, label }) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
    </WithPermissions>
  );

  return (
    <>
      {/* Bulk actions - Desktop */}
      <div className="hidden lg:flex flex-wrap items-center gap-4 p-4 bg-muted/50 border border-border rounded-lg">
        <div className="flex items-center gap-3">
          {hasSelection ? (
            <>
              <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/10">
                <span className="text-sm font-semibold text-primary">
                  {selectedToolIds.length}
                </span>
              </div>
              <span className="text-sm font-medium whitespace-nowrap">
                {selectedToolIds.length === 1
                  ? "tool selected"
                  : "tools selected"}
              </span>
              {isBulkUpdating && (
                <LoadingSpinner className="h-4 w-4 text-muted-foreground" />
              )}
            </>
          ) : (
            <span className="text-sm text-muted-foreground whitespace-nowrap">
              Select tools to apply bulk actions
            </span>
          )}
        </div>
        <div className="ml-auto flex flex-wrap items-end gap-4">
          {callPolicySelect("h-8 w-[168px] text-sm")}
          {resultPolicySelect("h-8 w-[150px] text-sm")}
          {configureWithSubagentButton()}
        </div>
      </div>

      {/* Bulk actions - Mobile */}
      <div className="flex flex-col gap-3 rounded-lg border border-border bg-muted/50 p-3 lg:hidden">
        <div className="flex items-center gap-2">
          {hasSelection ? (
            <>
              <div className="flex h-6 w-6 items-center justify-center rounded-full bg-primary/10">
                <span className="text-xs font-semibold text-primary">
                  {selectedToolIds.length}
                </span>
              </div>
              <span className="text-sm font-medium">
                {selectedToolIds.length === 1
                  ? "tool selected"
                  : "tools selected"}
              </span>
              {isBulkUpdating && (
                <LoadingSpinner className="h-3.5 w-3.5 text-muted-foreground" />
              )}
            </>
          ) : (
            <span className="text-xs text-muted-foreground">
              Select tools to apply bulk actions
            </span>
          )}
        </div>

        <div className="flex flex-col gap-3">
          {callPolicySelect("h-9 w-full text-sm")}
          {resultPolicySelect("h-9 w-full text-sm")}
        </div>

        <div className="flex flex-col gap-2 pt-1">
          {configureWithSubagentButton("w-full justify-center")}
        </div>
      </div>
    </>
  );
}
