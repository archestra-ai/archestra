"use client";

import { Suspense } from "react";
import type { GetToolsResponses } from "shared/api-client";
import { LoadingSpinner } from "@/components/loading";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { useTools } from "@/lib/tool.query";
import { ErrorBoundary } from "../_parts/error-boundary";
import { ToolCallPolicies } from "./_parts/tool-call-policies";
import { ToolReadonlyDetails } from "./_parts/tool-readonly-details";
import { ToolResultPolicies } from "./_parts/tool-result-policies";

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
        <ToolResultPolicies tool={tool} />
      </CardContent>
    </Card>
  );
}
