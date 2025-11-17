"use client";

import type { archestraApiTypes } from "@shared";
import { useQueryClient } from "@tanstack/react-query";
import { Suspense, useEffect, useState } from "react";
import { LoadingSpinner } from "@/components/loading";
import {
  prefetchOperators,
  prefetchToolInvocationPolicies,
  prefetchToolResultPolicies,
} from "@/lib/policy.query";
import { ErrorBoundary } from "../_parts/error-boundary";
import { AssignedToolsTable } from "./_parts/assigned-tools-table";
import { ToolDetailsDialog } from "./_parts/tool-details-dialog";

type AgentToolData =
  archestraApiTypes.GetAllAgentToolsResponses["200"]["data"][number];

export function ToolsClient() {
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
          <ToolsList />
        </Suspense>
      </ErrorBoundary>
    </div>
  );
}

function ToolsList() {
  const queryClient = useQueryClient();
  const [selectedToolForDialog, setSelectedToolForDialog] =
    useState<AgentToolData | null>(null);

  // Sync selected tool with cache updates
  useEffect(() => {
    if (!selectedToolForDialog) return;

    const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
      if (
        event.type === "updated" &&
        event.query.queryKey[0] === "agent-tools"
      ) {
        const cachedData = queryClient.getQueryData<
          archestraApiTypes.GetAllAgentToolsResponses["200"]
        >(event.query.queryKey);

        const updatedTool = cachedData?.data.find(
          (tool) => tool.id === selectedToolForDialog.id,
        );

        if (updatedTool) {
          setSelectedToolForDialog(updatedTool);
        }
      }
    });

    return unsubscribe;
  }, [queryClient, selectedToolForDialog]);

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 md:px-8">
      <AssignedToolsTable onToolClick={setSelectedToolForDialog} />

      <ToolDetailsDialog
        agentTool={selectedToolForDialog}
        open={!!selectedToolForDialog}
        onOpenChange={(open: boolean) =>
          !open && setSelectedToolForDialog(null)
        }
      />
    </div>
  );
}
