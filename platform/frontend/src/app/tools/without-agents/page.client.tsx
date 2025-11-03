"use client";

import { Suspense, useState } from "react";
import { LoadingSpinner } from "@/components/loading";
import { useUnassignedTools } from "@/lib/tool.query";
import { ErrorBoundary } from "../../_parts/error-boundary";
import { AssignAgentDialog } from "../_parts/assign-agent-dialog";
import {
  type UnassignedToolData,
  UnassignedToolsList,
} from "../_parts/unassigned-tools-list";

export function WithoutAgentsClient() {
  return (
    <div className="w-full h-full">
      <ErrorBoundary>
        <Suspense fallback={<LoadingSpinner className="mt-[30vh]" />}>
          <WithoutAgentsList />
        </Suspense>
      </ErrorBoundary>
    </div>
  );
}

function WithoutAgentsList() {
  const { data: unassignedTools } = useUnassignedTools({});

  const [selectedToolForAssignment, setSelectedToolForAssignment] =
    useState<UnassignedToolData | null>(null);

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 md:px-8">
      <UnassignedToolsList
        tools={unassignedTools || []}
        onAssignClick={setSelectedToolForAssignment}
      />

      <AssignAgentDialog
        tool={selectedToolForAssignment}
        open={!!selectedToolForAssignment}
        onOpenChange={(open) => !open && setSelectedToolForAssignment(null)}
      />
    </div>
  );
}
