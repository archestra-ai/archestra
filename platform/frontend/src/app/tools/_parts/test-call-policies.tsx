import { ArrowRightIcon, Plus, Trash2Icon } from "lucide-react";
import type {
  GetToolInvocationPoliciesResponse,
  GetToolsResponses,
} from "shared/api-client";
import { ButtonWithTooltip } from "@/components/button-with-tooltip";
import { DebouncedInput } from "@/components/debounced-input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CardDescription, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
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
    <div className="mt-4">
      <CardTitle className="flex flex-row items-center justify-between">
        <span>Tool Call Policies (before call)</span>
        <ButtonWithTooltip
          variant="outline"
          size="sm"
          className="bg-accent"
          onClick={() =>
            toolInvocationPolicyCreateMutation.mutate({ toolId: tool.id })
          }
          disabled={Object.keys(tool.parameters?.properties || {}).length === 0}
          disabledText="Custom policies require parameters"
        >
          <Plus /> Add
        </ButtonWithTooltip>
      </CardTitle>
      <CardDescription className="mb-4">
        Decide whether to allow or block tool calling when untrusted data is
        present
      </CardDescription>
      <PolicyCard>
        <div className="flex flex-row items-center gap-4">
          <Badge
            variant="secondary"
            className="bg-blue-500 text-white dark:bg-blue-600"
          >
            Default
          </Badge>
          <span>Allow usage when untrusted data is present</span>
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
      </PolicyCard>
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
                initialValue={policy.value}
                onChange={(value) =>
                  toolInvocationPolicyUpdateMutation.mutate({
                    ...policy,
                    value,
                  })
                }
              />
              <ArrowRightIcon className="w-4 h-4" />
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
