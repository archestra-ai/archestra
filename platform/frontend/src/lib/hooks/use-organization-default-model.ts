"use client";

import type { archestraApiTypes, SupportedProvider } from "@archestra/shared";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useModelProviderCatalog } from "@/lib/integration-overrides";
import { useLlmModels } from "@/lib/llm-models.query";
import { useOrganizationDefaultModelSummary } from "@/lib/organization.query";

/**
 * The model an agent without one of its own actually runs on: the
 * organization default set in Settings → Agents, named so a control that
 * reads "Organization default" can say what that currently does — the default
 * model's provider and name, or "Auto" when the default is `auto` and the
 * agent `followsRouting`. `label` is null
 * while the default cannot be named (unset, still loading, or the model has
 * since been removed). `model` is the catalog row, for callers with
 * permission to read models. `auto` is set while the `auto` model can be
 * picked, with the tiers it routes across; `defaultAutoModel`, whether the
 * organization default is `auto`.
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
    /** The three routed models, while the default is `auto` and routes for this caller. */
    autoRoutedTiers:
      followsRouting && summary?.defaultAutoModel && summary.autoRouting.active
        ? summary.autoRouting.tiers
        : null,
    label: summaryLabel({
      summary,
      followsRouting,
      providerLabel: providerCatalog.label,
    }),
    auto: summary?.autoRouting.active
      ? {
          description: tiersLabel(summary.autoRouting.tiers),
          tiers: summary.autoRouting.tiers,
        }
      : null,
    defaultAutoModel: summary?.defaultAutoModel ?? false,
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
  if (
    followsRouting &&
    summary.defaultAutoModel &&
    summary.autoRouting.active
  ) {
    return "Auto";
  }
  return [providerLabel(summary.model.provider), summary.model.displayName]
    .filter(Boolean)
    .join(" · ");
}

function tiersLabel(
  tiers: Extract<
    OrganizationDefaultModelSummary["autoRouting"],
    { active: true }
  >["tiers"],
): string {
  return `${tiers.fast.displayName}, ${tiers.normal.displayName}, ${tiers.smart.displayName}`;
}
