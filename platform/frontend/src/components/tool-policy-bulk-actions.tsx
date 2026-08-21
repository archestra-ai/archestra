"use client";

import { Loader2, Wand2 } from "lucide-react";
import { type ReactNode, useCallback, useState } from "react";
import { toast } from "sonner";
import { WithPermissions } from "@/components/roles/with-permissions";
import {
  BulkActionsBar,
  type SelectAllMatching,
} from "@/components/ui/bulk-actions-bar";
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
 * Tools & Guardrails step. Owns the mutation/in-flight state and supplies the
 * policy controls; the surrounding bar — count, Clear, hide-when-empty — comes
 * from `BulkActionsBar`, so this matches every other table's bulk affordance.
 */
export function ToolPolicyBulkActionsBar({
  selectedToolIds,
  onClear,
  selectAllMatching,
  busy,
}: {
  selectedToolIds: readonly string[];
  onClear: () => void;
  selectAllMatching?: SelectAllMatching;
  /** Set while the caller is resolving a "select all matching" escalation. */
  busy?: boolean;
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

  const configureWithSubagentButton = (
    <Tooltip>
      <TooltipTrigger asChild>
        <PermissionButton
          permissions={{ agent: ["update"], toolPolicy: ["update"] }}
          size="sm"
          variant="outline"
          onClick={handleAutoConfigurePolicies}
          disabled={isBulkUpdating || autoConfigureMutation.isPending}
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

  const policySelect = ({
    label,
    ariaLabel,
    value,
    onChange,
    triggerClassName,
    children,
  }: {
    label: string;
    ariaLabel: string;
    value: string;
    onChange: (value: string) => void;
    triggerClassName: string;
    children: ReactNode;
  }) => (
    <WithPermissions
      permissions={{ toolPolicy: ["update"] }}
      noPermissionHandle="tooltip"
    >
      {({ hasPermission }) => (
        <div className="flex items-center gap-2">
          {/* The two selects share the "Select action" placeholder, so the
              label is what tells them apart once they sit side by side. */}
          <span className="text-xs font-medium text-muted-foreground whitespace-nowrap">
            {label}
          </span>
          <Select
            disabled={isBulkUpdating || !hasPermission}
            value={value}
            onValueChange={onChange}
          >
            <SelectTrigger
              aria-label={ariaLabel}
              className={triggerClassName}
              size="sm"
            >
              <SelectValue placeholder="Select action" />
            </SelectTrigger>
            <SelectContent>{children}</SelectContent>
          </Select>
        </div>
      )}
    </WithPermissions>
  );

  return (
    <BulkActionsBar
      count={selectedToolIds.length}
      noun="tool"
      busy={isBulkUpdating || busy}
      onClear={onClear}
      selectAllMatching={selectAllMatching}
    >
      {policySelect({
        label: "Call policy:",
        ariaLabel: "Bulk call policy action",
        value: bulkCallPolicyValue,
        onChange: (value) => {
          setBulkCallPolicyValue(value);
          handleBulkAction("callPolicy", value as CallPolicyAction);
        },
        triggerClassName: "h-8 w-[168px] text-sm",
        children: (
          <>
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
          </>
        ),
      })}
      {policySelect({
        label: "Results are:",
        ariaLabel: "Bulk result policy action",
        value: bulkResultPolicyValue,
        onChange: (value) => {
          setBulkResultPolicyValue(value);
          handleBulkAction("resultPolicyAction", value as ResultPolicyAction);
        },
        triggerClassName: "h-8 w-[150px] text-sm",
        children: RESULT_POLICY_ACTION_OPTIONS.map(({ value, label }) => (
          <SelectItem key={value} value={value}>
            {label}
          </SelectItem>
        )),
      })}
      {configureWithSubagentButton}
    </BulkActionsBar>
  );
}
