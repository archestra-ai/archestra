"use client";

import type { archestraApiTypes, SupportedProvider } from "@archestra/shared";
import { useMemo } from "react";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { autoRouterLabel } from "@/lib/auto-router-name";
import { useModelProviderCatalog } from "@/lib/integration-overrides";
import { useLlmModels } from "@/lib/llm-models.query";
import { useOrganizationDefaultModelSummary } from "@/lib/organization.query";

/**
 * The model an agent without one of its own actually runs on: the
 * organization default set in Settings → Agents, named so a control that
 * reads "Organization default" can say what that currently does — the default
 * model's provider and name, or the auto router's label ("Auto",
 * "Auto · support") when the default is an auto router and the agent
 * `followsRouting`. `label` is null
 * while the default cannot be named (unset, still loading, or the model has
 * since been removed). `model` is the catalog row, for callers with
 * permission to read models. `autoRouters` lists the auto routers that can
 * be picked, each with the tiers it routes across; `defaultAutoRouterId`,
 * the router the organization default runs on, or null.
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
  const autoRouters = useMemo(
    () =>
      (summary?.autoRouters ?? []).map((router) => ({
        id: router.id,
        name: router.name,
        label: autoRouterLabel(router.name),
        description: tiersLabel(router.tiers),
        tiers: router.tiers,
      })),
    [summary?.autoRouters],
  );
  const defaultRouter = followsRouting ? routedDefault(summary) : null;
  return {
    model,
    /** The three routed models, while the default is an auto router that routes for this caller. */
    autoRoutedTiers: defaultRouter?.tiers ?? null,
    label: summaryLabel({
      summary,
      defaultRouter,
      providerLabel: providerCatalog.label,
    }),
    autoRouters,
    defaultAutoRouterId: summary?.defaultAutoRouterId ?? null,
  };
}

/** One auto router a model picker offers. */
export type AutoRouterOption = ReturnType<
  typeof useOrganizationDefaultModel
>["autoRouters"][number];

// ============================================================================

type OrganizationDefaultModelSummary =
  archestraApiTypes.GetOrganizationDefaultModelResponses["200"];

type SummaryAutoRouter = OrganizationDefaultModelSummary["autoRouters"][number];

/** The router the organization default runs on, while it can route. */
function routedDefault(
  summary: OrganizationDefaultModelSummary | null | undefined,
): SummaryAutoRouter | null {
  if (!summary?.defaultAutoRouterId) return null;
  return (
    summary.autoRouters.find(
      (router) => router.id === summary.defaultAutoRouterId,
    ) ?? null
  );
}

function summaryLabel(params: {
  summary: OrganizationDefaultModelSummary | null | undefined;
  defaultRouter: SummaryAutoRouter | null;
  providerLabel: (provider: SupportedProvider) => string;
}): string | null {
  const { summary, defaultRouter, providerLabel } = params;
  if (!summary?.model) return null;
  if (defaultRouter) return autoRouterLabel(defaultRouter.name);
  return [providerLabel(summary.model.provider), summary.model.displayName]
    .filter(Boolean)
    .join(" · ");
}

function tiersLabel(tiers: SummaryAutoRouter["tiers"]): string {
  return `${tiers.fast.displayName}, ${tiers.normal.displayName}, ${tiers.smart.displayName}`;
}
