"use client";

import { AlertTriangle } from "lucide-react";
import { QueryLoadError } from "@/components/query-load-error";
import { InlineNotice, InlineNoticeText } from "@/components/ui/inline-notice";
import { useHasPermissions } from "@/lib/auth/auth.query";
import {
  type AutoRoutingPlanDetail,
  type AutoRoutingSettings,
  useAutoRoutingPlan,
  useAutoRoutingSettings,
} from "@/lib/auto-routing.query";
import { useLlmModels } from "@/lib/llm-models.query";
import { formatDate } from "@/lib/utils/date-time";
import {
  describeFitError,
  type FittedHistory,
  parseFittedHistory,
  parsePlanSummary,
  parseTierModelIds,
} from "./_parts/plan-document";
import { PlanSummaryView } from "./_parts/plan-summary";
import { AutoRoutingSettingsForm } from "./_parts/settings-form";
import type { TierName } from "./_parts/tiers";
import { TryPrompt } from "./_parts/try-prompt";

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
            : `Cold start: ${coldStart.sessions} of ${coldStart.required} sessions`}
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
  const sessions = `Learned from ${history.sessions.toLocaleString("en-US")} sessions`;
  return history.last_created_at
    ? `${sessions}, data up to ${formatDate({ date: history.last_created_at })}`
    : sessions;
}

function ActivePlanSummary({ settings }: { settings: AutoRoutingSettings }) {
  const { data: plan } = useAutoRoutingPlan(
    settings.status.activePlan?.id ?? null,
  );
  const tierModels = usePlanTierModels(plan, settings);
  const summary = plan ? parsePlanSummary(plan.summary) : null;
  if (!plan || !summary) return null;
  return (
    <PlanSummaryView
      summary={summary}
      budgetUsdPerDay={plan.budgetUsdPerDay}
      tierModels={tierModels}
    />
  );
}

/** The models the plan was fitted for, which the current tiers may no longer be. */
function usePlanTierModels(
  plan: AutoRoutingPlanDetail | null | undefined,
  settings: AutoRoutingSettings,
): Record<TierName, string> {
  const { data: models = [] } = useLlmModels();
  const ids = plan ? parseTierModelIds(plan.tiersFingerprint) : null;
  const saved = Object.values(settings.tiers);
  const name = (id: string) =>
    models.find((model) => model.dbId === id)?.id ??
    saved.find((tier) => tier?.id === id)?.modelId ??
    id;
  return {
    fast: ids ? name(ids[0]) : "unknown",
    normal: ids ? name(ids[1]) : "unknown",
    smart: ids ? name(ids[2]) : "unknown",
  };
}
