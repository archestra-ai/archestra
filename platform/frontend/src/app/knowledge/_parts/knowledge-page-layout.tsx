"use client";

import { Plus } from "lucide-react";
import { LoadingSpinner, LoadingWrapper } from "@/components/loading";
import { PageLayout } from "@/components/page-layout";
import { PermissionButton } from "@/components/ui/permission-button";
import { useIsKnowledgeBaseConfigured } from "@/lib/knowledge/knowledge-base.query";
import { EmbeddingRequiredPlaceholder } from "./embedding-required-placeholder";

export function KnowledgePageLayout({
  title,
  description,
  createLabel,
  onCreateClick,
  isPending,
  children,
}: {
  title: string;
  description: string;
  createLabel: string;
  onCreateClick: () => void;
  isPending: boolean;
  children: React.ReactNode;
}) {
  const isKnowledgeBaseConfigured = useIsKnowledgeBaseConfigured();

  return (
    <LoadingWrapper isPending={isPending} loadingFallback={<LoadingSpinner />}>
      <PageLayout
        title={title}
        description={description}
        actionButton={
          <PermissionButton
            permissions={{ knowledgeSource: ["create"] }}
            onClick={onCreateClick}
            disabled={!isKnowledgeBaseConfigured}
          >
            <Plus className="h-4 w-4" />
            {createLabel}
          </PermissionButton>
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
