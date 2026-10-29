"use client";

import { RotateCw } from "lucide-react";
import { useMemo, useState } from "react";
import { QueryLoadError } from "@/components/query-load-error";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Slider } from "@/components/ui/slider";
import {
  type AutoRoutingDiagnostics,
  useAutoRoutingDiagnostics,
  useAutoRoutingPlan,
  useAutoRoutingSettings,
} from "@/lib/auto-routing.query";
import { useDebouncedValue } from "@/lib/hooks/use-debounced-value";
import { formatDate } from "@/lib/utils/date-time";
import { formatCurrency } from "@/lib/utils/format-currency";
import { budgetScale } from "../_parts/budget-scale";
import {
  JevHistograms,
  RoutingTriangle,
  SizeScatter,
} from "../_parts/diagnostics-charts";
import { parseFittedHistory } from "../_parts/plan-document";
import { TIER_COLOR, TIER_NAMES } from "../_parts/tiers";

type Ready = Extract<AutoRoutingDiagnostics, { status: "ready" }>;

export default function AutoRoutingDiagnosticsPage() {
  const saved = useAutoRoutingDiagnostics(null);

  if (saved.isLoadingError) {
    return (
      <QueryLoadError
        title="Couldn't load diagnostics"
        error={saved.error}
        onRetry={() => saved.refetch()}
      />
    );
  }
  const data = saved.data;
  if (!data) return <Skeleton className="h-96 w-full" />;
  switch (data.status) {
    case "cold_start":
      return <EmptyLine>No active plan yet.</EmptyLine>;
    case "infeasible":
      return (
        <EmptyLine>
          {`Saved budget is below the cheapest routing (${formatCurrency(data.minBudgetUsdPerDay)}/day).`}
        </EmptyLine>
      );
  }

  const fit = data.sizeFit.status === "ok" ? data.sizeFit : null;
  return (
    <div className="space-y-8">
      <TrainingSummary />
      <Block title="Jev answers">
        <JevHistograms sessions={data.sessions} />
      </Block>
      <Block
        title="Predicted vs realized tokens"
        metrics={[
          { label: "Spearman", value: formatNumber(fit?.spearman) },
          {
            label: "Median realized / predicted",
            value:
              fit?.medianRealizedOverPredicted == null
                ? "–"
                : `${fit.medianRealizedOverPredicted.toFixed(2)}×`,
          },
          { label: "Plotted", value: fit ? String(fit.plotted) : "–" },
          { label: "Excluded", value: fit ? String(fit.excluded) : "–" },
        ]}
      >
        <SizeScatter sessions={data.sessions} />
      </Block>
      <RoutingBlock saved={data} />
    </div>
  );
}

/** Each result is shown under the budget it was solved at, the previous one dimmed while the next is pending. */
function RoutingBlock({ saved }: { saved: Ready }) {
  const scale = useMemo(
    () => budgetScale(saved.savedBudgetUsdPerDay),
    [saved.savedBudgetUsdPerDay],
  );
  // The absolute budget survives a saved-budget refresh; the raw coordinate keeps arrow steps
  // advancing through cent-rounding plateaus and is valid only on the scale it was picked on.
  const [selected, setSelected] = useState<{
    budget: number;
    at: number;
    onScaleOf: number;
  } | null>(null);
  const requested = selected?.budget ?? saved.savedBudgetUsdPerDay;
  const at =
    selected?.onScaleOf === saved.savedBudgetUsdPerDay
      ? selected.at
      : scale.positionOf(requested);
  const debounced = useDebouncedValue(requested, 300);
  const routed = useAutoRoutingDiagnostics(
    selected === null || debounced === saved.savedBudgetUsdPerDay
      ? null
      : debounced,
  );
  const [shown, setShown] = useState<AutoRoutingDiagnostics>(saved);
  if (routed.data && !routed.isPlaceholderData && routed.data !== shown) {
    setShown(routed.data);
  }
  const shownBudget =
    shown.status === "cold_start" ? null : shown.budgetUsdPerDay;

  return (
    <Block
      title="Routing regions"
      metrics={
        shown.status === "ready"
          ? TIER_NAMES.map((tier, i) => ({
              label: tier,
              swatch: TIER_COLOR[tier].swatch,
              value: `${Math.round(shown.tierSessionShare[i] * 100)}%`,
            }))
          : []
      }
    >
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <Label>Budget</Label>
          <div className="flex items-center gap-1">
            {routed.isError && (
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label="Retry"
                className="text-destructive"
                onClick={() => routed.refetch()}
              >
                <RotateCw />
              </Button>
            )}
            <output aria-label="Shown budget" className="text-sm tabular-nums">
              {shownBudget === null
                ? "–"
                : `${formatCurrency(shownBudget)}/day`}
            </output>
          </div>
        </div>
        <Slider
          aria-label="Budget"
          aria-valuetext={`${formatCurrency(requested)}/day`}
          min={0}
          max={scale.steps}
          step={1}
          value={[at]}
          onValueChange={([value]) =>
            setSelected({
              budget: scale.budgetAt(value),
              at: value,
              onScaleOf: saved.savedBudgetUsdPerDay,
            })
          }
        />
      </div>
      <div className={requested !== shownBudget ? "opacity-60" : undefined}>
        <RoutedView data={shown} />
      </div>
    </Block>
  );
}

