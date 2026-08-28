"use client";

import type { Permissions } from "@archestra/shared";
import { Plus } from "lucide-react";
import { LoadingState, LoadingWrapper } from "@/components/loading";
import { PageLayout } from "@/components/page-layout";
import { SmallTeamTierBanner } from "@/components/small-team-tier-banner";
import { PermissionButton } from "@/components/ui/permission-button";
import { useIsKnowledgeBaseConfigured } from "@/lib/knowledge/knowledge-base.query";
import { EmbeddingRequiredPlaceholder } from "./embedding-required-placeholder";

export function KnowledgePageLayout({
  title,
  description,
  createLabel,
  onCreateClick,
  createPermissions = { knowledgeSource: ["create"] },
  isPending,
  extraActions,
  children,
}: {
  title: string;
  description: string;
  createLabel: string;
  onCreateClick: () => void;
  createPermissions?: Permissions;
  isPending: boolean;
  /** Rendered to the left of the create button (e.g. admin page settings). */
  extraActions?: React.ReactNode;
  children: React.ReactNode;
}) {
  const isKnowledgeBaseConfigured = useIsKnowledgeBaseConfigured();

  return (
    <LoadingWrapper
      isPending={isPending}
      loadingFallback={<LoadingState variant="viewport" />}
    >
      <PageLayout
        title={
          <span className="flex items-center gap-2">
            {title}
            <SmallTeamTierBanner compact />
          </span>
        }
        documentTitle={title}
        description={description}
        actionButton={
          <div className="flex items-center gap-2">
            {extraActions}
            <PermissionButton
              permissions={createPermissions}
              onClick={onCreateClick}
              disabled={!isKnowledgeBaseConfigured}
            >
              <Plus className="h-4 w-4" />
              <span>{createLabel}</span>
            </PermissionButton>
          </div>
        }
      >
        {!isKnowledgeBaseConfigured ? (
          <EmbeddingRequiredPlaceholder />
        ) : (
          children
        )}
      </PageLayout>
    </LoadingWrapper>
  );
}
