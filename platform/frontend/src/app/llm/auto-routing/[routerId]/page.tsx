"use client";

import { AlertTriangle, Hourglass } from "lucide-react";
import { QueryLoadError } from "@/components/query-load-error";
import { Card, CardContent } from "@/components/ui/card";
import { InlineNotice, InlineNoticeText } from "@/components/ui/inline-notice";
import { useHasPermissions } from "@/lib/auth/auth.query";
import {
  type AutoRouter,
  type AutoRoutingPlanDetail,
  useAutoRouter,
  useAutoRoutingPlan,
} from "@/lib/auto-routing.query";
import { formatDate } from "@/lib/utils/date-time";
import { formatCurrency } from "@/lib/utils/format-currency";
import { BUDGET_PRESET_LABELS } from "../_parts/budget-presets";
import { useFittedTierModels } from "../_parts/fitted-tier-models";
import { PastSessions } from "../_parts/past-sessions";
import {
  describeFitError,
  parseFittedHistory,
  parsePlanSummary,
} from "../_parts/plan-document";
import {
  PlanSummaryPlaceholder,
  PlanSummaryView,
} from "../_parts/plan-summary";
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

  const pastSessions = settings.usesPastSessions && (
    <PastSessions
      routingEnabled={settings.enabled}
      hasActivePlan={settings.status.activePlan !== null}
      canUpdate={canUpdate}
      scorer={settings.status.scorer}
    />
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
      <RouterDetails settings={settings} />
      <PlanFigures settings={settings} />
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

/** The active plan's figures, or the same tiles empty while there is none. */
function PlanFigures({ settings }: { settings: AutoRouter }) {
  const { data: plan } = useAutoRoutingPlan(
    settings.status.activePlan?.id ?? null,
  );
  const tierModels = useFittedTierModels(
    plan?.tiersFingerprint ?? null,
    settings.tiers,
  );
  const summary = plan ? parsePlanSummary(plan.summary) : null;
  if (!settings.status.activePlan) {
    return (
      <PlanSummaryPlaceholder
        budgetUsdPerDay={settings.budgetUsdPerDay}
        budgetPreset={settings.budgetPreset}
        tierModels={{
          fast: settings.tiers.fast?.modelId ?? "unknown",
          normal: settings.tiers.normal?.modelId ?? "unknown",
          smart: settings.tiers.smart?.modelId ?? "unknown",
        }}
      />
    );
  }
  if (!plan || !summary || plan.budgetUsdPerDay === null) return null;
  return (
    <div className="space-y-2">
      <PlanCaption plan={plan} />
      <PlanSummaryView
        summary={summary}
        budgetUsdPerDay={plan.budgetUsdPerDay}
        // A plan fitted before the preset was picked keeps serving until a new one is.
        budgetPreset={
          plan.generation === settings.generation ? settings.budgetPreset : null
        }
        tierModels={tierModels}
      />
    </div>
  );
}

/** How fresh the figures are and how much they were learned from. */
function PlanCaption({ plan }: { plan: AutoRoutingPlanDetail }) {
  const history = parseFittedHistory(plan.diagnostics);
  const parts = [
    `Plan updated ${formatDate({ date: plan.createdAt, dateFormat: "MMM d, HH:mm" })}`,
    history ? `${history.sessions.toLocaleString("en-US")} sessions` : null,
  ].filter((part) => part !== null);
  return (
    <p
      className="text-xs text-muted-foreground"
      data-testid="auto-routing-plan-caption"
    >
      {parts.join(" · ")}
    </p>
  );
}
