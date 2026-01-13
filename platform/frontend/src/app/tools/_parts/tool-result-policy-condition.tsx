import { toPath } from "lodash-es";
import { Info, X } from "lucide-react";
import { CaseSensitiveTooltip } from "@/components/case-sensitive-tooltip";
import { DebouncedInput } from "@/components/debounced-input";
import { Button } from "@/components/ui/button";
import { SearchableSelect } from "@/components/ui/searchable-select";
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

const CONTEXT_EXTERNAL_AGENT_ID = "context.externalAgentId";
const CONTEXT_TEAM_IDS = "context.teamIds";

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

type KeyItem = {
  value: string;
  label: string;
};

export function ToolResultPolicyCondition({
  condition,
  keyItems,
  removable,
  onChange,
  onRemove,
}: {
  condition: PolicyCondition;
  keyItems: KeyItem[];
  removable: boolean;
  onChange: (condition: PolicyCondition) => void;
  onRemove: () => void;
}) {
  const { data: operators } = useOperators();
  const { data: externalAgentIds } = useUniqueExternalAgentIds();
  const { data: teams } = useTeams();

  const { key: attributePath, operator, value } = condition;

  const handleKeyChange = (newAttributePath: string) => {
    // Auto-select value if only one option available
    let autoValue = "";
    if (
      newAttributePath === CONTEXT_EXTERNAL_AGENT_ID &&
      externalAgentIds.length === 1
    ) {
      autoValue = externalAgentIds[0];
    } else if (newAttributePath === CONTEXT_TEAM_IDS && teams?.length === 1) {
      autoValue = teams[0].id;
    }
    // Set default operator based on key type
    let defaultOperator = operator;
    if (newAttributePath === CONTEXT_TEAM_IDS) {
      defaultOperator = "contains";
    } else if (newAttributePath === CONTEXT_EXTERNAL_AGENT_ID) {
      defaultOperator = "equal";
    }
    onChange({
      key: newAttributePath,
      operator: defaultOperator,
      value: autoValue,
    });
  };

  return (
    <div className="flex items-center gap-2 rounded-md bg-muted/50 px-3 py-2 whitespace-nowrap">
      <SearchableSelect
        placeholder="Attribute path"
        className="w-[140px]"
        value={attributePath}
        items={keyItems}
        allowCustom
        searchPlaceholder="Type attribute path..."
        showSearchIcon={false}
        onValueChange={handleKeyChange}
      />
      {!attributePath.startsWith("context.") &&
        !isValidPathSyntax(attributePath) && (
          <span className="text-red-500 text-sm">Invalid path</span>
        )}
      <Select
        value={operator}
        onValueChange={(newOperator) =>
          onChange({
            ...condition,
            operator: newOperator as PolicyCondition["operator"],
          })
        }
      >
        <SelectTrigger className="w-[140px] h-9">
          <SelectValue placeholder="Operator" />
        </SelectTrigger>
        <SelectContent>
          {operators
            .filter((op) => {
              if (attributePath === CONTEXT_EXTERNAL_AGENT_ID) {
                return ["equal", "notEqual"].includes(op.value);
              }
              if (attributePath === CONTEXT_TEAM_IDS) {
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
      {attributePath === CONTEXT_EXTERNAL_AGENT_ID ? (
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
              onChange({ ...condition, value: newValue })
            }
          >
            <SelectTrigger className="w-[140px] h-9">
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
      ) : attributePath === CONTEXT_TEAM_IDS ? (
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
              onChange({ ...condition, value: newValue })
            }
          >
            <SelectTrigger className="w-[140px] h-9">
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
          className="w-[140px] h-9"
          initialValue={value}
          onChange={(newValue) => onChange({ ...condition, value: newValue })}
        />
      )}
      {![CONTEXT_EXTERNAL_AGENT_ID, CONTEXT_TEAM_IDS].includes(
        attributePath,
      ) && <CaseSensitiveTooltip />}
      {removable && (
        <Button
          variant="ghost"
          size="sm"
          className="w-6 h-6 p-0 hover:text-red-500"
          onClick={onRemove}
          title="Remove condition"
        >
          <X className="h-4 w-4" />
        </Button>
      )}
    </div>
  );
}

function isValidPathSyntax(path: string): boolean {
  const segments = toPath(path);
  // reject empty segments like "a..b"
  return segments.every((seg) => seg.length > 0);
}
