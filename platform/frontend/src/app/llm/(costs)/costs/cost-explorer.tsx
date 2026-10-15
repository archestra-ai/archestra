"use client";
// one result: headline, chart, sortable summary or heat-shaded pivot, CSV,
// and the REST call that returns the same data.

import { ArrowRight, ClipboardCopy, Info, X } from "lucide-react";
import { useMemo, useState } from "react";
import { QueryLoadError } from "@/components/query-load-error";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { UnstyledButton } from "@/components/ui/unstyled-button";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useAppName } from "@/lib/hooks/use-app-name";
import { useCostSavingsStatistics } from "@/lib/statistics.query";
import { cn } from "@/lib/utils/tailwind";
import {
  formatCompact,
  formatCost,
  useCostsTimeRange,
  useKpis,
} from "./cost-explorer.query";
import {
  DIM_IDS,
  DIMS,
  type DimId,
  formatValue,
  METRIC_IDS,
  METRICS,
  normalize,
  type PivotQuery,
  SAVED_VIEWS,
  type SplitId,
  splitOptions,
  supports,
  TIMEFRAME_LABEL,
  usePivotCube,
} from "./cost-explorer-data";
import {
  ApiLine,
  ChartKindToggle,
  copyCsv,
  PivotChart,
  PivotTable,
  QueryChip,
  Segmented,
  SummaryTable,
} from "./cost-explorer-parts";
import { fmtMetric, KpiTile } from "./cost-overview";

