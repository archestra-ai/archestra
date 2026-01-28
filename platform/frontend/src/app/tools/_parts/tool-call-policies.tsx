import {
  type archestraApiTypes,
  CONTEXT_EXTERNAL_AGENT_ID,
  CONTEXT_TEAM_IDS,
} from "@shared";
import { ArrowRightIcon, Plus } from "lucide-react";
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
import {
  type CallPolicyAction,
  getCallPolicyActionFromPolicies,
} from "@/lib/policy.utils";
import { useTeams } from "@/lib/team.query";
import { CallPolicyToggle } from "./call-policy-toggle";
import { PolicyCard } from "./policy-card";
import {
  type PolicyCondition,
  ToolCallPolicyCondition,
} from "./tool-call-policy-condition";

type ToolForPolicies = {
  id: string;
  parameters?: archestraApiTypes.GetToolsWithAssignmentsResponses["200"]["data"][number]["parameters"];
};

export function ToolCallPolicies({ tool }: { tool: ToolForPolicies }) {
  const { data: invocationPolicies } = useToolInvocationPolicies();
  const toolInvocationPolicyCreateMutation =
    useToolInvocationPolicyCreateMutation();
  const toolInvocationPolicyDeleteMutation =
    useToolInvocationPolicyDeleteMutation();
  const toolInvocationPolicyUpdateMutation =
    useToolInvocationPolicyUpdateMutation();
  const callPolicyMutation = useCallPolicyMutation();
  const { data: externalAgentIds = [] } = useUniqueExternalAgentIds();
  const { data: teams } = useTeams();

  const byProfileToolId = invocationPolicies?.byProfileToolId ?? {};
  const allPolicies = byProfileToolId[tool.id] || [];
  // Filter out default policies (empty conditions) - they're shown in the DEFAULT section
  const policies = allPolicies.filter(
    (policy: (typeof allPolicies)[number]) => policy.conditions.length > 0,
  );

  const argumentNames = Object.keys(tool.parameters?.properties || []);
  // Combine argument names with context condition options
  const contextOptions = [
    ...(externalAgentIds.length > 0 ? [CONTEXT_EXTERNAL_AGENT_ID] : []),
    ...((teams?.length ?? 0) > 0 ? [CONTEXT_TEAM_IDS] : []),
  ];
  const conditionKeyOptions = [...argumentNames, ...contextOptions];

  // Derive call policy action from policies (default policy with empty conditions)
  const currentAction = getCallPolicyActionFromPolicies(
    tool.id,
    invocationPolicies ?? { byProfileToolId: {} },
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
    const newConditions = policy.conditions.filter(
      (_: unknown, i: number) => i !== index,
    );
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

  const handleActionChange = (action: CallPolicyAction) => {
    if (action === currentAction) return;
    callPolicyMutation.mutate({
      toolId: tool.id,
      action,
    });
  };

  return (
    <div className="border border-border rounded-lg p-6 bg-card space-y-4">
      <div>
        <h3 className="text-sm font-semibold mb-1">Tool Call Policies</h3>
        <p className="text-sm text-muted-foreground">
          Controls when the tool can be called based on context trust level
        </p>
      </div>
      <div className="flex items-center justify-between p-3 bg-muted rounded-md border border-border">
        <div className="flex items-center gap-3">
          <div className="text-xs font-medium text-muted-foreground">
            DEFAULT
          </div>
        </div>
        <CallPolicyToggle
          value={currentAction}
          onChange={handleActionChange}
          size="lg"
        />
      </div>
      {policies.map((policy: (typeof allPolicies)[number]) => (
        <PolicyCard
          key={policy.id}
          onDelete={() => toolInvocationPolicyDeleteMutation.mutate(policy.id)}
        >
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-2">
              {policy.conditions.map(
                (condition: PolicyCondition, index: number) => (
                  <div
                    key={`${condition.key}-${condition.operator}-${condition.value}`}
                    className="flex items-center gap-2"
                  >
                    <span className="text-sm text-muted-foreground w-2">
                      {index === 0 ? "If" : ""}
                    </span>
                    <ToolCallPolicyCondition
                      condition={condition}
                      conditionKeyOptions={{ argumentNames, contextOptions }}
                      removable={policy.conditions.length > 1}
                      onChange={(updated) =>
                        handleConditionChange(policy, index, updated)
                      }
                      onRemove={() => handleConditionRemove(policy, index)}
                    />
                    {index < policy.conditions.length - 1 ? (
                      <span className="text-sm text-muted-foreground">and</span>
                    ) : (
                      <TooltipProvider>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              variant="secondary"
                              size="sm"
                              className="h-9 w-9 p-0"
                              aria-label="Add condition"
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
                    )}
                  </div>
                ),
              )}
            </div>
            <div className="flex items-center gap-2 pl-12">
              <ArrowRightIcon className="w-4 h-4 text-muted-foreground shrink-0" />
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
                <SelectTrigger className="w-[200px]">
                  <SelectValue placeholder="Action" />
                </SelectTrigger>
                <SelectContent>
                  {[
                    {
                      value: "allow_when_context_is_untrusted",
                      label: "Allow always",
                    },
                    {
                      value: "block_when_context_is_untrusted",
                      label: "Allow in trusted context",
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
                className="flex-1 min-w-[150px] max-w-[300px]"
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
