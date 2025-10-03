"use client";

import { Plus } from "lucide-react";
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
import { Switch } from "@/components/ui/switch";
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
        <ToolCallPolicies />
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
                      <Badge variant="destructive" className="text-md] h-3 p-2">
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

function ToolCallPolicies() {
  const [allowUntrusted, setAllowUntrusted] = useState(false);
  return (
    <div className="mt-4">
      <CardTitle className="mb-2 flex flex-row items-center justify-between">
        <span>Tool Call Policies (before call)</span>
        <Button variant="outline" size="sm" className="bg-accent">
          <Plus /> Add
        </Button>
      </CardTitle>
      <Card className="mt-2 bg-muted p-4 flex flex-row items-center justify-between">
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
      </Card>
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
      <Card className="mt-2 bg-muted p-4 flex flex-row items-center justify-between">
        <div className="flex flex-row items-center gap-4">
          <Badge
            variant="secondary"
            className="bg-blue-500 text-white dark:bg-blue-600"
          >
            Default
          </Badge>
          <span>TBD</span>
        </div>
      </Card>
    </div>
  );
}
