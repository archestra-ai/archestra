"use client";

import type { Permissions } from "@archestra/shared";
import { Plus } from "lucide-react";
import { LoadingSpinner, LoadingWrapper } from "@/components/loading";
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
  children,
}: {
  title: string;
  description: string;
  createLabel: string;
  onCreateClick: () => void;
  createPermissions?: Permissions;
  isPending: boolean;
  children: React.ReactNode;
}) {
  const isKnowledgeBaseConfigured = useIsKnowledgeBaseConfigured();

  return (
    <LoadingWrapper isPending={isPending} loadingFallback={<LoadingSpinner />}>
      <PageLayout
        title={title}
        description={description}
        tabs={KNOWLEDGE_TABS}
        actionButton={
          <PermissionButton
            permissions={createPermissions}
            onClick={onCreateClick}
            disabled={!isKnowledgeBaseConfigured}
          >
            <Plus className="h-4 w-4" />
            {createLabel}
          </PermissionButton>
        }
      >
        <SmallTeamTierBanner featureName="Knowledge" />
        {!isKnowledgeBaseConfigured ? (
          <EmbeddingRequiredPlaceholder />
        ) : (
          children
        )}
      </PageLayout>
    </LoadingWrapper>
  );
}

// Connectors come first: they are the prerequisite (a knowledge base is empty
// until a connector syncs data), so they are also the landing tab (see the
// bare /knowledge redirect page).
const KNOWLEDGE_TABS = [
  { label: "Connectors", href: "/knowledge/connectors" },
  { label: "Knowledge Bases", href: "/knowledge/knowledge-bases" },
];
