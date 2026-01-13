import type { archestraApiTypes } from "@shared";
import { ArrowRightIcon, Info, Plus, Trash2Icon } from "lucide-react";
import { ButtonWithTooltip } from "@/components/button-with-tooltip";
import { CaseSensitiveTooltip } from "@/components/case-sensitive-tooltip";
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
  useOperators,
  useToolInvocationPolicies,
  useToolInvocationPolicyCreateMutation,
  useToolInvocationPolicyDeleteMutation,
  useToolInvocationPolicyUpdateMutation,
} from "@/lib/policy.query";
import { getAllowUsageFromPolicies } from "@/lib/policy.utils";
import { useTeams } from "@/lib/team.query";
import { PolicyCard } from "./policy-card";

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
  const { data: operators } = useOperators();
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
            <div className="flex items-center justify-between">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm">If</span>
                <Select
                  defaultValue={policy.argumentName}
                  onValueChange={(value) => {
                    // Auto-select value if only one option available
                    let autoValue = "";
                    if (
                      value === CONTEXT_EXTERNAL_AGENT_ID &&
                      externalAgentIds.length === 1
                    ) {
                      autoValue = externalAgentIds[0];
                    } else if (
                      value === CONTEXT_TEAM_IDS &&
                      teams?.length === 1
                    ) {
                      autoValue = teams[0].id;
                    }
                    // Set default operator based on key type
                    let defaultOperator = policy.operator;
                    if (value === CONTEXT_TEAM_IDS) {
                      defaultOperator = "contains";
                    } else if (value === CONTEXT_EXTERNAL_AGENT_ID) {
                      defaultOperator = "equal";
                    }
                    toolInvocationPolicyUpdateMutation.mutate({
                      ...policy,
                      argumentName: value,
                      value: autoValue,
                      operator: defaultOperator,
                    });
                  }}
                >
                  <SelectTrigger className="w-[180px]">
                    <SelectValue placeholder="parameter" />
                  </SelectTrigger>
                  <SelectContent>
                    {argumentNames.length > 0 && (
                      <>
                        <SelectItem
                          disabled
                          value="__param_header__"
                          className="text-xs text-muted-foreground font-medium"
                        >
                          Parameters
                        </SelectItem>
                        {argumentNames.map((argumentName) => (
                          <SelectItem key={argumentName} value={argumentName}>
                            {argumentName}
                          </SelectItem>
                        ))}
                      </>
                    )}
                    {contextOptions.length > 0 && (
                      <>
                        <SelectItem
                          disabled
                          value="__context_header__"
                          className="text-xs text-muted-foreground font-medium"
                        >
                          Context
                        </SelectItem>
                        {externalAgentIds.length > 0 && (
                          <SelectItem value={CONTEXT_EXTERNAL_AGENT_ID}>
                            External Agent
                          </SelectItem>
                        )}
                        {(teams?.length ?? 0) > 0 && (
                          <SelectItem value={CONTEXT_TEAM_IDS}>
                            Teams
                          </SelectItem>
                        )}
                      </>
                    )}
                  </SelectContent>
                </Select>
                <Select
                  value={policy.operator}
                  onValueChange={(value: string) =>
                    toolInvocationPolicyUpdateMutation.mutate({
                      ...policy,
                      operator: value,
                    })
                  }
                >
                  <SelectTrigger className="w-[120px]">
                    <SelectValue placeholder="Operator" />
                  </SelectTrigger>
                  <SelectContent>
                    {operators
                      .filter((op) => {
                        if (policy.argumentName === CONTEXT_EXTERNAL_AGENT_ID) {
                          return ["equal", "notEqual"].includes(op.value);
                        }
                        if (policy.argumentName === CONTEXT_TEAM_IDS) {
                          return ["contains", "notContains"].includes(op.value);
                        }
                        return true;
                      })
                      .map((operator) => (
                        <SelectItem key={operator.value} value={operator.value}>
                          {operator.label}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
                {policy.argumentName === CONTEXT_EXTERNAL_AGENT_ID ? (
                  externalAgentIds.length === 1 ? (
                    <>
                      <span className="text-sm">{externalAgentIds[0]}</span>
                      <TooltipProvider>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Info className="w-4 h-4 text-muted-foreground cursor-help" />
                          </TooltipTrigger>
                          <TooltipContent>
                            <p>Only one external agent available</p>
                          </TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                    </>
                  ) : (
                    <Select
                      value={policy.value || undefined}
                      onValueChange={(value) =>
                        toolInvocationPolicyUpdateMutation.mutate({
                          ...policy,
                          value,
                        })
                      }
                    >
                      <SelectTrigger className="w-[180px]">
                        <SelectValue placeholder="Select agent ID" />
                      </SelectTrigger>
                      <SelectContent>
                        {externalAgentIds.map((agentId) => (
                          <SelectItem key={agentId} value={agentId}>
                            {agentId}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )
                ) : policy.argumentName === CONTEXT_TEAM_IDS ? (
                  teams?.length === 1 ? (
                    <>
                      <span className="text-sm">{teams[0].name}</span>
                      <TooltipProvider>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Info className="w-4 h-4 text-muted-foreground cursor-help" />
                          </TooltipTrigger>
                          <TooltipContent>
                            <p>Only one team available</p>
                          </TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                    </>
                  ) : (
                    <Select
                      value={policy.value || undefined}
                      onValueChange={(value) =>
                        toolInvocationPolicyUpdateMutation.mutate({
                          ...policy,
                          value,
                        })
                      }
                    >
                      <SelectTrigger className="w-[180px]">
                        <SelectValue placeholder="Select team" />
                      </SelectTrigger>
                      <SelectContent>
                        {teams?.map((team) => (
                          <SelectItem key={team.id} value={team.id}>
                            {team.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )
                ) : (
                  <DebouncedInput
                    placeholder="Value"
                    className="w-[120px]"
                    initialValue={policy.value}
                    onChange={(value) =>
                      toolInvocationPolicyUpdateMutation.mutate({
                        ...policy,
                        value,
                      })
                    }
                  />
                )}
                {![CONTEXT_EXTERNAL_AGENT_ID, CONTEXT_TEAM_IDS].includes(
                  policy.argumentName,
                ) && <CaseSensitiveTooltip />}
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
                    ...policy,
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
                    ...policy,
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
            argumentName:
              argumentNames[0] ??
              (externalAgentIds.length > 0
                ? CONTEXT_EXTERNAL_AGENT_ID
                : CONTEXT_TEAM_IDS),
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
