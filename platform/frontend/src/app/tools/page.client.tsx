"use client";

import type { GetToolsResponses } from "@shared/api-client";
import { useQueryClient } from "@tanstack/react-query";
import { Suspense, useEffect, useState } from "react";
import { LoadingSpinner } from "@/components/loading";
import {
  prefetchOperators,
  prefetchToolInvocationPolicies,
  prefetchToolResultPolicies,
} from "@/lib/policy.query";
import { useTools } from "@/lib/tool.query";
import { cn } from "@/lib/utils";
import { ErrorBoundary } from "../_parts/error-boundary";
import { ToolCallPolicies } from "./_parts/tool-call-policies";
import { ToolReadonlyDetails } from "./_parts/tool-readonly-details";
import { ToolResultPolicies } from "./_parts/tool-result-policies";

export function ToolsPage({
  initialData,
}: {
  initialData?: GetToolsResponses["200"];
}) {
  const queryClient = useQueryClient();

  // Prefetch policy data on mount
  useEffect(() => {
    prefetchOperators(queryClient);
    prefetchToolInvocationPolicies(queryClient);
    prefetchToolResultPolicies(queryClient);
  }, [queryClient]);

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
    <div className="w-full h-full">
      {/* Page header */}
      <div className="border-b border-border bg-card/30">
        <div className="max-w-7xl mx-auto px-8 py-8">
          <h1 className="text-2xl font-semibold tracking-tight mb-2">Tools</h1>
          <p className="text-sm text-muted-foreground">
            Manage and configure tool policies
          </p>
        </div>
      </div>

      {/* Content */}
      <div className="max-w-7xl mx-auto px-8 py-8">
        <ToolsList initialData={initialData} />
      </div>
    </div>
  );
}

function ToolsList({
  initialData,
}: {
  initialData?: GetToolsResponses["200"];
}) {
  const { data: tools } = useTools({ initialData });
  const [selectedToolId, setSelectedToolId] = useState<string | null>(null);

  if (!tools?.length) {
    return <p className="text-muted-foreground">No tools found</p>;
  }

  const selectedTool = tools.find((tool) => tool.id === selectedToolId);

  return (
    <div className="space-y-6">
      {/* Tool selector */}
      <div>
        <div className="text-xs font-medium text-muted-foreground mb-3">
          AVAILABLE TOOLS
        </div>
        <div className="flex flex-wrap gap-2">
          {tools.map((tool) => {
            const isSafe =
              tool.allowUsageWhenUntrustedDataIsPresent &&
              tool.dataIsTrustedByDefault;
            const isSelected = tool.id === selectedToolId;

            return (
              <button
                key={tool.id}
                type="button"
                className={cn(
                  "px-3 py-1.5 text-sm font-medium rounded-md transition-all border",
                  "focus:outline-none focus:ring-2 focus:ring-offset-2",
                  isSafe
                    ? "bg-emerald-50 border-emerald-200 text-emerald-700 hover:bg-emerald-100 dark:bg-emerald-950/50 dark:border-emerald-800 dark:text-emerald-300"
                    : "bg-red-50 border-red-200 text-red-700 hover:bg-red-100 dark:bg-red-950/50 dark:border-red-800 dark:text-red-300",
                  isSelected && isSafe && "ring-2 ring-emerald-500",
                  isSelected && !isSafe && "ring-2 ring-red-500",
                )}
                onClick={() => setSelectedToolId(isSelected ? null : tool.id)}
              >
                {tool.name}
                <span className="opacity-70"> ({tool.agent.name})</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Selected Tool Details */}
      {selectedTool ? (
        <ToolCard tool={selectedTool} />
      ) : (
        <div className="border border-dashed border-border rounded-lg p-12 text-center">
          <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-muted/50 mb-3">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              fill="none"
              viewBox="0 0 24 24"
              strokeWidth={1.5}
              stroke="currentColor"
              className="w-6 h-6 text-muted-foreground"
              role="img"
              aria-label="Tools icon"
            >
              <title>Tools</title>
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M11.42 15.17 17.25 21A2.652 2.652 0 0 0 21 17.25l-5.877-5.877M11.42 15.17l2.496-3.03c.317-.384.74-.626 1.208-.766M11.42 15.17l-4.655 5.653a2.548 2.548 0 1 1-3.586-3.586l6.837-5.63m5.108-.233c.55-.164 1.163-.188 1.743-.14a4.5 4.5 0 0 0 4.486-6.336l-3.276 3.277a3.004 3.004 0 0 1-2.25-2.25l3.276-3.276a4.5 4.5 0 0 0-6.336 4.486c.091 1.076-.071 2.264-.904 2.95l-.102.085m-1.745 1.437L5.909 7.5H4.5L2.25 3.75l1.5-1.5L7.5 4.5v1.409l4.26 4.26m-1.745 1.437 1.745-1.437m6.615 8.206L15.75 15.75M4.867 19.125h.008v.008h-.008v-.008Z"
              />
            </svg>
          </div>
          <p className="text-sm text-muted-foreground">
            Select a tool to view its configuration and policies
          </p>
        </div>
      )}
    </div>
  );
}

function ToolCard({ tool }: { tool: GetToolsResponses["200"][number] }) {
  return (
    <div className="space-y-6">
      {/* Tool header */}
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-xl font-semibold tracking-tight mb-1">
            {tool.name}
          </h2>
          {tool.description && (
            <p className="text-sm text-muted-foreground">{tool.description}</p>
          )}
        </div>
      </div>

      {/* Tool information */}
      <ToolReadonlyDetails tool={tool} />

      {/* Policies */}
      <div className="space-y-6">
        <ToolCallPolicies tool={tool} />
        <ToolResultPolicies tool={tool} />
      </div>
    </div>
  );
}
