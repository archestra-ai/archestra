import type { archestraApiTypes } from "@shared";
import { Info } from "lucide-react";
import { CaseSensitiveTooltip } from "@/components/case-sensitive-tooltip";
import { DebouncedInput } from "@/components/debounced-input";
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
  useOperators,
  useToolInvocationPolicyUpdateMutation,
} from "@/lib/policy.query";
import { useTeams } from "@/lib/team.query";

const CONTEXT_EXTERNAL_AGENT_ID = "context.externalAgentId";
const CONTEXT_TEAM_IDS = "context.teamIds";

type ToolInvocationPolicy =
  archestraApiTypes.GetToolInvocationPoliciesResponses["200"][number];

type ConditionKeyOptions = {
  argumentNames: string[];
  contextOptions: string[];
};

export function ToolCallPolicyCondition({
  policy,
  conditionKeyOptions,
}: {
  policy: ToolInvocationPolicy;
  conditionKeyOptions: ConditionKeyOptions;
}) {
  const toolInvocationPolicyUpdateMutation =
    useToolInvocationPolicyUpdateMutation();
  const { data: operators } = useOperators();
  const { data: externalAgentIds } = useUniqueExternalAgentIds();
  const { data: teams } = useTeams();

  const { argumentNames, contextOptions } = conditionKeyOptions;

  // Extract first condition (UI currently supports single condition)
  const condition = policy.conditions[0];
  const argumentName = condition?.key ?? "";
  const operator = condition?.operator ?? "equal";
  const value = condition?.value ?? "";

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-sm">If</span>
      <Select
        defaultValue={argumentName}
        onValueChange={(newKey) => {
          // Auto-select value if only one option available
          let autoValue = "";
          if (
            newKey === CONTEXT_EXTERNAL_AGENT_ID &&
            externalAgentIds.length === 1
          ) {
            autoValue = externalAgentIds[0];
          } else if (newKey === CONTEXT_TEAM_IDS && teams?.length === 1) {
            autoValue = teams[0].id;
          }
          // Set default operator based on key type
          let defaultOperator = operator;
          if (newKey === CONTEXT_TEAM_IDS) {
            defaultOperator = "contains";
          } else if (newKey === CONTEXT_EXTERNAL_AGENT_ID) {
            defaultOperator = "equal";
          }
          toolInvocationPolicyUpdateMutation.mutate({
            ...policy,
            argumentName: newKey,
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
              {argumentNames.map((name) => (
                <SelectItem key={name} value={name}>
                  {name}
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
                <SelectItem value={CONTEXT_TEAM_IDS}>Teams</SelectItem>
              )}
            </>
          )}
        </SelectContent>
      </Select>
      <Select
        value={operator}
        onValueChange={(newOperator: string) =>
          toolInvocationPolicyUpdateMutation.mutate({
            ...policy,
            operator: newOperator,
          })
        }
      >
        <SelectTrigger className="w-[120px]">
          <SelectValue placeholder="Operator" />
        </SelectTrigger>
        <SelectContent>
          {operators
            .filter((op) => {
              if (argumentName === CONTEXT_EXTERNAL_AGENT_ID) {
                return ["equal", "notEqual"].includes(op.value);
              }
              if (argumentName === CONTEXT_TEAM_IDS) {
                return ["contains", "notContains"].includes(op.value);
              }
              return true;
            })
            .map((op) => (
              <SelectItem key={op.value} value={op.value}>
                {op.label}
              </SelectItem>
            ))}
        </SelectContent>
      </Select>
      {argumentName === CONTEXT_EXTERNAL_AGENT_ID ? (
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
            value={value || undefined}
            onValueChange={(newValue) =>
              toolInvocationPolicyUpdateMutation.mutate({
                ...policy,
                value: newValue,
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
      ) : argumentName === CONTEXT_TEAM_IDS ? (
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
            value={value || undefined}
            onValueChange={(newValue) =>
              toolInvocationPolicyUpdateMutation.mutate({
                ...policy,
                value: newValue,
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
          initialValue={value}
          onChange={(newValue) =>
            toolInvocationPolicyUpdateMutation.mutate({
              ...policy,
              value: newValue,
            })
          }
        />
      )}
      {![CONTEXT_EXTERNAL_AGENT_ID, CONTEXT_TEAM_IDS].includes(argumentName) && (
        <CaseSensitiveTooltip />
      )}
    </div>
  );
}
