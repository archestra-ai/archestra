"use client";

import { useHasPermissions } from "@/lib/auth/auth.query";
import { useModelProviderCatalog } from "@/lib/integration-overrides";
import { useLlmModels } from "@/lib/llm-models.query";
import { useOrganization } from "@/lib/organization.query";

/**
 * The model an agent without one of its own actually runs on: the
 * organization default set in Settings → Chat, named — provider and display
 * name — so a control that reads "Organization default" can say which model
 * that currently is. `isSet` is false when no default exists, in which case
 * the runtime falls through to the best available model across the caller's
 * keys; `label` is null while the default cannot be named (still loading, no
 * permission to read models, or the model has since been removed).
 */
export function useOrganizationDefaultModel({
  enabled = true,
}: {
  enabled?: boolean;
} = {}) {
  const { data: organization } = useOrganization();
  const { data: canReadLlmModels } = useHasPermissions({
    llmModel: ["read"],
  });
  const providerCatalog = useModelProviderCatalog();
  const defaultModelId = organization?.defaultModelId ?? null;
  const { data: models } = useLlmModels({
    enabled: enabled && !!defaultModelId && !!canReadLlmModels,
  });
  const model = defaultModelId
    ? (models?.find((candidate) => candidate.dbId === defaultModelId) ?? null)
    : null;
  return {
    isSet: !!defaultModelId,
    model,
    label: model
      ? [providerCatalog.label(model.provider), model.displayName]
          .filter(Boolean)
          .join(" · ")
      : null,
  };
}