export default function CostExplorer() {
  const { timeframe, enabled } = useCostsTimeRange();
  const appName = useAppName();
  const { data: canReadApps } = useHasPermissions({ app: ["read"] });
  const { data: canReadSkills } = useHasPermissions({ skill: ["read"] });
  const canGroup = (group: DimId) =>
    (group !== "app" || canReadApps) && (group !== "skill" || canReadSkills);
  const [q, setQ] = useState<PivotQuery>(SAVED_VIEWS[0].q);
  const [focus, setFocus] = useState<Set<string>>(new Set());
  const [view, setView] = useState<"summary" | "pivot">("summary");
  const [pivotCols, setPivotCols] = useState<"days" | "split">("days");

  const kpis = useKpis({ timeframe, enabled });
  const cube = usePivotCube(q, timeframe, enabled);
  const savings = useCostSavingsStatistics({
    timeframe,
    enabled: enabled && (q.metric === "billed" || q.metric === "subscription"),
  });

  const update = (patch: Partial<PivotQuery>) => {
    setQ((prev) => normalize({ ...prev, ...patch }));
    setFocus(new Set());
  };
  const toggleFocus = (key: string) =>
    setFocus((s) => {
      const n = new Set(s);
      n.has(key) ? n.delete(key) : n.add(key);
      return n;
    });

  const metric = METRICS[q.metric];
  const dim = DIMS[q.group];
  const splits = splitOptions(q.metric, q.group);
  const hasSplit = q.split !== "none";
  const activeView = SAVED_VIEWS.find(
    (v) =>
      v.q.metric === q.metric && v.q.group === q.group && v.q.split === q.split,
  );
  const rangeLabel = TIMEFRAME_LABEL[String(timeframe)] ?? "selected range";
  const metricNote =
    q.metric === "tokens" && q.group === "skill"
      ? "Tokens each skill injected into context."
      : metric.note;

  const attributionNote =
    q.group === "app" && ["billed", "requests", "tokens"].includes(q.metric)
      ? "Inference attributed to app sessions. This does not mean every app itself runs a model."
      : q.group === "key"
        ? "Key names and recorded IDs are shown in full. Calls without an individual key ID cannot be distinguished further."
        : null;

  const headline = useMemo(() => {
    const top = cube.rows[0];
    const n = cube.buckets.length;
    let trend: number | null = null;
    if (n >= 4) {
      const half = Math.floor(n / 2);
      const sumRange = (a: number, b: number) =>
        cube.rows.reduce(
          (acc, r) => acc + r.series.slice(a, b).reduce((x, y) => x + y, 0),
          0,
        );
      const first = sumRange(0, half);
      const second = sumRange(n - half, n);
      trend = first > 0 ? (second - first) / first : null;
    }
    return {
      top,
      topShare: top && cube.total ? top.total / cube.total : 0,
      trend,
    };
  }, [cube]);

  const focusedLabels = cube.rows
    .filter((r) => focus.has(r.key))
    .map((r) => r.label);
  const pivotBySplit = hasSplit && pivotCols === "split";

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        <KpiTile
          label="API spend"
          value={fmtMetric("billed", kpis.billed.value)}
          caption="Metered API-key charges"
          series={kpis.billed.series}
          pending={kpis.isCostPending}
          active={q.metric === "billed"}
          onClick={() => update({ metric: "billed" })}
        />
        <KpiTile
          label="Subscription usage estimate"
          value={fmtMetric("subscription", kpis.subscription.value)}
          caption="Usage at API rates, not a bill"
          pending={kpis.isCostPending}
          series={kpis.subscription.series}
          estimate
          colorClass="text-muted-foreground"
          active={q.metric === "subscription"}
          onClick={() => update({ metric: "subscription" })}
        />
        <KpiTile
          label="Requests"
          value={formatCompact(kpis.requests.value)}
          caption="LLM requests in selected period"
          series={kpis.requests.series}
          pending={kpis.isUsagePending}
          colorClass="text-chart-2"
          active={q.metric === "requests"}
          onClick={() => update({ metric: "requests" })}
        />
        <KpiTile
          label="Tokens"
          value={formatCompact(kpis.tokens.value)}
          caption="Input, output and cache"
          series={kpis.tokens.series}
          pending={kpis.isUsagePending}
          colorClass="text-chart-3"
          active={q.metric === "tokens"}
          onClick={() => update({ metric: "tokens" })}
        />
        <KpiTile
          label="Active people"
          value={String(kpis.people.value)}
          caption={`Using ${appName} in selected period`}
          pending={kpis.isPeoplePending}
          active={q.group === "person"}
          onClick={() => update({ metric: "requests", group: "person" })}
        />
      </div>
      {/* Saved views */}
      <div className="flex flex-wrap items-center gap-1.5">
        {SAVED_VIEWS.filter((v) => canGroup(v.q.group)).map((v) => (
          <UnstyledButton
            key={v.id}
            type="button"
            onClick={() => {
              setQ(v.q);
              setFocus(new Set());
            }}
            className={cn(
              "h-7 rounded-full border px-3 text-xs transition-colors",
              activeView?.id === v.id
                ? "border-foreground bg-foreground text-background"
                : "bg-background text-muted-foreground hover:border-foreground/40 hover:text-foreground dark:bg-input/30",
            )}
          >
            {v.label}
          </UnstyledButton>
        ))}
      </div>

      <section
        aria-label="Cost explorer"
        className="overflow-hidden rounded-xl border bg-card"
      >
        {/* Query bar */}
        <div className="flex flex-wrap items-center gap-2 border-b bg-muted/30 px-3 py-2.5">
          <QueryChip
            label="Show"
            value={q.metric}
            tone={metric.caution ? "caution" : undefined}
            options={METRIC_IDS.filter(
              (m) =>
                (m !== "appRuns" || canReadApps) &&
                (m !== "skillActivations" || canReadSkills),
            ).map((m) => ({
              id: m,
              label: METRICS[m].label,
            }))}
            onChange={(metric) => update({ metric })}
          />
          <QueryChip<DimId>
            label="by"
            value={q.group}
            options={DIM_IDS.filter(
              (d) => d !== "method" && canGroup(d) && supports(d, q.metric),
            ).map((d) => ({
              id: d,
              label: DIMS[d].label,
              disabled: !supports(d, q.metric),
            }))}
            onChange={(group) => update({ group })}
          />
          <QueryChip<SplitId>
            label="split by"
            value={q.split}
            options={[
              { id: "none", label: "None" },
              ...DIM_IDS.filter(
                (d) =>
                  d !== "method" &&
                  canGroup(d) &&
                  d !== q.group &&
                  splits.includes(d),
              ).map((d) => ({
                id: d as SplitId,
                label: DIMS[d].label,
                disabled: !splits.includes(d),
              })),
            ]}
            onChange={(split) => {
              update({ split });
              if (split !== "none") setPivotCols("split");
            }}
          />
          <div className="ml-auto">
            <ChartKindToggle
              value={q.chart}
              onChange={(chart) => setQ((p) => ({ ...p, chart }))}
            />
          </div>
        </div>

        {/* Headline */}
        <div className="space-y-4 p-4">
          <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-3">
            <div className="min-w-0">
              <div className="text-muted-foreground text-xs">
                {metric.label} by {dim.label.toLowerCase()}
                {hasSplit &&
                  ` and ${DIMS[q.split as DimId].label.toLowerCase()}`}{" "}
                · {rangeLabel}
              </div>
              {cube.isLoading ? (
                <Skeleton className="mt-1 h-9 w-36" />
              ) : (
                <div className="font-semibold text-3xl tabular-nums tracking-tight">
                  {formatValue(q.metric, cube.total)}
                </div>
              )}
            </div>
            {!cube.isLoading && headline.top && (
              <dl className="flex flex-wrap gap-x-8 gap-y-2 text-sm">
                <Stat label={`Top ${dim.label.toLowerCase()}`}>
                  <span className="max-w-48 truncate">
                    {headline.top.label}
                  </span>
                  <span className="text-muted-foreground">
                    {(headline.topShare * 100).toFixed(0)}%
                  </span>
                </Stat>
                <Stat label={dim.plural.replace(/^./, (c) => c.toUpperCase())}>
                  {cube.rows.length}
                </Stat>
                {headline.trend !== null && (
                  <Stat label="2nd half vs 1st">
                    <span
                      className={cn(
                        headline.trend >= 0
                          ? "text-emerald-600 dark:text-emerald-400"
                          : "text-rose-600 dark:text-rose-400",
                      )}
                    >
                      {formatTrend(headline.trend)}
                    </span>
                  </Stat>
                )}
              </dl>
            )}
          </div>

          {attributionNote && (
            <p className="text-xs text-muted-foreground">{attributionNote}</p>
          )}
          {cube.notice && (
            <p className="text-xs text-muted-foreground">{cube.notice}</p>
          )}
          <MetricNote
            caution={metric.caution}
            note={metricNote}
            extra={
              q.metric === "billed" && savings.data?.totalSubscriptionCost ? (
                <UnstyledButton
                  onClick={() => update({ metric: "subscription" })}
                  className="inline-flex items-center gap-1 text-foreground underline-offset-2 hover:underline"
                >
                  Subscription usage at API rates:{" "}
                  {formatCost(savings.data.totalSubscriptionCost)} (estimate,
                  not a bill)
                  <ArrowRight className="size-3" />
                </UnstyledButton>
              ) : q.metric === "subscription" && savings.data ? (
                <span>
                  Actually billed in this range:{" "}
                  <UnstyledButton
                    onClick={() => update({ metric: "billed" })}
                    className="font-medium text-foreground underline-offset-2 hover:underline"
                  >
                    {formatCost(savings.data.totalActualCost)}
                  </UnstyledButton>
                </span>
              ) : null
            }
          />

          {Boolean(cube.error) && (
            <QueryLoadError
              title="Could not load usage statistics"
              description="Check your access and connection, then retry."
              onRetry={cube.retry}
            />
          )}
          {!cube.error &&
            q.chart !== "table" &&
            (cube.isLoading ? (
              <Skeleton className="h-[260px] w-full" />
            ) : cube.rows.length === 0 ? (
              <Empty text={`No ${metric.label.toLowerCase()} in this range.`} />
            ) : (
              <PivotChart
                cube={cube}
                metric={q.metric}
                kind={q.chart}
                split={hasSplit}
                focus={focus}
              />
            ))}
        </div>

        {/* Table */}
        <div className="border-t">
          <div className="flex flex-wrap items-center gap-2 px-3 py-2">
            <Segmented
              value={view}
              onChange={setView}
              items={[
                { id: "summary", label: "Summary" },
                { id: "pivot", label: "Pivot" },
              ]}
            />
            {view === "pivot" && hasSplit && (
              <Segmented
                value={pivotCols}
                onChange={setPivotCols}
                items={[
                  { id: "days", label: "Columns: time" },
                  {
                    id: "split",
                    label: `Columns: ${DIMS[q.split as DimId].label.toLowerCase()}`,
                  },
                ]}
              />
            )}
            {focus.size > 0 ? (
              <span className="inline-flex min-w-0 items-center gap-1 rounded-full bg-primary/10 py-0.5 pr-1 pl-2.5 text-primary text-xs">
                <span className="truncate">
                  Chart shows {focusedLabels.slice(0, 2).join(", ")}
                  {focusedLabels.length > 2 && ` +${focusedLabels.length - 2}`}
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
              q.chart !== "table" && (
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
                  metric: q.metric,
                  dimLabel: dim.label,
                  view,
                  bySplit: pivotBySplit,
                })
              }
            >
              <ClipboardCopy />
              Copy as CSV
            </Button>
          </div>
          <div className="border-t">
            {cube.error ? null : cube.isLoading ? (
              <div className="space-y-2 p-3">
                {[0, 1, 2, 3, 4].map((i) => (
                  <Skeleton key={i} className="h-7 w-full" />
                ))}
              </div>
            ) : cube.rows.length === 0 ? (
              <div className="p-4">
                <Empty text="Nothing to tabulate." />
              </div>
            ) : view === "summary" ? (
              <SummaryTable
                cube={cube}
                metric={q.metric}
                dimLabel={dim.label}
                splitLabel={hasSplit ? DIMS[q.split as DimId].label : null}
                focus={focus}
                onToggle={toggleFocus}
              />
            ) : (
              <PivotTable
                cube={cube}
                metric={q.metric}
                dimLabel={dim.label}
                bySplit={pivotBySplit}
                focus={focus}
                onToggle={toggleFocus}
              />
            )}
          </div>
        </div>

        {/* API */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t bg-muted/20 px-3 py-2.5">
          <span className="text-muted-foreground text-xs">
            Same data from the {appName} API
          </span>
          <div className="min-w-0 flex-1 basis-72">
            <ApiLine call={cube.api} />
          </div>
        </div>
      </section>
    </div>
  );
}

// ===== local pieces =====
function formatTrend(t: number) {
  const pct = `${(t * 100).toFixed(0)}%`;
  return t >= 0 ? `+${pct}` : pct;
}

function Stat({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="flex min-w-0 items-baseline gap-1.5 font-medium tabular-nums">
        {children}
      </dd>
    </div>
  );
}

function MetricNote({
  note,
  caution,
  extra,
}: {
  note: string;
  caution?: boolean;
  extra?: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground text-xs",
        caution &&
          "rounded-md border border-amber-500/40 bg-amber-500/5 px-2.5 py-1.5 text-amber-800 dark:bg-amber-500/10 dark:text-amber-200",
      )}
    >
      <span className="inline-flex items-center gap-1.5">
        <Info className="size-3.5 shrink-0" />
        {note}
      </span>
      {extra && <span className="text-muted-foreground">{extra}</span>}
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return (
    <div className="flex h-32 items-center justify-center rounded-md border border-dashed text-muted-foreground text-sm">
      {text}
    </div>
  );
}
