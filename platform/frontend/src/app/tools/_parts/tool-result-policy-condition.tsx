import type { archestraApiTypes } from "@shared";
import { toPath } from "lodash-es";
import { Info } from "lucide-react";
import { CaseSensitiveTooltip } from "@/components/case-sensitive-tooltip";
import { DebouncedInput } from "@/components/debounced-input";
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
import {
  useOperators,
  useToolResultPoliciesUpdateMutation,
} from "@/lib/policy.query";
import { useTeams } from "@/lib/team.query";

const CONTEXT_EXTERNAL_AGENT_ID = "context.externalAgentId";
const CONTEXT_TEAM_IDS = "context.teamIds";

type ToolResultPolicy =
  archestraApiTypes.GetTrustedDataPoliciesResponses["200"][number];

type KeyItem = {
  value: string;
  label: string;
};

export function ToolResultPolicyCondition({
  policy,
  keyItems,
}: {
  policy: ToolResultPolicy;
  keyItems: KeyItem[];
}) {
  const toolResultPoliciesUpdateMutation =
    useToolResultPoliciesUpdateMutation();
  const { data: operators } = useOperators();
  const { data: externalAgentIds } = useUniqueExternalAgentIds();
  const { data: teams } = useTeams();

  // Extract first condition (UI currently supports single condition)
  const condition = policy.conditions[0];
  const attributePath = condition?.key ?? "";
  const operator = condition?.operator ?? "equal";
  const value = condition?.value ?? "";

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-sm">If</span>
      <SearchableSelect
        placeholder="Attribute path"
        className="w-[180px]"
        value={attributePath}
        items={keyItems}
        allowCustom
        searchPlaceholder="Type attribute path..."
        showSearchIcon={false}
        onValueChange={(newAttributePath) => {
          // Auto-select value if only one option available
          let autoValue = "";
          if (
            newAttributePath === CONTEXT_EXTERNAL_AGENT_ID &&
            externalAgentIds.length === 1
          ) {
            autoValue = externalAgentIds[0];
          } else if (
            newAttributePath === CONTEXT_TEAM_IDS &&
            teams?.length === 1
          ) {
            autoValue = teams[0].id;
          }
          // Set default operator based on key type
          let defaultOperator = operator;
          if (newAttributePath === CONTEXT_TEAM_IDS) {
            defaultOperator = "contains";
          } else if (newAttributePath === CONTEXT_EXTERNAL_AGENT_ID) {
            defaultOperator = "equal";
          }
          toolResultPoliciesUpdateMutation.mutate({
            ...policy,
            attributePath: newAttributePath,
            value: autoValue,
            operator: defaultOperator,
          });
        }}
      />
      {!attributePath.startsWith("context.") &&
        !isValidPathSyntax(attributePath) && (
          <span className="text-red-500 text-sm">Invalid path</span>
        )}
      <Select
        value={operator}
        onValueChange={(newOperator: string) =>
          toolResultPoliciesUpdateMutation.mutate({
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
              toolResultPoliciesUpdateMutation.mutate({
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
              toolResultPoliciesUpdateMutation.mutate({
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
            toolResultPoliciesUpdateMutation.mutate({
              ...policy,
              value: newValue,
            })
          }
        />
      )}
      {![CONTEXT_EXTERNAL_AGENT_ID, CONTEXT_TEAM_IDS].includes(attributePath) && (
        <CaseSensitiveTooltip />
      )}
    </div>
  );
}

function isValidPathSyntax(path: string): boolean {
  const segments = toPath(path);
  // reject empty segments like "a..b"
  return segments.every((seg) => seg.length > 0);
}
