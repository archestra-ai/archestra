"use client";
import { ClipboardCopy, X } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { UnstyledButton } from "@/components/ui/unstyled-button";
import { cn } from "@/lib/utils/tailwind";
import type { ChartKind } from "../(costs)/costs/cost-explorer-data";
import {
  ApiLine,
  ChartKindToggle,
  copyCsv,
  PivotChart,
  PivotTable,
  QueryChip,
  Segmented,
  SummaryTable,
} from "../(costs)/costs/cost-explorer-parts";
import { fmtMetric, KpiTile } from "../(costs)/costs/cost-overview";
import type { UsageViewProps } from "./usage-data";
import {
  supportsUsage,
  USAGE_GROUPS,
  USAGE_METRICS,
  type UsageGroup,
  type UsageMetric,
  usageCube,
  usageSeries,
} from "./usage-explorer-data";

const VIEWS: { label: string; group: UsageGroup; metric: UsageMetric }[] = [
  { label: "Spend by model", group: "model", metric: "billed" },
  { label: "Usage by client", group: "client", metric: "requests" },
  { label: "Activity over time", group: "time", metric: "requests" },
  { label: "Token mix", group: "token", metric: "tokens" },
  { label: "Context size", group: "context", metric: "requests" },
  { label: "Costliest sessions", group: "session", metric: "billed" },
];
export function UsageContent(props: UsageViewProps) {
  const [metric, setMetric] = useState<UsageMetric>("billed");
  const [group, setGroup] = useState<UsageGroup>("model");
  const [split, setSplit] = useState(false);
  const [chart, setChart] = useState<ChartKind>("bars");
  const [view, setView] = useState<"summary" | "pivot">("summary");
  const [focus, setFocus] = useState<Set<string>>(new Set());
  const canSplit =
    metric === "tokens" && (group === "model" || group === "client");
  const cube = usageCube(props, metric, group, canSplit && split);
  const canPivot = (canSplit && split) || cube.rows.some((r) => r.hasSeries);
  const effectiveView = canPivot ? view : "summary";
  const label = USAGE_GROUPS.find((g) => g.id === group)?.label ?? "Model";
  const metricLabel =
    USAGE_METRICS.find((m) => m.id === metric)?.label ?? "Billed spend";
  function select(nextGroup: UsageGroup, nextMetric: UsageMetric) {
    setGroup(nextGroup);
    if (nextGroup !== "time")
      setChart((current) => (current === "lines" ? "bars" : current));
    setMetric(
      supportsUsage(nextGroup, nextMetric)
        ? nextMetric
        : nextGroup === "token"
          ? "tokens"
          : "requests",
    );
    setSplit(false);
    setView("summary");
    setFocus(new Set());
  }
  const toggle = (key: string) =>
    setFocus((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  // Aggregate bars use actual row totals; they are never presented as a daily series.
  const aggregate = {
    ...cube,
    splitKeys: [{ key: "total", label: metricLabel, total: cube.total }],
    rows: cube.rows.map((r) => ({
      ...r,
      children: [
        { key: "total", label: metricLabel, total: r.total, series: [] },
      ],
    })),
  };
  const { statistics } = props;
  const tiles = [
    {
      id: "billed",
      label: "Billed spend",
      value: statistics.billedCost,
      caption: "Metered API-key usage",
    },
    {
      id: "subscription",
      label: "Subscription estimate",
      value: statistics.subscriptionCost,
      caption: "Equivalent API rates; not an additional bill",
    },
    {
      id: "requests",
      label: "Requests",
      value: statistics.requests,
      caption: "Your LLM requests",
    },
    {
      id: "tokens",
      label: "Tokens",
      value: statistics.totalTokens,
      caption: "Input + output; excludes cache reads",
    },
  ] as const;
  return (
    <div className="min-w-0 space-y-4">
      <section
        aria-label="Your usage"
        className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5"
      >
        {tiles.map((t) => (
          <KpiTile
            key={t.id}
            label={t.label}
            value={fmtMetric(t.id, t.value, true)}
            caption={t.caption}
            series={usageSeries(statistics, t.id)}
            colorClass={
              t.id === "tokens"
                ? "text-chart-3"
                : t.id === "requests"
                  ? "text-chart-2"
                  : t.id === "subscription"
                    ? "text-muted-foreground"
                    : "text-chart-1"
            }
            estimate={t.id === "subscription"}
            active={metric === t.id}
            onClick={() =>
              select(supportsUsage(group, t.id) ? group : "model", t.id)
            }
          />
        ))}
        <KpiTile
          label="Active days"
          value={statistics.activeDays.toLocaleString()}
          caption={
            statistics.lastActiveAt
              ? `Last active ${new Date(statistics.lastActiveAt).toLocaleString()}`
              : "No recorded activity"
          }
        />
      </section>
      <nav aria-label="Usage views" className="flex flex-wrap gap-1.5">
        {VIEWS.map((v) => (
          <UnstyledButton
            key={v.label}
            onClick={() => select(v.group, v.metric)}
            className={cn(
              "h-7 rounded-full border px-3 text-xs transition-colors",
              group === v.group && metric === v.metric
                ? "border-foreground bg-foreground text-background"
                : "bg-background text-muted-foreground hover:border-foreground/40 hover:text-foreground dark:bg-input/30",
            )}
          >
            <span>{v.label}</span>
          </UnstyledButton>
        ))}
      </nav>
      <section
        aria-label="Usage explorer"
        className="min-w-0 overflow-hidden rounded-xl border bg-card"
      >
        <div className="flex flex-wrap items-center gap-2 border-b bg-muted/30 px-3 py-2.5">
          <QueryChip
            label="Show"
            value={metric}
            options={USAGE_METRICS.map((m) => ({
              ...m,
              disabled: !supportsUsage(group, m.id),
              hint: "Not available for this grouping",
            }))}
            onChange={(m) => select(group, m)}
          />
          <QueryChip
            label="by"
            value={group}
            options={USAGE_GROUPS}
            onChange={(g) => select(g, metric)}
          />
          <QueryChip
            label="split by"
            value={split && canSplit ? "token" : "none"}
            options={[
              { id: "none", label: "None" },
              {
                id: "token",
                label: "Input / output",
                disabled: !canSplit,
                hint: "Available for model or client tokens",
              },
            ]}
            onChange={(s) => {
              setSplit(s === "token");
              setFocus(new Set());
            }}
          />
          <div className="ml-auto">
            <ChartKindToggle
              value={chart}
              onChange={(kind) => {
                setChart(kind);
                if (kind === "lines" && group !== "time")
                  select("time", metric);
              }}
            />
          </div>
        </div>
        <div className="space-y-2 px-4 py-4">
          <div className="flex flex-wrap items-baseline gap-3">
            <span className="text-3xl font-semibold tabular-nums">
              {fmtMetric(metric, cube.total, true)}
            </span>
            <span className="text-sm text-muted-foreground">
              {metricLabel} by {label.toLowerCase()}
            </span>
          </div>
          <p className="text-xs text-muted-foreground">
            {metric === "subscription" && (
              <span>
                Subscription usage valued at equivalent API rates; subscription
                fees are excluded.{" "}
              </span>
            )}
            {cube.notice}
          </p>
        </div>
        {chart !== "table" && cube.rows.length > 0 && (
          <div className="px-4 pb-4">
            <PivotChart
              cube={group === "time" || (canSplit && split) ? cube : aggregate}
              metric={metric}
              kind={group === "time" ? chart : "bars"}
              split={group !== "time"}
              focus={focus}
            />
            <p className="mt-2 text-xs text-muted-foreground">
              {group === "time"
                ? "Overall personal activity for the selected range."
                : "Totals for the selected range."}
            </p>
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2 border-y px-3 py-2">
          <Segmented
            value={effectiveView}
            onChange={setView}
            items={[
              { id: "summary", label: "Summary" },
              {
                id: "pivot",
                label: "Pivot",
                disabled: !canPivot,
                title: !canPivot
                  ? "Choose Time, or split model/client tokens by input/output, to pivot available data."
                  : undefined,
              },
            ]}
          />
          {focus.size > 0 ? (
            <span className="inline-flex min-w-0 items-center gap-1 rounded-full bg-primary/10 py-0.5 pr-1 pl-2.5 text-primary text-xs">
              <span className="truncate">
                Chart shows{" "}
                {cube.rows
                  .filter((row) => focus.has(row.key))
                  .slice(0, 2)
                  .map((row) => row.label)
                  .join(", ")}
                {focus.size > 2 && <span> +{focus.size - 2}</span>}
              </span>
              <UnstyledButton
                aria-label="Clear selection"
                onClick={() => setFocus(new Set())}
                className="rounded-full p-0.5 hover:bg-primary/15"
              >
                <X className="size-3" />
              </UnstyledButton>
            </span>
          ) : (
            chart !== "table" && (
              <span className="hidden text-muted-foreground text-xs md:inline">
                Click rows to compare them in the chart
              </span>
            )
          )}
          <Button
            variant="ghost"
            size="xs"
            className="ml-auto"
            disabled={cube.rows.length === 0}
            onClick={() =>
              copyCsv({
                cube,
                metric,
                dimLabel: label,
                view: effectiveView,
                bySplit: canSplit && split,
              })
            }
          >
            <ClipboardCopy />
            <span>Copy as CSV</span>
          </Button>
        </div>
        {effectiveView === "pivot" ? (
          <PivotTable
            cube={cube}
            metric={metric}
            dimLabel={label}
            bySplit={canSplit && split}
            focus={focus}
            onToggle={toggle}
          />
        ) : (
          <SummaryTable
            showTimeline={cube.rows.some((row) => row.hasSeries)}
            key={`${group}-${metric}`}
            cube={cube}
            metric={metric}
            dimLabel={label}
            splitLabel={canSplit && split ? "Token type" : null}
            focus={focus}
            onToggle={toggle}
          />
        )}
        <ApiLine call={cube.api} />
      </section>
    </div>
  );
}
