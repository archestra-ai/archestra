"use client";
import { ClipboardCopy, X } from "lucide-react";
import type { SetStateAction } from "react";
import { QueryLoadError } from "@/components/query-load-error";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { UnstyledButton } from "@/components/ui/unstyled-button";
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
import { ExplorerToolbar } from "../(costs)/costs/explorer-toolbar";
import {
  decodePersonalExplorer,
  EXPLORER_URL_KEYS,
  encodePersonalExplorer,
} from "../(costs)/costs/explorer-url-state";
import { useModelUsageCube } from "../(costs)/costs/model-usage.query";
import { useExplorerUrlState } from "../(costs)/costs/use-explorer-url-state";
import { useResponsiveChart } from "../(costs)/costs/use-responsive-chart";
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
  { label: "Cache reads by model", group: "model", metric: "cacheRead" },
  { label: "Prompt cache savings", group: "overall", metric: "cacheSavings" },
  { label: "Token mix", group: "token", metric: "tokens" },
  { label: "Context size", group: "context", metric: "requests" },
  { label: "Costliest sessions", group: "session", metric: "billed" },
];
export function UsageContent(props: UsageViewProps) {
  const [explorer, setExplorer] = useExplorerUrlState({
    keys: EXPLORER_URL_KEYS,
    decode: decodePersonalExplorer,
    encode: encodePersonalExplorer,
    timeframe: props.timeframe,
  });
  const { model, metric, group, split, view, focus } = explorer;
  const setModel = (value: SetStateAction<string | undefined>) =>
    setExplorer("model", value);
  const setMetric = (value: SetStateAction<UsageMetric>) =>
    setExplorer("metric", value);
  const setGroup = (value: SetStateAction<UsageGroup>) =>
    setExplorer("group", value);
  const setSplit = (value: SetStateAction<boolean>) =>
    setExplorer("split", value);
  const [chart, setChart] = useResponsiveChart(
    explorer.chart,
    explorer.mobileChart,
    (chart) => setExplorer("chart", chart),
    (chart) => setExplorer("mobileChart", chart),
  );
  const setView = (value: SetStateAction<"summary" | "pivot">) =>
    setExplorer("view", value);
  const setFocus = (value: SetStateAction<Set<string>>) =>
    setExplorer("focus", value);
  const canSplit =
    !model && metric === "tokens" && (group === "model" || group === "client");
  const unfilteredCube = usageCube(props, metric, group, canSplit && split);
  const modelCube = useModelUsageCube({
    model,
    group: group === "time" ? "time" : "client",
    metric,
    timeframe: props.timeframe,
    own: true,
  });
  const cube = model ? modelCube : unfilteredCube;
  const drilldown = (model: string) => {
    setModel(model);
    select("client", metric);
  };
  const canPivot = (canSplit && split) || cube.rows.some((r) => r.hasSeries);
  const effectiveView = canPivot ? view : "summary";
  const label = USAGE_GROUPS.find((g) => g.id === group)?.label ?? "Model";
  const metricLabel =
    USAGE_METRICS.find((m) => m.id === metric)?.label ?? "Billed spend";
  function select(nextGroup: UsageGroup, nextMetric: UsageMetric) {
    setGroup(nextGroup);
    if (nextMetric === "cacheSavings") setChart("table");
    else if (nextGroup !== "time")
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
  const activeView = VIEWS.find(
    (v) => v.group === group && v.metric === metric,
  );
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
      caption:
        "Newly processed input and output. Reused cached input is separate.",
    },
  ] as const;
  const queryControls = (
    <>
      {/* A view is a preset of the controls beside it; changing any of
              them makes the view custom. */}
      <QueryChip
        label="View"
        className="max-sm:grow"
        value={activeView?.label ?? CUSTOM_VIEW}
        options={[
          ...VIEWS.filter(
            (v) => !model || ["client", "time"].includes(v.group),
          ).map((v) => ({ id: v.label, label: v.label })),
          ...(activeView
            ? []
            : [{ id: CUSTOM_VIEW, label: "Custom", disabled: true }]),
        ]}
        onChange={(id) => {
          const view = VIEWS.find((v) => v.label === id);
          if (view) select(view.group, view.metric);
        }}
      />
      <QueryChip
        label="Show"
        className="max-sm:grow"
        value={metric}
        options={USAGE_METRICS.filter((m) => !model || m.id !== "cacheSavings")}
        onChange={(m) =>
          select(
            supportsUsage(group, m)
              ? group
              : m === "cacheSavings"
                ? "overall"
                : "model",
            m,
          )
        }
      />
      <QueryChip
        label="by"
        className="max-sm:grow"
        value={group}
        options={USAGE_GROUPS.filter(
          (g) => !model || ["client", "time"].includes(g.id),
        ).map((g) => ({
          ...g,
          disabled: !supportsUsage(g.id, metric),
          hint: "Not available for this metric",
        }))}
        onChange={(g) => select(g, metric)}
      />
      {canSplit && (
        <QueryChip
          label="split by"
          className="max-sm:grow"
          value={split && canSplit ? "token" : "none"}
          options={[
            { id: "none", label: "None" },
            {
              id: "token",
              label: "Token type",
            },
          ]}
          onChange={(s) => {
            setSplit(s === "token");
            setFocus(new Set());
          }}
        />
      )}
    </>
  );

  return (
    <div className="min-w-0 space-y-4">
      <section
        aria-label="Your usage"
        className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5 [&>*:last-child:nth-child(odd)]:col-span-2 md:[&>*:last-child:nth-child(odd)]:col-span-1"
      >
        {tiles.map((t) => (
          <KpiTile
            key={t.id}
            pending={props.isRefreshing}
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
          />
        ))}
        <KpiTile
          label="Active days"
          pending={props.isRefreshing}
          value={statistics.activeDays.toLocaleString()}
          caption={
            statistics.lastActiveAt
              ? `Last active ${new Date(statistics.lastActiveAt).toLocaleString()}`
              : "No recorded activity"
          }
        />
      </section>
      <section
        aria-label="Usage explorer"
        className="min-w-0 overflow-hidden rounded-xl border bg-card"
      >
        <ExplorerToolbar
          controls={queryControls}
          summary={`${metricLabel} by ${label.toLowerCase()}`}
          model={model}
          onClearModel={() => {
            setModel(undefined);
            select("model", metric);
          }}
          chartType={
            <ChartKindToggle
              linesDisabled={!supportsUsage("time", metric)}
              value={chart}
              onChange={(kind) => {
                setChart(kind);
                if (kind === "lines" && group !== "time")
                  select("time", metric);
              }}
            />
          }
        />
        {props.isRefreshing || (model && modelCube.isLoading) ? (
          <Skeleton className="m-4 h-64" />
        ) : model && modelCube.error ? (
          <QueryLoadError
            title="Could not load model usage"
            onRetry={modelCube.retry}
          />
        ) : (
          <>
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
                    Subscription usage valued at equivalent API rates;
                    subscription fees are excluded.{" "}
                  </span>
                )}
                {cube.notice}
              </p>
            </div>
            {chart !== "table" && cube.rows.length > 0 && (
              <div className="px-4 pb-4">
                <PivotChart
                  cube={
                    group === "time" || (canSplit && split) ? cube : aggregate
                  }
                  metric={metric}
                  onDrilldown={group === "model" ? drilldown : undefined}
                  kind={group === "time" ? chart : "bars"}
                  split={group !== "time"}
                  focus={focus}
                />
                <p className="mt-2 text-xs text-muted-foreground">
                  {group === "time"
                    ? model
                      ? "The selected model’s activity for this range."
                      : "Overall personal activity for the selected range."
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
                    {group === "model"
                      ? "Select a model name to explore its clients. Click rows to compare."
                      : model
                        ? "Filtered to the selected model. Summary cards above cover all models."
                        : "Click rows to compare them in the chart"}
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
                timeframe={props.timeframe}
                showTimeline={cube.rows.some((row) => row.hasSeries)}
                key={`${group}-${metric}`}
                cube={cube}
                metric={metric}
                dimLabel={label}
                splitLabel={canSplit && split ? "Token type" : null}
                focus={focus}
                onToggle={toggle}
                onDrilldown={group === "model" ? drilldown : undefined}
              />
            )}
            <ApiLine call={cube.api} />
          </>
        )}
      </section>
    </div>
  );
}

const CUSTOM_VIEW = "custom";
