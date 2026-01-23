"use client";

import type { archestraApiTypes } from "@shared";
import { Plus } from "lucide-react";
import { useCallback, useState } from "react";
import { ErrorBoundary } from "@/app/_parts/error-boundary";
import { AgentDialog } from "@/components/agent-dialog";
import { PromptVersionHistoryDialog } from "@/components/chat/prompt-version-history-dialog";
import { PageLayout } from "@/components/page-layout";
import { PermissivePolicyBar } from "@/components/permissive-policy-bar";
import { WithPermissions } from "@/components/roles/with-permissions";
import { PermissionButton } from "@/components/ui/permission-button";
import { useProfile } from "@/lib/agent.query";

type InternalAgent = archestraApiTypes.GetAllAgentsResponses["200"][number];

export default function AgentsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Dialog state for creating/editing internal agents
  const [isAgentDialogOpen, setIsAgentDialogOpen] = useState(false);
  const [editingAgentId, setEditingAgentId] = useState<string | null>(null);
  const [versionHistoryAgent, setVersionHistoryAgent] =
    useState<InternalAgent | null>(null);

  const { data: editingAgent } = useProfile(editingAgentId ?? undefined);

  const handleCreateAgent = useCallback(() => {
    setEditingAgentId(null);
    setIsAgentDialogOpen(true);
  }, []);

  return (
    <ErrorBoundary>
      <PermissivePolicyBar />
      <PageLayout
        title="Agents"
        description={
          <p className="text-sm text-muted-foreground">
            Agents are pre-configured prompts that can be used to start
            conversations with specific system prompts and user prompts.
          </p>
        }
        actionButton={
          <WithPermissions
            permissions={{ profile: ["create"] }}
            noPermissionHandle="hide"
          >
            <PermissionButton
              permissions={{ profile: ["create"] }}
              onClick={handleCreateAgent}
            >
              <Plus className="mr-2 h-4 w-4" />
              Create Agent
            </PermissionButton>
          </WithPermissions>
        }
      >
        {children}

        {/* Create/Edit Agent Dialog */}
        <AgentDialog
          open={isAgentDialogOpen}
          onOpenChange={(open) => {
            setIsAgentDialogOpen(open);
            if (!open) {
              setEditingAgentId(null);
            }
          }}
          agent={editingAgent}
          agentType="agent"
          onViewVersionHistory={setVersionHistoryAgent}
        />

        {/* Version History Dialog */}
        <PromptVersionHistoryDialog
          open={!!versionHistoryAgent}
          onOpenChange={(open) => {
            if (!open) {
              setVersionHistoryAgent(null);
            }
          }}
          agent={versionHistoryAgent}
        />
      </PageLayout>
    </ErrorBoundary>
  );
}
