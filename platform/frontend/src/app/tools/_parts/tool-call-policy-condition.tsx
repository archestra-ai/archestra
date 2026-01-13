import { CONTEXT_EXTERNAL_AGENT_ID, CONTEXT_TEAM_IDS } from "@shared";
import { Info, X } from "lucide-react";
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
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useUniqueExternalAgentIds } from "@/lib/interaction.query";
import { useOperators } from "@/lib/policy.query";
import { useTeams } from "@/lib/team.query";

export type PolicyCondition = {
  key: string;
  operator:
    | "equal"
    | "notEqual"
    | "contains"
    | "notContains"
    | "startsWith"
    | "endsWith"
    | "regex";
  value: string;
};

type ConditionKeyOptions = {
  argumentNames: string[];
  contextOptions: string[];
};

export function ToolCallPolicyCondition({
  condition,
  conditionKeyOptions,
  removable,
  onChange,
  onRemove,
}: {
  condition: PolicyCondition;
  conditionKeyOptions: ConditionKeyOptions;
  removable: boolean;
  onChange: (condition: PolicyCondition) => void;
  onRemove: () => void;
}) {
  const { data: operators } = useOperators();
  const { data: externalAgentIds } = useUniqueExternalAgentIds();
  const { data: teams } = useTeams();

  const { argumentNames, contextOptions } = conditionKeyOptions;
  const { key: argumentName, operator, value } = condition;

  const handleKeyChange = (newKey: string) => {
    // Auto-select value if only one option available
    let autoValue = "";
    if (newKey === CONTEXT_EXTERNAL_AGENT_ID && externalAgentIds.length === 1) {
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
    onChange({
      key: newKey,
      operator: defaultOperator,
      value: autoValue,
    });
  };

  return (
    <div className="flex items-center gap-2 rounded-md bg-muted px-3 py-2">
      <div className="grid grid-cols-3 gap-2 flex-1 min-w-0">
        <Select defaultValue={argumentName} onValueChange={handleKeyChange}>
          <SelectTrigger className="w-full h-9">
            <SelectValue placeholder="parameter" />
          </SelectTrigger>
          <SelectContent>
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
          </SelectContent>
        </Select>
        <Select
          value={operator}
          onValueChange={(newOperator) =>
            onChange({
              ...condition,
              operator: newOperator as PolicyCondition["operator"],
            })
          }
        >
          <SelectTrigger className="w-full h-9">
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
            <div className="flex items-center gap-2">
              <span className="text-sm truncate">{externalAgentIds[0]}</span>
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Info className="w-4 h-4 text-muted-foreground cursor-help shrink-0" />
                  </TooltipTrigger>
                  <TooltipContent>
                    <p>Only one external agent available</p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </div>
          ) : (
            <Select
              value={value || undefined}
              onValueChange={(newValue) =>
                onChange({ ...condition, value: newValue })
              }
            >
              <SelectTrigger className="w-full h-9">
                <SelectValue placeholder="Select agent" />
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
            <div className="flex items-center gap-2">
              <span className="text-sm truncate">{teams[0].name}</span>
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Info className="w-4 h-4 text-muted-foreground cursor-help shrink-0" />
                  </TooltipTrigger>
                  <TooltipContent>
                    <p>Only one team available</p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </div>
          ) : (
            <Select
              value={value || undefined}
              onValueChange={(newValue) =>
                onChange({ ...condition, value: newValue })
              }
            >
              <SelectTrigger className="w-full h-9">
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
            className="w-full h-9"
            initialValue={value}
            onChange={(newValue) => onChange({ ...condition, value: newValue })}
          />
        )}
      </div>
      {![CONTEXT_EXTERNAL_AGENT_ID, CONTEXT_TEAM_IDS].includes(
        argumentName,
      ) && <CaseSensitiveTooltip />}
      {removable && (
        <Button
          variant="ghost"
          size="sm"
          className="w-6 h-6 p-0 hover:text-red-500 shrink-0"
          onClick={onRemove}
          title="Remove condition"
          aria-label="Remove condition"
        >
          <X className="h-4 w-4" />
        </Button>
      )}
    </div>
  );
}
