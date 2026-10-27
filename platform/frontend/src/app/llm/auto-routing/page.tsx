"use client";

import { AlertTriangle } from "lucide-react";
import { QueryLoadError } from "@/components/query-load-error";
import { InlineNotice, InlineNoticeText } from "@/components/ui/inline-notice";
import { useHasPermissions } from "@/lib/auth/auth.query";
import {
  type AutoRoutingSettings,
  useAutoRoutingPlan,
  useAutoRoutingSettings,
} from "@/lib/auto-routing.query";
import { formatDate } from "@/lib/utils/date-time";
import { useFittedTierModels } from "./_parts/fitted-tier-models";
import { PastSessions } from "./_parts/past-sessions";
import {
  describeFitError,
  type FittedHistory,
  parseFittedHistory,
  parsePlanSummary,
} from "./_parts/plan-document";
import { PlanSummaryView } from "./_parts/plan-summary";
import { AutoRoutingSettingsForm } from "./_parts/settings-form";
import { TryPrompt } from "./_parts/try-prompt";
import { WhatIf } from "./_parts/what-if";

export default function AutoRoutingOverviewPage() {
  const settingsQuery = useAutoRoutingSettings();
  const { data: canUpdate = false } = useHasPermissions({
    llmProxy: ["update"],
  });
  if (settingsQuery.isLoadingError) {
    return (
      <QueryLoadError
        title="Couldn't load auto routing settings"
        error={settingsQuery.error}
        onRetry={() => settingsQuery.refetch()}
      />
    );
  }
  const settings = settingsQuery.data;
  if (!settings) return null;

  return (
    <div className="space-y-6">
      <AutoRoutingSettingsForm settings={settings} canUpdate={canUpdate} />
      <PlanStatus settings={settings} />
      {settings.enabled && (
        <PastSessions
          required={settings.status.coldStart.required}
          hasActivePlan={settings.status.activePlan !== null}
          canUpdate={canUpdate}
        />
      )}
      <ActivePlanSummary settings={settings} />
      <TryPrompt canUpdate={canUpdate} />
    </div>
  );
}

function PlanStatus({ settings }: { settings: AutoRoutingSettings }) {
  const { activePlan, coldStart, lastFitError } = settings.status;
  const { data: plan } = useAutoRoutingPlan(activePlan?.id ?? null);
  const history = plan ? parseFittedHistory(plan.diagnostics) : null;
  const fitError = lastFitError ? describeFitError(lastFitError) : null;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <span data-testid="auto-routing-status">
          {activePlan
            ? `Active plan from ${formatDate({ date: activePlan.createdAt })}${history ? `. ${learnedFrom(history)}` : ""}`
            : `Cold start: ${Math.min(coldStart.sessions, coldStart.required).toLocaleString("en-US")} of ${coldStart.required.toLocaleString("en-US")} scored sessions`}
        </span>
      </div>
      {fitError && (
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
      )}
    </div>
  );
}

function learnedFrom(history: FittedHistory): string {
  const past =
    history.past_sessions > 0
      ? ` (${history.past_sessions.toLocaleString("en-US")} from past traffic)`
      : "";
  const sessions = `Learned from ${history.sessions.toLocaleString("en-US")} sessions${past}`;
  return history.last_created_at
    ? `${sessions}, data up to ${formatDate({ date: history.last_created_at })}`
    : sessions;
}

function ActivePlanSummary({ settings }: { settings: AutoRoutingSettings }) {
  const { data: plan } = useAutoRoutingPlan(
    settings.status.activePlan?.id ?? null,
  );
  const tierModels = useFittedTierModels(
    plan?.tiersFingerprint ?? null,
    settings.tiers,
  );
  const summary = plan ? parsePlanSummary(plan.summary) : null;
  if (!plan || !summary) return null;
  return (
    <>
      <PlanSummaryView
        summary={summary}
        budgetUsdPerDay={plan.budgetUsdPerDay}
        tierModels={tierModels}
      />
      <WhatIf
        key={`${plan.id}-${plan.budgetUsdPerDay}`}
        savedBudgetUsdPerDay={plan.budgetUsdPerDay}
        savedTiers={settings.tiers}
      />
    </>
  );
}
