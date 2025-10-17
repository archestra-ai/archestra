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
import type {
  GetToolInvocationPoliciesResponse,
  GetToolsResponses,
} from "@/lib/clients/api";
import {
  useOperators,
  useToolInvocationPolicies,
  useToolInvocationPolicyCreateMutation,
  useToolInvocationPolicyDeleteMutation,
  useToolInvocationPolicyUpdateMutation,
} from "@/lib/policy.query";
import { useToolPatchMutation } from "@/lib/tool.query";
import { PolicyCard } from "./policy-card";

export function ToolCallPolicies({
  tool,
}: {
  tool: GetToolsResponses["200"][number];
}) {
  const {
    data: { byToolId },
  } = useToolInvocationPolicies();
  const toolPatchMutation = useToolPatchMutation();
  const toolInvocationPolicyCreateMutation =
    useToolInvocationPolicyCreateMutation();
  const toolInvocationPolicyDeleteMutation =
    useToolInvocationPolicyDeleteMutation();
  const toolInvocationPolicyUpdateMutation =
    useToolInvocationPolicyUpdateMutation();
  const { data: operators } = useOperators();

  const policies = byToolId[tool.id] || [];

  const argumentNames = Object.keys(tool.parameters?.properties || []);

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
          checked={tool.allowUsageWhenUntrustedDataIsPresent}
          onCheckedChange={() =>
            toolPatchMutation.mutate({
              id: tool.id,
              allowUsageWhenUntrustedDataIsPresent:
                !tool.allowUsageWhenUntrustedDataIsPresent,
            })
          }
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
                    toolInvocationPolicyUpdateMutation.mutate({
                      ...policy,
                      argumentName: value,
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
                  defaultValue={policy.operator}
                  onValueChange={(
                    value: GetToolInvocationPoliciesResponse["200"]["operator"],
                  ) =>
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
                  initialValue={policy.value}
                  onChange={(value) =>
                    toolInvocationPolicyUpdateMutation.mutate({
                      ...policy,
                      value,
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
                  value: GetToolInvocationPoliciesResponse["200"]["action"],
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
          toolInvocationPolicyCreateMutation.mutate({ toolId: tool.id })
        }
        disabled={Object.keys(tool.parameters?.properties || {}).length === 0}
        disabledText="This tool has no parameters"
      >
        <Plus className="w-3.5 h-3.5 mr-1" /> Add policy for tool parameters
      </ButtonWithTooltip>
    </div>
  );
}
