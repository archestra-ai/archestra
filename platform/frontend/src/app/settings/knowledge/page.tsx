"use client";

import type { archestraApiTypes } from "@shared";
import { useEffect, useState } from "react";
import { ErrorBoundary } from "@/app/_parts/error-boundary";
import { LoadingSpinner, LoadingWrapper } from "@/components/loading";
import { WithPermissions } from "@/components/roles/with-permissions";
import {
  SettingsBlock,
  SettingsSaveBar,
} from "@/components/settings/settings-block";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  useOrganization,
  useUpdateKnowledgeSettings,
} from "@/lib/organization.query";

type EmbeddingModel = NonNullable<
  NonNullable<
    archestraApiTypes.UpdateKnowledgeSettingsData["body"]
  >["embeddingModel"]
>;

const EMBEDDING_MODEL_LABELS: Record<EmbeddingModel, string> = {
  "text-embedding-3-small":
    "text-embedding-3-small — Best cost/quality ratio (1536 dims)",
  "text-embedding-3-large":
    "text-embedding-3-large — Higher quality, 2x cost (3072 dims)",
  "text-embedding-ada-002": "text-embedding-ada-002 — Legacy model (1536 dims)",
};

const DEFAULT_MODEL: EmbeddingModel = "text-embedding-3-small";

function KnowledgeSettingsContent() {
  const { data: organization, isPending } = useOrganization();
  const updateKnowledgeSettings = useUpdateKnowledgeSettings(
    "Knowledge settings updated",
    "Failed to update knowledge settings",
  );

  const [embeddingModel, setEmbeddingModel] =
    useState<EmbeddingModel>(DEFAULT_MODEL);

  useEffect(() => {
    if (organization) {
      setEmbeddingModel(
        (organization.embeddingModel as EmbeddingModel | null) ?? DEFAULT_MODEL,
      );
    }
  }, [organization]);

  const serverModel =
    (organization?.embeddingModel as EmbeddingModel | null) ?? DEFAULT_MODEL;
  const hasChanges = embeddingModel !== serverModel;

  const handleSave = async () => {
    await updateKnowledgeSettings.mutateAsync({
      embeddingModel,
    });
  };

  const handleCancel = () => {
    setEmbeddingModel(serverModel);
  };

  return (
    <LoadingWrapper isPending={isPending} loadingFallback={<LoadingSpinner />}>
      <div className="space-y-6">
        <SettingsBlock
          title="Embedding Model"
          description="The model used to generate vector embeddings for knowledge base documents. Changing this will require re-embedding all existing documents."
          control={
            <WithPermissions
              permissions={{ knowledgeSettings: ["update"] }}
              noPermissionHandle="tooltip"
            >
              {({ hasPermission }) => (
                <Select
                  value={embeddingModel}
                  onValueChange={(v) => setEmbeddingModel(v as EmbeddingModel)}
                  disabled={!hasPermission}
                >
                  <SelectTrigger className="w-80">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(
                      Object.entries(EMBEDDING_MODEL_LABELS) as [
                        EmbeddingModel,
                        string,
                      ][]
                    ).map(([value, label]) => (
                      <SelectItem key={value} value={value}>
                        {label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </WithPermissions>
          }
        />

        <SettingsSaveBar
          hasChanges={hasChanges}
          isSaving={updateKnowledgeSettings.isPending}
          permissions={{ knowledgeSettings: ["update"] }}
          onSave={handleSave}
          onCancel={handleCancel}
        />
      </div>
    </LoadingWrapper>
  );
}

export default function KnowledgeSettingsPage() {
  return (
    <ErrorBoundary>
      <KnowledgeSettingsContent />
    </ErrorBoundary>
  );
}
