"use client";

import { useState } from "react";
import { QueryLoadError } from "@/components/query-load-error";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  type AutoRouter,
  type AutoRoutingPlanDetail,
  type AutoRoutingUsageDays,
  useAutoRoutingPlan,
  useAutoRoutingUsage,
} from "@/lib/auto-routing.query";
import { formatDate } from "@/lib/utils/date-time";
import { formatCurrency } from "@/lib/utils/format-currency";
import { cn } from "@/lib/utils/tailwind";
import { useFittedTierModels } from "./fitted-tier-models";
import { parseFittedHistory, parsePlanSummary } from "./plan-document";
import {
  PlanSummaryPlaceholder,
  PlanSummaryView,
  SummaryTile,
  TierShareBars,
} from "./plan-summary";
import { TIER_NAMES } from "./tiers";

type View = "plan" | AutoRoutingUsageDays;

const VIEWS: { id: View; label: string; ariaLabel: string }[] = [
  { id: "plan", label: "Plan", ariaLabel: "What the current plan expects" },
  { id: 7, label: "7 days", ariaLabel: "What it routed in the last 7 days" },
  { id: 14, label: "14 days", ariaLabel: "What it routed in the last 14 days" },
];

/**
 * The router's figures, one view at a time: what the current plan expects,
 * or what the router routed over the last 7 or 14 days.
 */
export function RouterFigures({ settings }: { settings: AutoRouter }) {
  const [view, setView] = useState<View>("plan");
  return (
    <section className="space-y-2" data-testid="auto-routing-figures">
      <div className="flex flex-wrap items-center justify-between gap-2">
        {view === "plan" ? (
          <PlanCaption settings={settings} />
        ) : (
          <p className="text-xs text-muted-foreground">
            What this router routed in the last {view} days, at billed cost
          </p>
        )}
        <div className="ml-auto inline-flex items-center rounded-md border bg-background p-0.5 shadow-xs">
          {VIEWS.map((option) => (
            <Button
              key={option.id}
              type="button"
              size="xs"
              variant="ghost"
              aria-label={option.ariaLabel}
              aria-pressed={view === option.id}
              onClick={() => setView(option.id)}
              className={cn(
                view === option.id
                  ? "bg-muted text-foreground hover:bg-muted"
                  : "text-muted-foreground",
              )}
            >
              {option.label}
            </Button>
          ))}
        </div>
      </div>
      {view === "plan" ? (
        <PlanFigures settings={settings} />
      ) : (
        <RoutedUsage settings={settings} days={view} />
      )}
    </section>
  );
}

// === Internal ===

function useActivePlan(settings: AutoRouter) {
  return useAutoRoutingPlan(settings.status.activePlan?.id ?? null);
}

/** The active plan's figures, or the same tiles empty while there is none. */
function PlanFigures({ settings }: { settings: AutoRouter }) {
  const { data: plan } = useActivePlan(settings);
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
        tierModels={currentTierModels(settings)}
      />
    );
  }
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

/** How fresh the plan is and how much it was learned from. */
function PlanCaption({ settings }: { settings: AutoRouter }) {
  const { data: plan } = useActivePlan(settings);
  return (
    <p
      className="text-xs text-muted-foreground"
      data-testid="auto-routing-plan-caption"
    >
      {plan ? planCaption(plan) : "What the plan expects, once there is one"}
    </p>
  );
}

function planCaption(plan: AutoRoutingPlanDetail): string {
  const history = parseFittedHistory(plan.diagnostics);
  return [
    `Plan updated ${formatDate({ date: plan.createdAt, dateFormat: "MMM d, HH:mm" })}`,
    history ? `${history.sessions.toLocaleString("en-US")} sessions` : null,
  ]
    .filter((part) => part !== null)
    .join(" · ");
}

