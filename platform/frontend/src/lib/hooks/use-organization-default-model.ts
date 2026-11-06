"use client";

import type { archestraApiTypes, SupportedProvider } from "@archestra/shared";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useModelProviderCatalog } from "@/lib/integration-overrides";
import { useLlmModels } from "@/lib/llm-models.query";
import { useOrganizationDefaultModelSummary } from "@/lib/organization.query";

/**
 * The model an agent without one of its own actually runs on: the
 * organization default set in Settings → Chat, named so a control that reads
 * "Organization default" can say what that currently does — the default
 * model's provider and name, or the three tiers auto routing routes it across
 * for an agent that `followsRouting`. `label` is null while the default cannot
 * be named (unset, still loading, or the model has since been removed).
 * `model` is the catalog row, for callers with permission to read models.
 */
export function useOrganizationDefaultModel({
  enabled = true,
  followsRouting = true,
}: {
  enabled?: boolean;
  followsRouting?: boolean;
} = {}) {
  const { data: summary } = useOrganizationDefaultModelSummary(enabled);
  const { data: canReadLlmModels } = useHasPermissions({
    llmModel: ["read"],
  });
  const providerCatalog = useModelProviderCatalog();
  const defaultModelId = summary?.model?.id ?? null;
  const { data: models } = useLlmModels({
    enabled: enabled && !!defaultModelId && !!canReadLlmModels,
  });
  const model = defaultModelId
    ? (models?.find((candidate) => candidate.dbId === defaultModelId) ?? null)
    : null;
  return {
    model,
    label: summaryLabel({
      summary,
      followsRouting,
      providerLabel: providerCatalog.label,
    }),
  };
}

// ============================================================================

type OrganizationDefaultModelSummary =
  archestraApiTypes.GetOrganizationDefaultModelResponses["200"];

function summaryLabel(params: {
  summary: OrganizationDefaultModelSummary | null | undefined;
  followsRouting: boolean;
  providerLabel: (provider: SupportedProvider) => string;
}): string | null {
  const { summary, followsRouting, providerLabel } = params;
  if (!summary?.model) return null;
  if (followsRouting && summary.autoRouting.active) {
    const { fast, normal, smart } = summary.autoRouting.tiers;
    return `Auto routed: ${fast.displayName}, ${normal.displayName}, ${smart.displayName}`;
  }
  return [providerLabel(summary.model.provider), summary.model.displayName]
    .filter(Boolean)
    .join(" · ");
}
