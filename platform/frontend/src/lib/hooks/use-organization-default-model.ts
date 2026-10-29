"use client";

import type { archestraApiTypes, SupportedProvider } from "@archestra/shared";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useModelProviderCatalog } from "@/lib/integration-overrides";
import { useLlmModels } from "@/lib/llm-models.query";
import {
  useOrganization,
  useOrganizationDefaultModelSummary,
} from "@/lib/organization.query";

/**
 * The model an agent without one of its own actually runs on: the
 * organization default set in Settings → Chat, named so a control that reads
 * "Organization default" can say what that currently does — the default
 * model's provider and name, or the three tiers auto routing routes it across.
 * `isSet` is false when no default exists, in which case the runtime falls
 * through to the best available model across the caller's keys; `label` is
 * null while the default cannot be named (still loading, or the model has
 * since been removed). `model` is the catalog row, for callers with
 * permission to read models.
 */
export function useOrganizationDefaultModel({
  enabled = true,
}: {
  enabled?: boolean;
} = {}) {
  const { data: organization } = useOrganization();
  const { data: summary } = useOrganizationDefaultModelSummary(enabled);
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
    label: summaryLabel(summary, providerCatalog.label),
  };
}

// ============================================================================

type OrganizationDefaultModelSummary =
  archestraApiTypes.GetOrganizationDefaultModelResponses["200"];

function summaryLabel(
  summary: OrganizationDefaultModelSummary | null | undefined,
  providerLabel: (provider: SupportedProvider) => string,
): string | null {
  if (!summary?.model) return null;
  if (summary.autoRouting.active) {
    const { fast, normal, smart } = summary.autoRouting.tiers;
    return `Auto routed: ${fast.displayName}, ${normal.displayName}, ${smart.displayName}`;
  }
  return [providerLabel(summary.model.provider), summary.model.displayName]
    .filter(Boolean)
    .join(" · ");
}
