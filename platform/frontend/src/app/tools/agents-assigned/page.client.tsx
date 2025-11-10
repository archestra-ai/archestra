"use client";

import type { archestraApiTypes } from "@shared";
import { useQueryClient } from "@tanstack/react-query";
import { Suspense, useEffect, useState } from "react";
import { LoadingSpinner } from "@/components/loading";
import { useAllAgentTools } from "@/lib/agent-tools.query";
import {
  prefetchOperators,
  prefetchToolInvocationPolicies,
  prefetchToolResultPolicies,
} from "@/lib/policy.query";
import { ErrorBoundary } from "../../_parts/error-boundary";
import { AssignedToolsList } from "../_parts/assigned-tools-list";
import { ToolDetailsDialog } from "../_parts/tool-details-dialog";

type AgentToolData = archestraApiTypes.GetAllAgentToolsResponses["200"][number];

export function AgentsAssignedClient({
  initialData,
}: {
  initialData?: AgentToolData[];
}) {
  const queryClient = useQueryClient();

  // Prefetch policy data on mount
  useEffect(() => {
    prefetchOperators(queryClient);
    prefetchToolInvocationPolicies(queryClient);
    prefetchToolResultPolicies(queryClient);
  }, [queryClient]);

  return (
    <div className="w-full h-full">
      <ErrorBoundary>
        <Suspense fallback={<LoadingSpinner className="mt-[30vh]" />}>
          <AgentsAssignedList initialData={initialData} />
        </Suspense>
      </ErrorBoundary>
    </div>
  );
}

function AgentsAssignedList({
  initialData,
}: {
  initialData?: AgentToolData[];
}) {
  const { data: agentTools } = useAllAgentTools({
    initialData,
  });

  const [selectedToolForDialog, setSelectedToolForDialog] =
    useState<AgentToolData | null>(null);

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 md:px-8">
      <AssignedToolsList
        agentTools={agentTools || []}
        onToolClick={setSelectedToolForDialog}
      />

      <ToolDetailsDialog
        agentTool={
          selectedToolForDialog
            ? agentTools?.find((t) => t.id === selectedToolForDialog.id) ||
              selectedToolForDialog
            : null
        }
        open={!!selectedToolForDialog}
        onOpenChange={(open: boolean) =>
          !open && setSelectedToolForDialog(null)
        }
      />
    </div>
  );
}
