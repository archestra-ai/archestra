"use client";

import { AlertTriangle, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { InlineNotice, InlineNoticeText } from "@/components/ui/inline-notice";
import { useHasPermissions } from "@/lib/auth/auth.query";
import {
  type AutoRoutingSettings,
  useAutoRoutingPlan,
  useAutoRoutingSettings,
  useReplanAutoRouting,
} from "@/lib/auto-routing.query";
import { formatDate } from "@/lib/utils/date-time";
import { parsePlanSummary } from "./_parts/plan-document";
import { PlanSummaryView } from "./_parts/plan-summary";
import { AutoRoutingSettingsForm } from "./_parts/settings-form";
import { TryPrompt } from "./_parts/try-prompt";

export default function AutoRoutingOverviewPage() {
  const { data: settings, isPending } = useAutoRoutingSettings();
  const { data: canUpdate = false } = useHasPermissions({
    llmProxy: ["update"],
  });
  if (isPending || !settings) return null;

  return (
    <div className="space-y-6">
      <AutoRoutingSettingsForm settings={settings} canUpdate={canUpdate} />
      <PlanStatus settings={settings} canUpdate={canUpdate} />
      <ActivePlanSummary settings={settings} />
      <TryPrompt canUpdate={canUpdate} />
    </div>
  );
}

function PlanStatus({
  settings,
  canUpdate,
}: {
  settings: AutoRoutingSettings;
  canUpdate: boolean;
}) {
  const replan = useReplanAutoRouting();
  const { activePlan, coldStart, lastFitError } = settings.status;
  const pending = settings.generation > settings.plannedGeneration;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <span data-testid="auto-routing-status">
          {activePlan
            ? `Active plan from ${formatDate({ date: activePlan.createdAt })}`
            : `Cold start: ${coldStart.sessions} of ${coldStart.required} sessions`}
        </span>
        {pending && (
          <span className="text-muted-foreground">Re-plan pending</span>
        )}
        {canUpdate && (
          <Button
            size="sm"
            variant="outline"
            className="ml-auto"
            disabled={replan.isPending}
            onClick={() => replan.mutate()}
          >
            <RefreshCw />
            <span>Re-plan now</span>
          </Button>
        )}
      </div>
      {lastFitError && (
        <InlineNotice variant="error">
          <AlertTriangle />
          <span className="font-medium">Last fit failed</span>
          <InlineNoticeText>{lastFitError}</InlineNoticeText>
        </InlineNotice>
      )}
    </div>
  );
}

function ActivePlanSummary({ settings }: { settings: AutoRoutingSettings }) {
  const { data: plan } = useAutoRoutingPlan(
    settings.status.activePlan?.id ?? null,
  );
  const summary = plan ? parsePlanSummary(plan.summary) : null;
  if (!plan || !summary) return null;
  return (
    <PlanSummaryView
      summary={summary}
      budgetUsdPerDay={plan.budgetUsdPerDay}
      tiers={settings.tiers}
    />
  );
}