function RoutedView({ data }: { data: AutoRoutingDiagnostics }) {
  switch (data.status) {
    case "ready":
      return <RoutingTriangle data={data} />;
    case "infeasible":
      return (
        <EmptyLine>
          {`Below the cheapest routing (${formatCurrency(data.minBudgetUsdPerDay)}/day).`}
        </EmptyLine>
      );
    case "cold_start":
      return <EmptyLine>No active plan yet.</EmptyLine>;
  }
}

/** What the active plan was fitted on: how many sessions, how many from past traffic, and how recent. */
function TrainingSummary() {
  const { data: settings } = useAutoRoutingSettings();
  const { data: plan } = useAutoRoutingPlan(
    settings?.status.activePlan?.id ?? null,
  );
  const history = plan ? parseFittedHistory(plan.diagnostics) : null;
  if (!history) return null;
  const items = [
    {
      label: "Trained on",
      value: `${history.sessions.toLocaleString("en-US")} sessions`,
    },
    {
      label: "Past traffic",
      value: `${Math.round((100 * history.past_sessions) / Math.max(history.sessions, 1))}%`,
    },
    ...(history.last_created_at
      ? [
          {
            label: "Data up to",
            value: formatDate({
              date: history.last_created_at,
              dateFormat: "MMM d, yyyy",
            }),
          },
        ]
      : []),
  ];
  return (
    <dl
      className="flex flex-wrap gap-x-8 gap-y-1 text-sm"
      data-testid="auto-routing-training-summary"
    >
      {items.map((item) => (
        <div key={item.label} className="flex gap-2">
          <dt className="text-muted-foreground">{item.label}</dt>
          <dd className="tabular-nums">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function Block({
  title,
  metrics = [],
  children,
}: {
  title: string;
  metrics?: { label: string; value: string; swatch?: string }[];
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-4 rounded-md border p-4" aria-label={title}>
      <h3 className="text-sm font-medium">{title}</h3>
      {metrics.length > 0 && (
        <dl className="flex flex-wrap gap-x-10 gap-y-2">
          {metrics.map((metric) => (
            <div key={metric.label}>
              <dt className="flex items-center gap-1.5 text-xs text-muted-foreground">
                {metric.swatch && (
                  <span className={`size-2.5 rounded-sm ${metric.swatch}`} />
                )}
                <span>{metric.label}</span>
              </dt>
              <dd className="text-2xl tabular-nums">{metric.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {children}
    </section>
  );
}

function EmptyLine({ children }: { children: React.ReactNode }) {
  return <p className="text-sm text-muted-foreground">{children}</p>;
}

function formatNumber(value: number | null | undefined): string {
  return value == null ? "–" : value.toFixed(2);
}
