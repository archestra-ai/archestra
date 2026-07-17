"use client";

import type { archestraApiTypes } from "@archestra/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { ErrorBoundary } from "@/app/_parts/error-boundary";
import { EditPolicyDialog } from "@/components/chat/edit-policy-dialog";
import { useDialogUrlParam } from "@/lib/hooks/use-dialog-url-param";
import {
  prefetchOperators,
  prefetchToolInvocationPolicies,
  prefetchToolResultPolicies,
} from "@/lib/policy.query";
import {
  type ToolWithAssignmentsData,
  useTool,
  useToolsWithAssignments,
} from "@/lib/tools/tool.query";
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
  const searchParams = useSearchParams();

  // The details dialog needs the assignments-enriched row, which the
  // single-tool endpoint does not return, so a deep-linked id resolves in two
  // steps: fetch the tool for its exact name, then find the id in the
  // assignments listing filtered by that name. Both queries stay idle until the
  // `view` param is present. Residual gap: a name contained in 50+ other tool
  // names can push the match past the page limit.
  const viewId = searchParams.get("view");
  const { data: viewTool } = useTool(viewId ?? undefined);
  const { data: viewCandidates } = useToolsWithAssignments({
    filters: { search: viewTool?.name },
    pagination: { limit: 50 },
    enabled: !!viewId && !!viewTool,
  });
  const selectedToolFromUrl = viewId
    ? (viewCandidates?.data.find((t) => t.id === viewId) ?? null)
    : null;

  const {
    entity: selectedToolForDialog,
    open: openToolDetails,
    close: closeToolDetails,
  } = useDialogUrlParam<ToolWithAssignmentsData>({
    paramName: "view",
    entityFromUrl: selectedToolFromUrl,
  });

  // Deep link from an external-client guardrail block: `?toolId=<id>` opens
  // that tool's policy editor directly. Some links also carry a companion
  // `&toolName=` param, cleared together with the id on close.
  const toolIdFromUrl = searchParams.get("toolId");
  const { data: policyEditorToolFromUrl } = useTool(toolIdFromUrl ?? undefined);
  const { entity: policyEditorTool, close: closePolicyEditor } =
    useDialogUrlParam({
      paramName: "toolId",
      entityFromUrl: policyEditorToolFromUrl ?? null,
      alsoClearOnClose: ["toolName"],
    });

  // Keep the open dialog's data in sync with assignments-listing refetches.
  // Synced data is held locally instead of re-calling open(), which would
  // rewrite the URL param on every cache update.
  const [syncedTool, setSyncedTool] = useState<ToolWithAssignmentsData | null>(
    null,
  );
  useEffect(() => {
    setSyncedTool(null);
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
          setSyncedTool(updatedTool);
        }
      }
    });

    return unsubscribe;
  }, [queryClient, selectedToolForDialog]);

  const dialogTool =
    syncedTool && syncedTool.id === selectedToolForDialog?.id
      ? syncedTool
      : selectedToolForDialog;

  return (
    <div>
      <AssignedToolsTable
        onToolClick={openToolDetails}
        initialData={initialData}
      />

      <ToolDetailsDialog
        tool={dialogTool}
        open={!!dialogTool}
        onOpenChange={(open: boolean) => !open && closeToolDetails()}
      />

      <EditPolicyDialog
        open={!!policyEditorTool}
        onOpenChange={(open: boolean) => {
          if (!open) closePolicyEditor();
        }}
        toolId={policyEditorTool?.id}
        toolName={policyEditorTool?.name ?? ""}
      />
    </div>
  );
}
