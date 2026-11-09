"use client";

import { AlertTriangle } from "lucide-react";
import { QueryLoadError } from "@/components/query-load-error";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { InlineNotice, InlineNoticeText } from "@/components/ui/inline-notice";
import { useHasPermissions } from "@/lib/auth/auth.query";
import {
  type AutoRoutingSettings,
  useAutoRoutingPlan,
  useAutoRoutingSettings,
} from "@/lib/auto-routing.query";
import { formatDate } from "@/lib/utils/date-time";
import { AddJevKeyLink } from "./_parts/add-jev-key";
import { useFittedTierModels } from "./_parts/fitted-tier-models";
import { PastSessions } from "./_parts/past-sessions";
import { describeFitError, parsePlanSummary } from "./_parts/plan-document";
import { PlanSummaryView } from "./_parts/plan-summary";
import {
  isAutoRoutingSetUp,
  SetupCards,
  UsageLine,
} from "./_parts/setup-cards";

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

  if (!isAutoRoutingSetUp(settings)) {
    return (
      <div className="space-y-6">
        <SetupCards settings={settings} />
        <PastSessions
          routingEnabled={settings.enabled}
          hasActivePlan={settings.status.activePlan !== null}
          canUpdate={canUpdate}
          scorer={settings.status.scorer}
        />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <PlanStatus settings={settings} />
      <PastSessions
        routingEnabled={settings.enabled}
        hasActivePlan={settings.status.activePlan !== null}
        canUpdate={canUpdate}
        scorer={settings.status.scorer}
      />
      <ActivePlanSummary settings={settings} />
    </div>
  );
}

/** Where routing stands, and what runs on Auto. */
function PlanStatus({ settings }: { settings: AutoRoutingSettings }) {
  const { activePlan, coldStart, lastFitError, scorer } = settings.status;
  const fitError = lastFitError ? describeFitError(lastFitError) : null;

  return (
    <Card className="gap-3 py-4">
      <CardHeader className="px-4">
        <CardTitle className="text-sm">
          <span
            className="flex flex-wrap items-center gap-2"
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
              <span>
                <span>Active plan</span>
                <span className="font-normal text-muted-foreground">
                  {" "}
                  · fitted{" "}
                  {formatDate({
                    date: activePlan.createdAt,
                    dateFormat: "MMM d, HH:mm",
                  })}
                </span>
              </span>
            ) : coldStart.sessions < coldStart.required ? (
              <span>
                <span>Cold start</span>
                <span className="font-normal text-muted-foreground">
                  {" "}
                  · {count(coldStart.sessions)} of {count(coldStart.required)}{" "}
                  sessions scored
                </span>
              </span>
            ) : (
              <span>
                <span>
                  {!settings.enabled
                    ? "Auto routing is off"
                    : fitError
                      ? "No plan yet"
                      : "Fitting the first plan"}
                </span>
                <span className="font-normal text-muted-foreground">
                  {" "}
                  · {count(coldStart.sessions)} sessions scored, enough for a
                  plan
                </span>
              </span>
            )}
          </span>
        </CardTitle>
        <CardDescription>
          <UsageLine settings={settings} />
        </CardDescription>
        {!activePlan && scorer === "no_jev_key" && (
          <CardAction>
            <AddJevKeyLink />
          </CardAction>
        )}
      </CardHeader>
      {fitError && (
        <CardContent className="px-4">
          <InlineNotice variant="error">
            <AlertTriangle />
            <span className="font-medium">Last fit failed</span>
            <InlineNoticeText>
              {fitError.message}
              {fitError.code && (
                <span className="ml-1 font-mono text-xs">
                  ({fitError.code})
                </span>
              )}
            </InlineNoticeText>
          </InlineNotice>
        </CardContent>
      )}
    </Card>
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
  if (!plan || !summary || plan.budgetUsdPerDay === null) return null;
  return (
    <PlanSummaryView
      summary={summary}
      budgetUsdPerDay={plan.budgetUsdPerDay}
      // A plan fitted before the preset was picked keeps serving until a new one is.
      budgetPreset={
        plan.generation === settings.generation ? settings.budgetPreset : null
      }
      tierModels={tierModels}
    />
  );
}
