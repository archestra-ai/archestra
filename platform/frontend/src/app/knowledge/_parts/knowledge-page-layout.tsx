"use client";

import { Plus } from "lucide-react";
import { LoadingSpinner, LoadingWrapper } from "@/components/loading";
import { PageLayout } from "@/components/page-layout";
import { PermissionButton } from "@/components/ui/permission-button";
import { useIsEmbeddingConfigured } from "@/lib/organization.query";
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
  const isEmbeddingConfigured = useIsEmbeddingConfigured();

  return (
    <LoadingWrapper isPending={isPending} loadingFallback={<LoadingSpinner />}>
      <PageLayout
        title={title}
        description={description}
        actionButton={
          <PermissionButton
            permissions={{ knowledgeBase: ["create"] }}
            onClick={onCreateClick}
            disabled={!isEmbeddingConfigured}
            tooltip={
              !isEmbeddingConfigured
                ? `Configure an embedding API key and model in Settings > Knowledge before creating ${title.toLowerCase()}.`
                : undefined
            }
          >
            <Plus className="mr-2 h-4 w-4" />
            {createLabel}
          </PermissionButton>
        }
      >
        {!isEmbeddingConfigured ? <EmbeddingRequiredPlaceholder /> : children}
      </PageLayout>
    </LoadingWrapper>
  );
}
