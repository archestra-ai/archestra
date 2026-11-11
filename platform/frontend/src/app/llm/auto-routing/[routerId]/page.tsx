"use client";

import { AlertTriangle, Hourglass } from "lucide-react";
import { QueryLoadError } from "@/components/query-load-error";
import { Card, CardContent } from "@/components/ui/card";
import { InlineNotice, InlineNoticeText } from "@/components/ui/inline-notice";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { type AutoRouter, useAutoRouter } from "@/lib/auto-routing.query";
import { formatCurrency } from "@/lib/utils/format-currency";
import { BUDGET_PRESET_LABELS } from "../_parts/budget-presets";
import { PastSessions, PastSessionsNotice } from "../_parts/past-sessions";
import { describeFitError } from "../_parts/plan-document";
import { RouterFigures } from "../_parts/router-figures";
import { isAutoRoutingSetUp, SetupCards } from "../_parts/setup-cards";
import { TIER_LABELS, TIER_NAMES } from "../_parts/tiers";

export default function AutoRoutingOverviewPage() {
  const settingsQuery = useAutoRouter();
  const { data: canUpdate = false } = useHasPermissions({
    llmProxy: ["update"],
  });
  if (settingsQuery.isLoadingError) {
    return (
      <QueryLoadError
        title="Couldn't load this auto router"
        error={settingsQuery.error}
        onRetry={() => settingsQuery.refetch()}
      />
    );
  }
  const settings = settingsQuery.data;
  if (!settings) return null;

  const hasActivePlan = settings.status.activePlan !== null;
  const pastSessionsProps = {
    routingEnabled: settings.enabled,
    canUpdate,
    scorer: settings.status.scorer,
  };
  // Until a plan is active, past sessions are a setup step; after, a header action.
  const pastSessions = settings.usesPastSessions && !hasActivePlan && (
    <PastSessions {...pastSessionsProps} />
  );

  if (!isAutoRoutingSetUp(settings)) {
    return (
      <div className="space-y-6">
        <SetupCards settings={settings} />
        {pastSessions}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <StateNotice settings={settings} />
      {settings.usesPastSessions && hasActivePlan && (
        <PastSessionsNotice {...pastSessionsProps} />
      )}
      <RouterDetails settings={settings} />
      <RouterFigures settings={settings} />
      {pastSessions}
    </div>
  );
}

/** Why the figures below are empty, or why the last fit did not replace them. */
function StateNotice({ settings }: { settings: AutoRouter }) {
  const { activePlan, lastFitError } = settings.status;
  if (lastFitError) {
    const fitError = describeFitError(lastFitError);
    return (
      <InlineNotice variant="error">
        <AlertTriangle />
        <span className="font-medium">Last fit failed</span>
        <InlineNoticeText>
          {fitError.message}
          {fitError.code && (
            <span className="ml-1 font-mono text-xs">({fitError.code})</span>
          )}
        </InlineNoticeText>
      </InlineNotice>
    );
  }
  if (activePlan) return null;
  return (
    <InlineNotice variant="info" data-testid="auto-routing-evaluating">
      <Hourglass />
      <span className="font-medium">Evaluating sessions</span>
      <InlineNoticeText>
        Spend and quality figures appear once enough sessions are scored. Until
        then, sessions use the normal model.
      </InlineNoticeText>
    </InlineNotice>
  );
}

/** What the router is: its three models, budget and decision model. */
function RouterDetails({ settings }: { settings: AutoRouter }) {
  const budget = settings.budgetPreset
    ? BUDGET_PRESET_LABELS[settings.budgetPreset]
    : settings.budgetUsdPerDay === null
      ? "Not set"
      : `${formatCurrency(settings.budgetUsdPerDay)}/day`;
  return (
    <Card className="py-4" data-testid="auto-routing-details">
      <CardContent className="px-4">
        <dl className="grid gap-x-6 gap-y-4 sm:grid-cols-3">
          {TIER_NAMES.map((tier) => (
            <Detail
              key={tier}
              label={TIER_LABELS[tier]}
              value={
                <span className="font-mono">
                  {settings.tiers[tier]?.modelId ?? "Not set"}
                </span>
              }
              note={settings.tiers[tier]?.apiKey.name}
            />
          ))}
          <Detail label="Daily budget" value={budget} />
          <Detail
            label="Decision model"
            value={
              <span className="font-mono">{settings.decisionModel.model}</span>
            }
            note={settings.status.scorerApiKey?.name}
          />
        </dl>
      </CardContent>
    </Card>
  );
}

function Detail({
  label,
  value,
  note,
}: {
  label: string;
  value: React.ReactNode;
  note?: string;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-muted-foreground text-xs uppercase tracking-wide">
        {label}
      </dt>
      <dd className="truncate text-sm">{value}</dd>
      {note && (
        <dd className="truncate text-xs text-muted-foreground">{note}</dd>
      )}
    </div>
  );
}
