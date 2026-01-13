import type { archestraApiTypes } from "@shared";
import { ArrowRightIcon, Plus, Trash2Icon } from "lucide-react";
import { ButtonWithTooltip } from "@/components/button-with-tooltip";
import { DebouncedInput } from "@/components/debounced-input";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useUniqueExternalAgentIds } from "@/lib/interaction.query";
import {
  useCallPolicyMutation,
  useToolInvocationPolicies,
  useToolInvocationPolicyCreateMutation,
  useToolInvocationPolicyDeleteMutation,
  useToolInvocationPolicyUpdateMutation,
} from "@/lib/policy.query";
import { getAllowUsageFromPolicies } from "@/lib/policy.utils";
import { useTeams } from "@/lib/team.query";
import { PolicyCard } from "./policy-card";
import {
  type PolicyCondition,
  ToolCallPolicyCondition,
} from "./tool-call-policy-condition";

const CONTEXT_EXTERNAL_AGENT_ID = "context.externalAgentId";
const CONTEXT_TEAM_IDS = "context.teamIds";

type ToolForPolicies = {
  id: string;
  parameters?: archestraApiTypes.GetToolsWithAssignmentsResponses["200"]["data"][number]["parameters"];
};

export function ToolCallPolicies({ tool }: { tool: ToolForPolicies }) {
  const {
    data: { byProfileToolId },
    data: invocationPolicies,
  } = useToolInvocationPolicies();
  const toolInvocationPolicyCreateMutation =
    useToolInvocationPolicyCreateMutation();
  const toolInvocationPolicyDeleteMutation =
    useToolInvocationPolicyDeleteMutation();
  const toolInvocationPolicyUpdateMutation =
    useToolInvocationPolicyUpdateMutation();
  const callPolicyMutation = useCallPolicyMutation();
  const { data: externalAgentIds } = useUniqueExternalAgentIds();
  const { data: teams } = useTeams();

  const allPolicies = byProfileToolId[tool.id] || [];
  // Filter out default policies (empty conditions) - they're shown in the DEFAULT section
  const policies = allPolicies.filter((policy) => policy.conditions.length > 0);

  const argumentNames = Object.keys(tool.parameters?.properties || []);
  // Combine argument names with context condition options
  const contextOptions = [
    ...(externalAgentIds.length > 0 ? [CONTEXT_EXTERNAL_AGENT_ID] : []),
    ...((teams?.length ?? 0) > 0 ? [CONTEXT_TEAM_IDS] : []),
  ];
  const conditionKeyOptions = [...argumentNames, ...contextOptions];

  // Derive allow usage from policies (default policy with empty conditions)
  const allowUsageWhenUntrustedDataIsPresent = getAllowUsageFromPolicies(
    tool.id,
    invocationPolicies,
  );

  const getDefaultConditionKey = () =>
    argumentNames[0] ??
    (externalAgentIds.length > 0
      ? CONTEXT_EXTERNAL_AGENT_ID
      : CONTEXT_TEAM_IDS);

  const handleConditionChange = (
    policy: (typeof policies)[number],
    index: number,
    updatedCondition: PolicyCondition,
  ) => {
    const newConditions = [...policy.conditions];
    newConditions[index] = updatedCondition;
    toolInvocationPolicyUpdateMutation.mutate({
      id: policy.id,
      conditions: newConditions,
    });
  };

  const handleConditionRemove = (
    policy: (typeof policies)[number],
    index: number,
  ) => {
    const newConditions = policy.conditions.filter((_, i) => i !== index);
    toolInvocationPolicyUpdateMutation.mutate({
      id: policy.id,
      conditions: newConditions,
    });
  };

  const handleConditionAdd = (policy: (typeof policies)[number]) => {
    const newConditions: PolicyCondition[] = [
      ...policy.conditions,
      { key: getDefaultConditionKey(), operator: "equal", value: "" },
    ];
    toolInvocationPolicyUpdateMutation.mutate({
      id: policy.id,
      conditions: newConditions,
    });
  };

  return (
    <div className="border border-border rounded-lg p-6 bg-card space-y-4">
      <div>
        <h3 className="text-sm font-semibold mb-1">Tool Call Policies</h3>
        <p className="text-sm text-muted-foreground">
          Can tool be used when untrusted data is present in the context?
        </p>
      </div>
      <div className="flex items-center justify-between p-3 bg-muted/50 rounded-md border border-border">
        <div className="flex items-center gap-3">
          <div className="text-xs font-medium text-muted-foreground">
            DEFAULT
          </div>
          <span className="text-sm">
            Allow usage when untrusted data is present
          </span>
        </div>
        <Switch
          checked={allowUsageWhenUntrustedDataIsPresent}
          onCheckedChange={(checked) => {
            if (checked === allowUsageWhenUntrustedDataIsPresent) return;
            callPolicyMutation.mutate({
              toolId: tool.id,
              allowUsage: checked,
            });
          }}
        />
      </div>
      {policies.map((policy) => (
        <PolicyCard key={policy.id}>
          <div className="flex flex-col gap-3 w-full">
            <div className="flex items-start justify-between">
              <div className="flex flex-col gap-2">
                <span className="text-sm text-muted-foreground">If</span>
                <div className="flex flex-wrap items-center gap-2">
                  {policy.conditions.map((condition, index) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: conditions don't have unique IDs
                    <div key={index} className="flex items-center gap-2">
                      {index > 0 && (
                        <span className="text-sm text-muted-foreground">
                          and
                        </span>
                      )}
                      <ToolCallPolicyCondition
                        condition={condition}
                        conditionKeyOptions={{ argumentNames, contextOptions }}
                        removable={policy.conditions.length > 1}
                        onChange={(updated) =>
                          handleConditionChange(policy, index, updated)
                        }
                        onRemove={() => handleConditionRemove(policy, index)}
                      />
                    </div>
                  ))}
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="secondary"
                          size="sm"
                          className="h-8 w-8 p-0"
                          onClick={() => handleConditionAdd(policy)}
                        >
                          <Plus className="h-4 w-4" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>
                        <p>Add condition</p>
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                </div>
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="hover:text-red-500 ml-2"
                onClick={() =>
                  toolInvocationPolicyDeleteMutation.mutate(policy.id)
                }
              >
                <Trash2Icon className="w-4 h-4" />
              </Button>
            </div>
            <div className="flex flex-wrap items-center gap-2 pl-4">
              <ArrowRightIcon className="w-4 h-4 text-muted-foreground" />
              <Select
                defaultValue={policy.action}
                onValueChange={(
                  value: archestraApiTypes.GetToolInvocationPoliciesResponses["200"][number]["action"],
                ) =>
                  toolInvocationPolicyUpdateMutation.mutate({
                    id: policy.id,
                    action: value,
                  })
                }
              >
                <SelectTrigger className="w-[240px]">
                  <SelectValue placeholder="Action" />
                </SelectTrigger>
                <SelectContent>
                  {[
                    {
                      value: "allow_when_context_is_untrusted",
                      label: "Allow when untrusted data present",
                    },
                    {
                      value: "block_when_context_is_untrusted",
                      label: "Block when untrusted data present",
                    },
                    { value: "block_always", label: "Block always" },
                  ].map(({ value, label }) => (
                    <SelectItem key={label} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <DebouncedInput
                placeholder="Reason"
                className="flex-1 min-w-[150px]"
                initialValue={policy.reason || ""}
                onChange={(value) =>
                  toolInvocationPolicyUpdateMutation.mutate({
                    id: policy.id,
                    reason: value,
                  })
                }
              />
            </div>
          </div>
        </PolicyCard>
      ))}
      <ButtonWithTooltip
        variant="outline"
        className="w-full"
        onClick={() =>
          toolInvocationPolicyCreateMutation.mutate({
            toolId: tool.id,
            argumentName: getDefaultConditionKey(),
          })
        }
        disabled={conditionKeyOptions.length === 0}
        disabledText="No parameters or context conditions available"
      >
        <Plus className="w-3.5 h-3.5 mr-1" /> Add Policy
      </ButtonWithTooltip>
    </div>
  );
}
