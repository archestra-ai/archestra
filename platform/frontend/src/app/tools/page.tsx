"use client";

import type { archestraApiTypes } from "@shared";
import { useQueryClient } from "@tanstack/react-query";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";

import { LoadingSpinner } from "@/components/loading";
import { useAgents } from "@/lib/agent.query";
import {
  prefetchOperators,
  prefetchToolInvocationPolicies,
  prefetchToolResultPolicies,
} from "@/lib/policy.query";
import { useTools } from "@/lib/tool.query";

import { ErrorBoundary } from "../_parts/error-boundary";
import { McpToolsDialog } from "../mcp-catalog/_parts/mcp-tools-dialog";
import { ToolsTable } from "./_parts/tools-table";

type ExtendedTool = archestraApiTypes.GetToolsResponses["200"][number];

export default function ToolsPage() {
  return (
    <div className="w-full h-full">
      <ErrorBoundary>
        <Suspense fallback={<LoadingSpinner className="mt-[30vh]" />}>
          <ToolsContent />
        </Suspense>
      </ErrorBoundary>
    </div>
  );
}

function ToolsContent() {
  const queryClient = useQueryClient();
  const { data: tools } = useTools({});
  const { data: agents } = useAgents({});

  const [selectedToolsForAssignment, setSelectedToolsForAssignment] = useState<
    ExtendedTool[]
  >([]);
  const [assignmentDialogOpen, setAssignmentDialogOpen] = useState(false);

  // Prefetch policy data on mount
  useEffect(() => {
    prefetchOperators(queryClient);
    prefetchToolInvocationPolicies(queryClient);
    prefetchToolResultPolicies(queryClient);
  }, [queryClient]);

  const handleBulkAssignTools = useCallback((selectedTools: ExtendedTool[]) => {
    setSelectedToolsForAssignment(selectedTools);
    setAssignmentDialogOpen(true);
  }, []);

  const handleAssignmentDialogClose = useCallback((open: boolean) => {
    setAssignmentDialogOpen(open);
    if (!open) {
      setSelectedToolsForAssignment([]);
    }
  }, []);

  // Convert ExtendedTool to the format expected by McpToolsDialog
  const dialogTools = useMemo(
    () =>
      selectedToolsForAssignment.map((tool) => ({
        id: tool.id,
        name: tool.name,
        description: tool.description,
        assignedAgentCount: tool.agent ? 1 : 0,
        assignedAgents: tool.agent
          ? [{ id: tool.agent.id, name: tool.agent.name }]
          : [],
        parameters: tool.parameters || {},
        createdAt: tool.createdAt,
      })),
    [selectedToolsForAssignment],
  );

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 md:px-8">
      <ToolsTable
        tools={tools || []}
        agents={agents || []}
        onBulkAssignTools={handleBulkAssignTools}
      />

      <McpToolsDialog
        open={assignmentDialogOpen}
        onOpenChange={handleAssignmentDialogClose}
        serverName="Selected Tools"
        tools={dialogTools}
        isLoading={false}
        onAssignTool={() => {
          // Individual tool assignment - not needed for bulk assignment
        }}
        onBulkAssignTools={() => {
          // This would trigger the actual assignment logic
          // For now, just close the dialog
          setAssignmentDialogOpen(false);
          setSelectedToolsForAssignment([]);
        }}
      />
    </div>
  );
}
