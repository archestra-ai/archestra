"use client";

import type { archestraApiTypes } from "@shared";
import { Suspense } from "react";
import { AgentsCanvasView } from "@/components/agents-canvas/agents-canvas-view";
import { LoadingSpinner } from "@/components/loading";

type AgentsInitialData = {
  agents: archestraApiTypes.GetAgentsResponses["200"] | null;
  teams: archestraApiTypes.GetTeamsResponses["200"];
};

export default function AgentsPage({
  initialData: _initialData,
}: {
  initialData?: AgentsInitialData;
}) {
  // Note: initialData is available for future optimization to hydrate React Query cache
  // Currently AgentsCanvasView handles its own data fetching via useInternalAgents
  return (
    <Suspense fallback={<LoadingSpinner className="mt-[30vh]" />}>
      <AgentsCanvasView />
    </Suspense>
  );
}
