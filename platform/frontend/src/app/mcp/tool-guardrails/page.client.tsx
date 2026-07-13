"use client";

import type { archestraApiTypes } from "@archestra/shared";
import { useQueryClient } from "@tanstack/react-query";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { ErrorBoundary } from "@/app/_parts/error-boundary";
import { EditPolicyDialog } from "@/components/chat/edit-policy-dialog";
import {
  prefetchOperators,
  prefetchToolInvocationPolicies,
  prefetchToolResultPolicies,
} from "@/lib/policy.query";
import type { ToolWithAssignmentsData } from "@/lib/tools/tool.query";
import { AssignedToolsTable } from "./_parts/assigned-tools-table";
import { ToolDetailsDialog } from "./_parts/tool-details-dialog";
import type { ToolsInitialData } from "./types";

export function ToolGuardrailsClient({
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
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [selectedToolForDialog, setSelectedToolForDialog] =
    useState<ToolWithAssignmentsData | null>(null);

  // Deep link from an external-client guardrail block: `?toolId=<id>` opens
  // that tool's policy editor directly (name is only for the dialog title).
  const deepLinkToolId = searchParams.get("toolId");
  const deepLinkToolName = searchParams.get("toolName") ?? "";

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

      <EditPolicyDialog
        open={!!deepLinkToolId}
        onOpenChange={(open: boolean) => {
          // Closing clears the deep-link params so the dialog does not reopen.
          if (!open) {
            router.replace(pathname);
          }
        }}
        toolId={deepLinkToolId ?? undefined}
        toolName={deepLinkToolName}
      />
    </div>
  );
}
