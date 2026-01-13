"use client";

import type { archestraApiTypes } from "@shared";
import { Plus } from "lucide-react";
import { useCallback, useState } from "react";
import { ErrorBoundary } from "@/app/_parts/error-boundary";
import { PromptDialog } from "@/components/chat/prompt-dialog";
import { PromptVersionHistoryDialog } from "@/components/chat/prompt-version-history-dialog";
import { PageLayout } from "@/components/page-layout";
import { PermissivePolicyBar } from "@/components/permissive-policy-bar";
import { WithPermissions } from "@/components/roles/with-permissions";
import { PermissionButton } from "@/components/ui/permission-button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useProfiles } from "@/lib/agent.query";
import { usePrompt } from "@/lib/prompts.query";

type Prompt = archestraApiTypes.GetPromptsResponses["200"][number];

export default function AgentsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { data: allProfiles = [] } = useProfiles();

  // Dialog state for creating new agents
  const [isPromptDialogOpen, setIsPromptDialogOpen] = useState(false);
  const [editingPromptId, setEditingPromptId] = useState<string | null>(null);
  const [versionHistoryPrompt, setVersionHistoryPrompt] =
    useState<Prompt | null>(null);

  const { data: editingPrompt } = usePrompt(editingPromptId || "");

  const handleCreatePrompt = useCallback(() => {
    setEditingPromptId(null);
    setIsPromptDialogOpen(true);
  }, []);

  const hasNoProfiles = allProfiles.length === 0;

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
            permissions={{ prompt: ["create"] }}
            noPermissionHandle="hide"
          >
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span>
                    <PermissionButton
                      permissions={{ prompt: ["create"] }}
                      onClick={handleCreatePrompt}
                      disabled={hasNoProfiles}
                    >
                      <Plus className="mr-2 h-4 w-4" />
                      Create Agent
                    </PermissionButton>
                  </span>
                </TooltipTrigger>
                {hasNoProfiles && (
                  <TooltipContent>
                    <p>No profiles available. Create a profile first.</p>
                  </TooltipContent>
                )}
              </Tooltip>
            </TooltipProvider>
          </WithPermissions>
        }
      >
        {children}

        {/* Create/Edit Prompt Dialog */}
        <PromptDialog
          open={isPromptDialogOpen}
          onOpenChange={(open) => {
            setIsPromptDialogOpen(open);
            if (!open) {
              setEditingPromptId(null);
            }
          }}
          prompt={editingPrompt}
          onViewVersionHistory={setVersionHistoryPrompt}
        />

        {/* Version History Dialog */}
        <PromptVersionHistoryDialog
          open={!!versionHistoryPrompt}
          onOpenChange={(open) => {
            if (!open) {
              setVersionHistoryPrompt(null);
            }
          }}
          prompt={versionHistoryPrompt}
        />
      </PageLayout>
    </ErrorBoundary>
  );
}
