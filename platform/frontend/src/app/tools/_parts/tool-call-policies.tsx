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
import {
  useOperators,
  useToolInvocationPolicies,
  useToolInvocationPolicyCreateMutation,
  useToolInvocationPolicyDeleteMutation,
  useToolInvocationPolicyUpdateMutation,
} from "@/lib/policy.query";
import { PolicyCard } from "./policy-card";

type Condition = {
  key: string;
  operator: string;
  value: string;
};

function getFirstCondition(conditions: unknown): Condition {
  if (Array.isArray(conditions) && conditions.length > 0) {
    const first = conditions[0];
    if (
      typeof first === "object" &&
      first !== null &&
      "key" in first &&
      "operator" in first &&
      "value" in first
    ) {
      return first as Condition;
    }
  }
  return { key: "", operator: "equal", value: "" };
}

function isDefaultPolicy(conditions: unknown): boolean {
  return !Array.isArray(conditions) || conditions.length === 0;
}

export function ToolCallPolicies({
  agentTool,
}: {
  agentTool: archestraApiTypes.GetAllAgentToolsResponses["200"]["data"][number];
}) {
  const {
    data: { byToolId },
  } = useToolInvocationPolicies();
  const toolInvocationPolicyCreateMutation =
    useToolInvocationPolicyCreateMutation();
  const toolInvocationPolicyDeleteMutation =
    useToolInvocationPolicyDeleteMutation();
  const toolInvocationPolicyUpdateMutation =
    useToolInvocationPolicyUpdateMutation();
  const { data: operators } = useOperators();

  // Policies are now per-tool, not per-agent-tool
  const allPolicies = byToolId[agentTool.tool.id] || [];

  // Separate default policies (empty conditions) from specific policies
  const defaultPolicy = allPolicies.find((p) => isDefaultPolicy(p.conditions));
  const specificPolicies = allPolicies.filter(
    (p) => !isDefaultPolicy(p.conditions),
  );

  const argumentNames = Object.keys(
    agentTool.tool.parameters?.properties || [],
  );

  return (
    <div className="border border-border rounded-lg p-6 bg-card space-y-4">
      <div>
        <h3 className="text-sm font-semibold mb-1">Tool Call Policies</h3>
        <p className="text-sm text-muted-foreground">
          Can tool be used when untrusted data is present in the context?
        </p>
      </div>

      {/* Default Policy Section */}
      <div className="flex items-center justify-between p-3 bg-muted/50 rounded-md border border-border">
        <div className="flex items-center gap-3">
          <div className="text-xs font-medium text-muted-foreground">
            DEFAULT
          </div>
          <span className="text-sm">When no specific rule matches</span>
        </div>
        <Select
          value={defaultPolicy?.action || "block_when_untrusted"}
          onValueChange={(
            value: "allow_when_context_is_untrusted" | "block_always",
          ) => {
            if (defaultPolicy) {
              toolInvocationPolicyUpdateMutation.mutate({
                id: defaultPolicy.id,
                action: value,
              });
            } else {
              // Create a default policy with empty conditions
              toolInvocationPolicyCreateMutation.mutate(
                { toolId: agentTool.tool.id },
                {
                  onSuccess: (result) => {
                    if (result.data) {
                      toolInvocationPolicyUpdateMutation.mutate({
                        id: result.data.id,
                        conditions: [],
                        action: value,
                      });
                    }
                  },
                },
              );
            }
          }}
        >
          <SelectTrigger className="w-[240px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="allow_when_context_is_untrusted">
              Allow when untrusted data present
            </SelectItem>
            <SelectItem value="block_always">Block always</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Specific Policies */}
      {specificPolicies.map((policy) => {
        const condition = getFirstCondition(policy.conditions);
        return (
          <PolicyCard key={policy.id}>
            <div className="flex flex-col gap-3 w-full">
              <div className="flex items-center justify-between">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm">If</span>
                  <Select
                    defaultValue={condition.key}
                    onValueChange={(value) => {
                      toolInvocationPolicyUpdateMutation.mutate({
                        id: policy.id,
                        conditions: [{ ...condition, key: value }],
                      });
                    }}
                  >
                    <SelectTrigger className="w-[140px]">
                      <SelectValue placeholder="parameter" />
                    </SelectTrigger>
                    <SelectContent>
                      {argumentNames.map((argumentName) => (
                        <SelectItem key={argumentName} value={argumentName}>
                          {argumentName}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Select
                    defaultValue={condition.operator}
                    onValueChange={(value) =>
                      toolInvocationPolicyUpdateMutation.mutate({
                        id: policy.id,
                        conditions: [{ ...condition, operator: value }],
                      })
                    }
                  >
                    <SelectTrigger className="w-[120px]">
                      <SelectValue placeholder="Operator" />
                    </SelectTrigger>
                    <SelectContent>
                      {operators.map((operator) => (
                        <SelectItem key={operator.value} value={operator.value}>
                          {operator.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <DebouncedInput
                    placeholder="Value"
                    className="w-[120px]"
                    initialValue={condition.value}
                    onChange={(value) =>
                      toolInvocationPolicyUpdateMutation.mutate({
                        id: policy.id,
                        conditions: [{ ...condition, value }],
                      })
                    }
                  />
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
                    value: "allow_when_context_is_untrusted" | "block_always",
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
        );
      })}
      <ButtonWithTooltip
        variant="outline"
        className="w-full"
        onClick={() =>
          toolInvocationPolicyCreateMutation.mutate({
            toolId: agentTool.tool.id,
          })
        }
        disabled={
          Object.keys(agentTool.tool.parameters?.properties || {}).length === 0
        }
        disabledText="This tool has no parameters"
      >
        <Plus className="w-3.5 h-3.5 mr-1" /> Add Policy For Tool Parameters
      </ButtonWithTooltip>
    </div>
  );
}
