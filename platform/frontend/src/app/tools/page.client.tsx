"use client";

import type { archestraApiTypes } from "@shared";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import {
  prefetchOperators,
  prefetchToolInvocationPolicies,
  prefetchToolResultPolicies,
} from "@/lib/policy.query";
import type { ToolWithAssignmentsData } from "@/lib/tool.query";
import { ErrorBoundary } from "../_parts/error-boundary";
import { AssignedToolsTable } from "./_parts/assigned-tools-table";
import { ToolDetailsDialog } from "./_parts/tool-details-dialog";
import type { ToolsInitialData } from "./page";

export function ToolsClient({
  initialData,
}: {
  initialData?: ToolsInitialData;
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
        <ToolsList initialData={initialData} />
      </ErrorBoundary>
    </div>
  );
}

function ToolsList({ initialData }: { initialData?: ToolsInitialData }) {
  const queryClient = useQueryClient();
  const [selectedToolForDialog, setSelectedToolForDialog] =
    useState<ToolWithAssignmentsData | null>(null);

  // Sync selected tool with cache updates
  useEffect(() => {
    if (!selectedToolForDialog) return;

    const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
      if (
        event.type === "updated" &&
        event.query.queryKey[0] === "tools-with-assignments"
      ) {
        const cachedData = queryClient.getQueryData<
          archestraApiTypes.GetToolsWithAssignmentsResponses["200"]
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
    <div>
      <AssignedToolsTable
        onToolClick={setSelectedToolForDialog}
        initialData={initialData}
      />

      <ToolDetailsDialog
        tool={selectedToolForDialog}
        open={!!selectedToolForDialog}
        onOpenChange={(open: boolean) =>
          !open && setSelectedToolForDialog(null)
        }
      />
    </div>
  );
}
