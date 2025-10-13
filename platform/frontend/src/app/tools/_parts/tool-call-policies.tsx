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
      <div className="flex flex-row items-start justify-between">
        <div>
          <h3 className="text-sm font-semibold mb-1">Tool Call Policies</h3>
          <p className="text-sm text-muted-foreground">
            Control execution when untrusted data is present.
            <br />
            <br />
            By default, when the LLM your agent is interacting with has consumed
            "untrusted data", tool execution is not permitted, unless explicit
            policies have been configured for this tool. You have the open to
            either:
          </p>
          <ul className="text-sm text-muted-foreground">
            <li>• Allow usage, by default, when untrusted data is present</li>
            <li>
              • Allow usage, but only when the tool is invoked with argument(s)
              that meet the policy's criteria
            </li>
          </ul>
        </div>
        <ButtonWithTooltip
          variant="outline"
          size="sm"
          className="h-8 text-xs"
          onClick={() =>
            toolInvocationPolicyCreateMutation.mutate({ toolId: tool.id })
          }
          disabled={Object.keys(tool.parameters?.properties || {}).length === 0}
          disabledText="This tool has no parameters"
        >
          <Plus className="w-3.5 h-3.5" /> Add policy for tool parameters
        </ButtonWithTooltip>
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
          <div className="flex flex-row gap-4 justify-between w-full">
            <div className="flex flex-row items-center gap-4">
              If
              <Select
                defaultValue={policy.argumentName}
                onValueChange={(value) => {
                  toolInvocationPolicyUpdateMutation.mutate({
                    ...policy,
                    argumentName: value,
                  });
                }}
              >
                <SelectTrigger className="w-[180px]">
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
                <SelectTrigger className="w-[180px]">
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
                initialValue={policy.value}
                onChange={(value) =>
                  toolInvocationPolicyUpdateMutation.mutate({
                    ...policy,
                    value,
                  })
                }
              />
              <ArrowRightIcon className="w-4 h-4 shrink-0" />
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
                  <SelectValue placeholder="Allowed for" />
                </SelectTrigger>
                <SelectContent>
                  {[
                    {
                      value: "allow_when_context_is_untrusted",
                      label: "Allow usage when untrusted data is present",
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
                initialValue={policy.reason || ""}
                onChange={(value) =>
                  toolInvocationPolicyUpdateMutation.mutate({
                    ...policy,
                    reason: value,
                  })
                }
              />
            </div>
            <Button
              variant="ghost"
              size="sm"
              className="hover:text-red-500"
              onClick={() =>
                toolInvocationPolicyDeleteMutation.mutate(policy.id)
              }
            >
              <Trash2Icon />
            </Button>
          </div>
        </PolicyCard>
      ))}
    </div>
  );
}
