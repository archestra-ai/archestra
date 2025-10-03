"use client";

import { ArrowRightIcon, Plus, Trash2Icon } from "lucide-react";
import { Suspense } from "react";
import type {
  GetToolInvocationPoliciesResponse,
  GetToolsResponses,
} from "shared/api-client";
import { ButtonWithTooltip } from "@/components/button-with-tooltip";
import { DebouncedInput } from "@/components/debounced-input";
import { LoadingSpinner } from "@/components/loading";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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
import { useToolPatchMutation, useTools } from "@/lib/tool.query";
import { formatDate } from "@/lib/utils";
import { ErrorBoundary } from "../_parts/error-boundary";

export function ToolsPage({
  initialData,
}: {
  initialData?: GetToolsResponses["200"];
}) {
  return (
    <div className="container mx-auto overflow-y-auto">
      <ErrorBoundary>
        <Suspense fallback={<LoadingSpinner />}>
          <Tools initialData={initialData} />
        </Suspense>
      </ErrorBoundary>
    </div>
  );
}

function Tools({ initialData }: { initialData?: GetToolsResponses["200"] }) {
  return (
    <div className="container mx-auto p-6">
      <h1 className="text-3xl font-bold mb-6">Tools</h1>
      <ToolsList initialData={initialData} />
    </div>
  );
}

function ToolsList({
  initialData,
}: {
  initialData?: GetToolsResponses["200"];
}) {
  const { data: tools } = useTools({ initialData });

  if (!tools?.length) {
    return <p className="text-muted-foreground">No tools found</p>;
  }

  return (
    <div className="space-y-4">
      {tools.map((tool) => (
        <ToolCard key={tool.id} tool={tool} />
      ))}
    </div>
  );
}

function ToolCard({ tool }: { tool: GetToolsResponses["200"][number] }) {
  return (
    <Card className="w-full">
      <CardHeader>
        <CardTitle className="text-lg">{tool.name}</CardTitle>
        <CardDescription>{tool.description}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <ToolReadonlyDetails tool={tool} />
        <ToolCallPolicies tool={tool} />
        <ToolResultPolicies />
      </CardContent>
    </Card>
  );
}

function ToolReadonlyDetails({
  tool,
}: {
  tool: GetToolsResponses["200"][number];
}) {
  return (
    <div
      className="grid gap-4"
      style={{ gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))" }}
    >
      <div>
        <CardTitle className="text-sm font-medium">Agent</CardTitle>
        <CardDescription>{tool.agentId}</CardDescription>
      </div>
      <div>
        <CardTitle className="text-sm font-medium">Created At</CardTitle>
        <CardDescription>
          {formatDate({ date: tool.createdAt })}
        </CardDescription>
      </div>
      <div>
        <CardTitle className="text-sm font-medium">Updated At</CardTitle>
        <CardDescription>
          {formatDate({ date: tool.updatedAt })}
        </CardDescription>
      </div>
      <div>
        <CardTitle className="text-sm font-medium">Parameters</CardTitle>
        {tool.parameters &&
        Object.keys(tool.parameters.properties || {}).length > 0 ? (
          <div className="flex flex-wrap gap-2 mt-2">
            {Object.entries(tool.parameters.properties || {}).map(
              ([key, value]) => {
                // @ts-expect-error
                const isRequired = tool.parameters?.required?.includes(key);
                return (
                  <div
                    key={key}
                    className="inline-flex items-center gap-1.5 bg-muted px-2 py-1 rounded border text-xs"
                  >
                    <code className="font-medium">{key}</code>
                    <Badge
                      variant={isRequired ? "default" : "outline"}
                      className="text-md h-3 p-2"
                    >
                      {value.type}
                    </Badge>
                    {isRequired && (
                      <Badge className="text-md h-3 p-2 bg-fuchsia-700 text-white">
                        required
                      </Badge>
                    )}
                  </div>
                );
              },
            )}
          </div>
        ) : (
          <CardDescription>None</CardDescription>
        )}
      </div>
    </div>
  );
}

function ToolCallPolicies({
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
              <ArrowRightIcon className="w-14 h-4" />
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

function ToolResultPolicies() {
  return (
    <div className="mt-4">
      <CardTitle className="flex flex-row items-center justify-between">
        <span>Tool Result Policies (after call)</span>
        <Button variant="outline" size="sm" className="bg-accent">
          <Plus /> Add
        </Button>
      </CardTitle>
      <CardDescription className="mb-4">
        Decide when to mark tool output as trusted or untrusted and whether to
        block it from further processing
      </CardDescription>
      <PolicyCard>
        <div className="flex flex-row items-center gap-4">
          <Badge
            variant="secondary"
            className="bg-blue-500 text-white dark:bg-blue-600"
          >
            Default
          </Badge>
          <span>TBD</span>
        </div>
      </PolicyCard>
    </div>
  );
}

function PolicyCard({ children }: { children: React.ReactNode }) {
  return (
    <Card className="mt-2 bg-muted p-4 flex flex-row items-center justify-between">
      {children}
    </Card>
  );
}