/** What the router routed over the window, and what it saved against all-smart. */
function RoutedUsage({
  settings,
  days,
}: {
  settings: AutoRouter;
  days: AutoRoutingUsageDays;
}) {
  const query = useAutoRoutingUsage(days);
  if (query.isLoadingError) {
    return (
      <QueryLoadError
        title={`Couldn't load the last ${days} days`}
        error={query.error}
        onRetry={() => query.refetch()}
      />
    );
  }
  const usage = query.data;
  if (!usage) return <Skeleton className="h-56 w-full" />;
  if (usage.requests === 0) {
    return (
      <p
        className="rounded-md border px-4 py-6 text-center text-sm text-muted-foreground"
        data-testid="auto-routing-usage"
      >
        No requests went through this router in the last {usage.windowDays}{" "}
        days.
      </p>
    );
  }

  const smartModel = settings.tiers.smart?.modelId ?? "the smart model";
  const saved =
    usage.allSmartCostUsd === null
      ? null
      : usage.allSmartCostUsd - usage.costUsd;
  const byTier = TIER_NAMES.map(
    (tier) =>
      usage.tiers.find((row) => row.tier === tier) ?? {
        tier,
        sessions: 0,
        requests: 0,
        costUsd: 0,
      },
  );

  return (
    <div className="space-y-4" data-testid="auto-routing-usage">
      <div className="grid gap-3 sm:grid-cols-3">
        <SummaryTile label="Spend">
          <span className="text-2xl font-semibold tabular-nums">
            {formatCurrency(usage.costUsd)}
          </span>
          <span className="text-xs text-muted-foreground">
            {formatCurrency(usage.costUsd / usage.windowDays)}/day on average
          </span>
        </SummaryTile>
        <SummaryTile
          label={
            saved !== null && saved < 0
              ? "Extra vs all-smart"
              : "Saved vs all-smart"
          }
        >
          <span className="text-2xl font-semibold tabular-nums">
            {saved === null ? "–" : formatCurrency(Math.abs(saved))}
          </span>
          {saved !== null && usage.allSmartCostUsd !== null && (
            <span className="text-xs text-muted-foreground">
              {allSmartNote(saved, usage.allSmartCostUsd, smartModel)}
            </span>
          )}
        </SummaryTile>
        <SummaryTile label="Sessions">
          <span className="text-2xl font-semibold tabular-nums">
            {usage.sessions.toLocaleString("en-US")}
          </span>
          <span className="text-xs text-muted-foreground">
            {count(usage.requests, "request")}
          </span>
        </SummaryTile>
      </div>
      <TierShareBars
        title="Where sessions went"
        rows={[
          { name: "Sessions", shares: shares(byTier.map((t) => t.sessions)) },
          { name: "Spend", shares: shares(byTier.map((t) => t.costUsd)) },
        ]}
        tierModels={currentTierModels(settings)}
        legend={(i) =>
          `${count(byTier[i].sessions, "session")}, ${formatCurrency(byTier[i].costUsd)}`
        }
      />
    </div>
  );
}

/** How routed spend compares with sending everything to the smart model; spend can exceed it when a cheaper tier is priced above the smart one. */
function allSmartNote(
  saved: number,
  allSmartCostUsd: number,
  smartModel: string,
): string {
  if (allSmartCostUsd <= 0) {
    return `compared with sending everything to ${smartModel}`;
  }
  const percent = Math.round((100 * Math.abs(saved)) / allSmartCostUsd);
  return `${percent}% ${saved < 0 ? "more" : "less"} than sending everything to ${smartModel}`;
}

function currentTierModels(settings: AutoRouter) {
  return {
    fast: settings.tiers.fast?.modelId ?? "unknown",
    normal: settings.tiers.normal?.modelId ?? "unknown",
    smart: settings.tiers.smart?.modelId ?? "unknown",
  };
}

function shares(values: number[]): number[] {
  const total = values.reduce((sum, value) => sum + value, 0);
  return values.map((value) => (total > 0 ? value / total : 0));
}

function count(value: number, noun: string): string {
  return `${value.toLocaleString("en-US")} ${noun}${value === 1 ? "" : "s"}`;
}
