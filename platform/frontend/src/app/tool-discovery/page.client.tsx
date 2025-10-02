"use client";

import { Suspense } from "react";
import type { GetToolsResponses } from "shared/api-client";
import { LoadingSpinner } from "@/components/loading";
import { useTools } from "@/lib/tool.query";
import { ErrorBoundary } from "../_parts/error-boundary";

export function ToolDiscoveryPage({
  initialData,
}: {
  initialData?: GetToolsResponses["200"];
}) {
  return (
    <div className="container mx-auto max-w-6xl overflow-y-auto">
      <ErrorBoundary>
        <Suspense fallback={<LoadingSpinner />}>
          <ToolDiscovery initialData={initialData} />
        </Suspense>
      </ErrorBoundary>
    </div>
  );
}

function ToolDiscovery({
  initialData,
}: {
  initialData?: GetToolsResponses["200"];
}) {
  const { data: tools } = useTools({ initialData });

  if (!tools) {
    return "Tools not found";
  }

  return (
    <div className="container mx-auto p-6">
      <h1 className="text-3xl font-bold mb-6">Tool Discovery</h1>
      <div className="space-y-4">
        {tools.map((tool) => (
          <ToolCard key={tool.id} tool={tool} />
        ))}
      </div>
    </div>
  );
}

import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { formatDate } from "@/lib/utils";

function ToolCard({ tool }: { tool: GetToolsResponses["200"][number] }) {
  return (
    <Card className="w-full max-w-lg">
      <CardHeader>
        <CardTitle className="text-lg">{tool.name}</CardTitle>
        <CardDescription>{tool.description}</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="space-y-2">
          <div>
            <CardTitle className="text-sm">Agent</CardTitle>
            <CardDescription>{tool.agentId}</CardDescription>
          </div>
          <div>
            <CardTitle className="text-sm">Created At</CardTitle>
            <CardDescription>
              {formatDate({ date: tool.createdAt })}
            </CardDescription>
          </div>
          <div>
            <CardTitle className="text-sm">Updated At</CardTitle>
            <CardDescription>
              {formatDate({ date: tool.updatedAt })}
            </CardDescription>
          </div>
          <div>
            <CardTitle className="text-sm">Parameters</CardTitle>
            {tool.parameters &&
            Object.keys(tool.parameters.properties || {}).length > 0 ? (
              <div className="flex flex-wrap gap-1.5 mt-2">
                {Object.entries(tool.parameters.properties || {}).map(
                  ([key, value]) => {
                    // @ts-expect-error
                    const isRequired = tool.parameters?.required?.includes(key);
                    return (
                      <div
                        key={key}
                        className="inline-flex items-center gap-1.5 bg-muted px-3 py-1.5 rounded border"
                      >
                        <code className="text-xs font-medium">{key}</code>
                        <Badge
                          variant={isRequired ? "default" : "outline"}
                          className="text-[12px] h-4 px-1"
                        >
                          {value.type}
                        </Badge>
                        {isRequired && (
                          <Badge
                            variant="destructive"
                            className="text-[12px] h-4 px-1"
                          >
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
      </CardContent>
    </Card>
  );
}
