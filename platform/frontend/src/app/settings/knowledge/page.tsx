"use client";

import { useState } from "react";
import { ErrorBoundary } from "@/app/_parts/error-boundary";
import { LoadingSpinner, LoadingWrapper } from "@/components/loading";
import { Label } from "@/components/ui/label";
import { PermissionButton } from "@/components/ui/permission-button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  useOrganization,
  useUpdateOrganization,
} from "@/lib/organization.query";

const EMBEDDING_MODELS = [
  {
    value: "text-embedding-3-small",
    label: "text-embedding-3-small",
    description: "Best cost/quality ratio (1536 dims)",
  },
  {
    value: "text-embedding-3-large",
    label: "text-embedding-3-large",
    description: "Higher quality, 2x cost (3072 dims)",
  },
  {
    value: "text-embedding-ada-002",
    label: "text-embedding-ada-002",
    description: "Legacy model (1536 dims)",
  },
] as const;

function KnowledgeSettingsContent() {
  const { data: organization, isPending } = useOrganization();
  const updateOrganization = useUpdateOrganization(
    "Knowledge settings updated",
    "Failed to update knowledge settings",
  );

  const [embeddingModel, setEmbeddingModel] = useState<string | undefined>();

  const currentModel =
    embeddingModel ?? organization?.embeddingModel ?? "text-embedding-3-small";
  const hasChanges =
    embeddingModel !== undefined &&
    embeddingModel !==
      (organization?.embeddingModel ?? "text-embedding-3-small");

  return (
    <LoadingWrapper isPending={isPending} loadingFallback={<LoadingSpinner />}>
      <div className="space-y-6">
        <div className="border border-border rounded-lg p-6 bg-card">
          <Label htmlFor="embedding-model" className="text-sm font-semibold">
            Embedding Model
          </Label>
          <p className="text-xs text-muted-foreground mt-1 mb-3">
            The model used to generate vector embeddings for knowledge base
            documents. Changing this will require re-embedding all existing
            documents.
          </p>
          <Select value={currentModel} onValueChange={setEmbeddingModel}>
            <SelectTrigger className="w-80" id="embedding-model">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {EMBEDDING_MODELS.map((model) => (
                <SelectItem key={model.value} value={model.value}>
                  <div className="flex flex-col">
                    <span>{model.label}</span>
                    <span className="text-xs text-muted-foreground">
                      {model.description}
                    </span>
                  </div>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {hasChanges && (
          <div className="flex gap-3 sticky bottom-0 bg-background p-4 rounded-lg border border-border shadow-lg">
            <PermissionButton
              permissions={{ organization: ["update"] }}
              onClick={() => {
                updateOrganization.mutate({
                  embeddingModel: currentModel as
                    | "text-embedding-3-small"
                    | "text-embedding-3-large"
                    | "text-embedding-ada-002",
                });
                setEmbeddingModel(undefined);
              }}
              disabled={updateOrganization.isPending}
            >
              {updateOrganization.isPending ? "Saving..." : "Save"}
            </PermissionButton>
            <PermissionButton
              permissions={{ organization: ["update"] }}
              variant="outline"
              onClick={() => setEmbeddingModel(undefined)}
              disabled={updateOrganization.isPending}
            >
              Cancel
            </PermissionButton>
          </div>
        )}
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
