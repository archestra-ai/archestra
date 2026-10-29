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
import { AddJevKeyLink } from "./_parts/add-jev-key";
import { useFittedTierModels } from "./_parts/fitted-tier-models";
import { PastSessions } from "./_parts/past-sessions";
import { describeFitError, parsePlanSummary } from "./_parts/plan-document";
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
      <PastSessions
        routingEnabled={settings.enabled}
        hasActivePlan={settings.status.activePlan !== null}
        canUpdate={canUpdate}
        scorer={settings.status.scorer}
      />
      <ActivePlanSummary settings={settings} />
      <TryPrompt canUpdate={canUpdate} scorer={settings.status.scorer} />
    </div>
  );
}

function PlanStatus({ settings }: { settings: AutoRoutingSettings }) {
  const { activePlan, coldStart, lastFitError, scorer } = settings.status;
  const fitError = lastFitError ? describeFitError(lastFitError) : null;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <span
          className="flex items-center gap-2"
          data-testid="auto-routing-status"
        >
          <span
            aria-hidden
            className={
              activePlan
                ? "size-2 rounded-full bg-primary"
                : "size-2 rounded-full border border-muted-foreground"
            }
          />
          {activePlan ? (
            <span className="font-medium">Active plan</span>
          ) : coldStart.sessions < coldStart.required ? (
            <span>
              <span className="font-medium">Cold start</span>
              <span className="text-muted-foreground">
                {" "}
                · {count(coldStart.sessions)} of {count(coldStart.required)}{" "}
                sessions scored
              </span>
            </span>
          ) : (
            <span>
              <span className="font-medium">
                {!settings.enabled
                  ? "Auto routing is off"
                  : fitError
                    ? "No plan yet"
                    : "Fitting the first plan"}
              </span>
              <span className="text-muted-foreground">
                {" "}
                · {count(coldStart.sessions)} sessions scored, enough for a plan
              </span>
            </span>
          )}
        </span>
        {!activePlan && scorer === "no_jev_key" && <AddJevKeyLink />}
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

function count(value: number): string {
  return value.toLocaleString("en-US");
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
