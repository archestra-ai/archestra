"use client";

import { ArrowRightIcon, Plus, Trash2Icon } from "lucide-react";
import { Suspense, useState } from "react";
import type { GetToolsResponses } from "shared/api-client";
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
import { Input } from "@/components/ui/input";
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
} from "@/lib/policy.query";
import { useTools } from "@/lib/tool.query";
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
  const [allowUntrusted, setAllowUntrusted] = useState(false);
  const {
    data: { byToolId },
  } = useToolInvocationPolicies();
  const toolInvocationPolicyCreateMutation =
    useToolInvocationPolicyCreateMutation();
  const toolInvocationPolicyDeleteMutation =
    useToolInvocationPolicyDeleteMutation();
  const { data: operators } = useOperators();

  const policies = byToolId[tool.id] || [];

  return (
    <div className="mt-4">
      <CardTitle className="mb-2 flex flex-row items-center justify-between">
        <span>Tool Call Policies (before call)</span>
        <Button
          variant="outline"
          size="sm"
          className="bg-accent"
          onClick={() =>
            toolInvocationPolicyCreateMutation.mutate({ toolId: tool.id })
          }
        >
          <Plus /> Add
        </Button>
      </CardTitle>
      <PolicyCard>
        <div className="flex flex-row items-center gap-4">
          <Badge
            variant="secondary"
            className="bg-blue-500 text-white dark:bg-blue-600"
          >
            Default
          </Badge>
          <span>Allowed for untrusted</span>
        </div>
        <Switch
          checked={allowUntrusted}
          onCheckedChange={() => setAllowUntrusted(!allowUntrusted)}
        />
      </PolicyCard>
      {policies.map((policy) => (
        <PolicyCard key={policy.id}>
          <div className="flex flex-row gap-4 justify-between w-full">
            <div className="flex flex-row items-center gap-4">
              If
              <Input defaultValue={policy.argumentName} />
              <Select defaultValue={policy.operator}>
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
              <Input defaultValue={policy.value} />
              <ArrowRightIcon className="w-14 h-4" />
              <Select defaultValue={"false"}>
                <SelectTrigger className="w-[240px]">
                  <SelectValue placeholder="Allowed for" />
                </SelectTrigger>
                <SelectContent>
                  {[
                    { value: "true", label: "Allowed for untrusted: True" },
                    { value: "false", label: "Allowed for untrusted: False" },
                  ].map(({ value, label }) => (
                    <SelectItem key={label} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
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
      <CardTitle className="mb-2 flex flex-row items-center justify-between">
        <span>Tool Result Policies (after call)</span>
        <Button variant="outline" size="sm" className="bg-accent">
          <Plus /> Add
        </Button>
      </CardTitle>
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
