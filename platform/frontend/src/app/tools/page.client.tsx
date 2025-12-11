"use client";

import type { archestraApiTypes } from "@shared";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import {
  prefetchOperators,
  prefetchToolInvocationPolicies,
  prefetchToolResultPolicies,
} from "@/lib/policy.query";
import { ErrorBoundary } from "../_parts/error-boundary";
import { AssignedToolsTable } from "./_parts/assigned-tools-table";
import { ToolDetailsDialog } from "./_parts/tool-details-dialog";

type ProfileToolData =
  archestraApiTypes.GetAllAgentToolsResponses["200"]["data"][number];

export function ToolsClient({
  initialAgentTools,
  initialAgents,
  initialInternalMcpCatalog,
}: {
  initialAgentTools?: archestraApiTypes.GetAllAgentToolsResponses["200"];
  initialAgents?: archestraApiTypes.GetAllAgentsResponses["200"];
  initialInternalMcpCatalog?: archestraApiTypes.GetInternalMcpCatalogResponses["200"];
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
        <ToolsList
          initialAgentTools={initialAgentTools}
          initialAgents={initialAgents}
          initialInternalMcpCatalog={initialInternalMcpCatalog}
        />
      </ErrorBoundary>
    </div>
  );
}

function ToolsList({
  initialAgentTools,
  initialAgents,
  initialInternalMcpCatalog,
}: {
  initialAgentTools?: archestraApiTypes.GetAllAgentToolsResponses["200"];
  initialAgents?: archestraApiTypes.GetAllAgentsResponses["200"];
  initialInternalMcpCatalog?: archestraApiTypes.GetInternalMcpCatalogResponses["200"];
}) {
  const queryClient = useQueryClient();
  const [selectedToolForDialog, setSelectedToolForDialog] =
    useState<ProfileToolData | null>(null);

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
    <div>
      <AssignedToolsTable
        onToolClick={setSelectedToolForDialog}
        initialAgentTools={initialAgentTools}
        initialAgents={initialAgents}
        initialInternalMcpCatalog={initialInternalMcpCatalog}
      />

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
