"use client";

import { useState } from "react";
import { QueryLoadError } from "@/components/query-load-error";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Slider } from "@/components/ui/slider";
import {
  type AutoRoutingDiagnostics,
  useAutoRoutingDiagnostics,
} from "@/lib/auto-routing.query";
import { useDebouncedValue } from "@/lib/hooks/use-debounced-value";
import { formatCurrency } from "@/lib/utils/format-currency";
import {
  JevHistograms,
  RoutingTriangle,
  SizeScatter,
  TIER_COLOR,
} from "../_parts/diagnostics-charts";
import { TIER_NAMES } from "../_parts/tiers";

export default function AutoRoutingDiagnosticsPage() {
  const saved = useAutoRoutingDiagnostics(null);
  const [budget, setBudget] = useState<number | null>(null);
  const debouncedBudget = useDebouncedValue(budget, 300);
  const routed = useAutoRoutingDiagnostics(debouncedBudget);

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

  const shown = routed.data ?? data;
  const sliderValue = budget ?? data.savedBudgetUsdPerDay;
  return (
    <div className="space-y-8">
      <Block title="Jev answers">
        <JevHistograms sessions={data.sessions} />
      </Block>
      <Block
        title="Predicted vs realized tokens"
        metrics={[
          { label: "Spearman", value: formatNumber(data.sizeFit.spearman) },
          {
            label: "Median realized / predicted",
            value:
              data.sizeFit.medianRealizedOverPredicted === null
                ? "–"
                : `${data.sizeFit.medianRealizedOverPredicted.toFixed(2)}×`,
          },
        ]}
      >
        <SizeScatter sessions={data.sessions} />
      </Block>
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
          <div className="flex items-center justify-between">
            <Label>Budget</Label>
            <span className="text-sm tabular-nums">
              {formatCurrency(sliderValue)}/day
            </span>
          </div>
          <Slider
            aria-label="Budget"
            min={1}
            max={Math.ceil(data.savedBudgetUsdPerDay * 4)}
            step={1}
            value={[sliderValue]}
            onValueChange={([value]) => setBudget(value)}
          />
        </div>
        <div className={routed.isFetching ? "opacity-60" : undefined}>
          <RoutedView data={shown} />
        </div>
      </Block>
    </div>
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

function formatNumber(value: number | null): string {
  return value === null ? "–" : value.toFixed(2);
}
