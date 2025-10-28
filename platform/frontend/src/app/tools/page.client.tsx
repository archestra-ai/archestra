"use client";

import type { archestraApiTypes } from "@shared";
import { useQueryClient } from "@tanstack/react-query";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { LoadingSpinner } from "@/components/loading";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAllAgentTools } from "@/lib/agent-tools.query";
import {
  prefetchOperators,
  prefetchToolInvocationPolicies,
  prefetchToolResultPolicies,
} from "@/lib/policy.query";
import { useUnassignedTools } from "@/lib/tool.query";
import { ErrorBoundary } from "../_parts/error-boundary";
import { AssignAgentDialog } from "./_parts/assign-agent-dialog";
import { AssignedToolsList } from "./_parts/assigned-tools-list";
import { ToolDetailsDialog } from "./_parts/tool-details-dialog";
import {
  type UnassignedToolData,
  UnassignedToolsList,
} from "./_parts/unassigned-tools-list";

type AgentToolData = archestraApiTypes.GetAllAgentToolsResponses["200"][number];

export function ToolsPage({ initialData }: { initialData?: AgentToolData[] }) {
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
        <Suspense fallback={<LoadingSpinner />}>
          <ToolsList key="tools-list-component" initialData={initialData} />
        </Suspense>
      </ErrorBoundary>
    </div>
  );
}

function ToolsList({ initialData }: { initialData?: AgentToolData[] }) {
  const [activeTab, setActiveTab] = useState<"with_agents" | "without_agents">(
    "with_agents",
  );

  const { data: agentTools } = useAllAgentTools({
    initialData: activeTab === "with_agents" ? initialData : undefined,
  });
  const { data: unassignedTools } = useUnassignedTools({
    initialData: activeTab === "without_agents" ? undefined : undefined,
  });

  const [selectedToolForDialog, setSelectedToolForDialog] =
    useState<AgentToolData | null>(null);
  const [selectedToolForAssignment, setSelectedToolForAssignment] =
    useState<UnassignedToolData | null>(null);

  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  return (
    <div className="w-full h-full">
      <div className="border-b border-border bg-card/30">
        <div className="max-w-7xl mx-auto px-8 py-8">
          <h1 className="text-2xl font-semibold tracking-tight mb-2">Tools</h1>
          <p className="text-sm text-muted-foreground">
            Tools displayed here are either detected from requests between
            agents and LLMs or sourced from installed MCP servers.
          </p>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-8 py-6">
        <Tabs
          value={activeTab}
          onValueChange={(value) => {
            setActiveTab(value as "with_agents" | "without_agents");
            // Reset to first page when switching tabs
            const params = new URLSearchParams(searchParams.toString());
            params.set("page", "1");
            router.push(`${pathname}?${params.toString()}`, { scroll: false });
          }}
        >
          <TabsList className="mb-4">
            <TabsTrigger value="with_agents">Agents Assigned</TabsTrigger>
            <TabsTrigger value="without_agents">Without Agents</TabsTrigger>
          </TabsList>

          <TabsContent value="with_agents" className="mt-0">
            <AssignedToolsList
              agentTools={agentTools || []}
              onToolClick={setSelectedToolForDialog}
            />
          </TabsContent>

          <TabsContent value="without_agents" className="mt-0">
            <UnassignedToolsList
              tools={unassignedTools || []}
              onAssignClick={setSelectedToolForAssignment}
            />
          </TabsContent>
        </Tabs>

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

        <AssignAgentDialog
          tool={selectedToolForAssignment}
          open={!!selectedToolForAssignment}
          onOpenChange={(open) => !open && setSelectedToolForAssignment(null)}
        />
      </div>
    </div>
  );
}
