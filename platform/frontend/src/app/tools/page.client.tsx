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
  const [selectedToolForDialog, setSelectedToolForDialog] =
    useState<AgentToolData | null>(null);

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
