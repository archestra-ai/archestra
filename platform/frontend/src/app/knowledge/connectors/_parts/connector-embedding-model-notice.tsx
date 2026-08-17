"use client";

import type { ConnectorType } from "@archestra/shared";
import {
  EmbeddingModelImageSupportNotice,
  embeddingModelSupportsImages,
} from "@/app/knowledge/_parts/embedding-model-image-support-notice";
import { useSession } from "@/lib/auth/auth.query";
import { useModelsWithApiKeys } from "@/lib/llm-models.query";
import { useOrganization } from "@/lib/organization.query";

const IMAGE_CAPABLE_CONNECTOR_TYPES = new Set<ConnectorType>([
  "dropbox",
  "gdrive",
  "mfiles",
  "onedrive",
  "sharepoint",
]);

export function ConnectorEmbeddingModelNotice({
  connectorType,
}: {
  connectorType: ConnectorType;
}) {
  if (!IMAGE_CAPABLE_CONNECTOR_TYPES.has(connectorType)) return null;
  return <CurrentEmbeddingModelNotice />;
}

function CurrentEmbeddingModelNotice() {
  const { data: organization } = useOrganization();
  const { data: session } = useSession();
  const { data: models } = useModelsWithApiKeys({ toastOnError: false });
  const embeddingApiKeyId = organization?.embeddingChatApiKeyId;
  const embeddingModelId = organization?.embeddingModel;

  const dismissalScope =
    organization?.id && session?.user.id
      ? `${organization.id}:${session.user.id}`
      : null;

  if (!embeddingApiKeyId || !embeddingModelId || !models || !dismissalScope) {
    return null;
  }

  const embeddingModel = models.find(
    (model) =>
      model.modelId === embeddingModelId &&
      model.apiKeys.some((apiKey) => apiKey.id === embeddingApiKeyId),
  );
  if (!embeddingModel) return null;

  return (
    <EmbeddingModelImageSupportNotice
      modelId={embeddingModel.modelId}
      provider={embeddingModel.provider}
      dismissalScope={dismissalScope}
      supportsImages={embeddingModelSupportsImages(embeddingModel)}
    />
  );
}
