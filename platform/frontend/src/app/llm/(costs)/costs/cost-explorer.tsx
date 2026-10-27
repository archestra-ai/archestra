"use client";
// one result: headline, chart, sortable summary or heat-shaded pivot, CSV,
// and the REST call that returns the same data.

import { ArrowRight, ClipboardCopy, Info, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { QueryLoadError } from "@/components/query-load-error";
import { Button } from "@/components/ui/button";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { Skeleton } from "@/components/ui/skeleton";
import { UnstyledButton } from "@/components/ui/unstyled-button";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useFeature } from "@/lib/config/config.query";
import { useAppName } from "@/lib/hooks/use-app-name";
import { useProxyLabelKeys } from "@/lib/proxy-label-costs.query";
import { cn } from "@/lib/utils/tailwind";
import {
  formatCompact,
  formatCost,
  useCostStatistics,
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
import { getCostLimitsLabel, getCostLimitsLink } from "./cost-limit-link";
import { fmtMetric, KpiTile } from "./cost-overview";

export default function CostExplorer() {
  const { timeframe, enabled } = useCostsTimeRange();
  const appName = useAppName();
  const { data: canReadApps } = useHasPermissions({ app: ["read"] });
  const { data: canReadSkills } = useHasPermissions({ skill: ["read"] });
  const poolsEnabled = useFeature("llmModelPoolsEnabled") === true;
  const { data: canReadLimits } = useHasPermissions({ llmLimit: ["read"] });
  const canGroup = (group: DimId) =>
    (group !== "app" || canReadApps) &&
    (group !== "skill" || canReadSkills) &&
    (group !== "pool" || poolsEnabled);
  const [q, setQ] = useState<PivotQuery>(SAVED_VIEWS[0].q);
  const [focus, setFocus] = useState<Set<string>>(new Set());
  const [view, setView] = useState<"summary" | "pivot">("summary");
  const [pivotCols, setPivotCols] = useState<"days" | "split">("days");

  const labelKeys = useProxyLabelKeys({
    timeframe,
    enabled: enabled && q.group === "label",
  });
  const kpis = useKpis({ timeframe, enabled });
  const cube = usePivotCube(q, timeframe, enabled);
  const statistics = useCostStatistics({
    timeframe,
    enabled: enabled && (q.metric === "billed" || q.metric === "subscription"),
  });

  const contentRef = useRef<HTMLDivElement>(null);
  const [settledHeight, setSettledHeight] = useState<number>();
  const isLoading = cube.isLoading || kpis.isCostPending;
  // A range change replaces a potentially long table with a few skeletons.
  // Reserve its settled height until the response arrives so the browser does
  // not clamp the page's scroll offset to the shorter loading layout.
  useEffect(() => {
    const content = contentRef.current;
    if (!content || isLoading) return;
    const observer = new ResizeObserver(() => {
      setSettledHeight(content.getBoundingClientRect().height);
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, [isLoading]);

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
  const dim =
    q.group === "label"
      ? { label: q.labelKey ?? "cost_center", plural: "label values" }
      : DIMS[q.group];
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
    q.group === "label"
      ? "Label priority: authenticated virtual key / OAuth client → billing team. First matching value wins; captured at request start."
      : q.group === "app" && ["billed", "requests", "tokens"].includes(q.metric)
        ? "Inference attributed to app sessions. This does not mean every app itself runs a model."
        : q.group === "key"
          ? "Key names and recorded IDs are shown in full. Calls without an individual key ID cannot be distinguished further."
          : q.group === "providerKey" || q.group === "pool"
            ? "A request a model pool failed over counts once per attempt. A failed attempt is free unless a timeout cut it off, which bills an estimate of the input it read. Pick Requests to see how many there were."
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
  const focusedRows = cube.rows.filter((row) => focus.has(row.key));
  const limitsLink = canReadLimits
    ? getCostLimitsLink(
        q,
        focusedRows.length === 1 ? focusedRows[0] : undefined,
      )
    : null;
  const limitsLabel = getCostLimitsLabel(
    q,
    focusedRows.length === 1 ? focusedRows[0] : undefined,
  );

  return (
    <div
      ref={contentRef}
      className="space-y-4"
      aria-busy={isLoading}
      style={isLoading ? { minHeight: settledHeight } : undefined}
    >
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5 [&>*:last-child:nth-child(odd)]:col-span-2 md:[&>*:last-child:nth-child(odd)]:col-span-1">
        <KpiTile
          label="API spend"
          value={fmtMetric("billed", kpis.billed.value)}
          caption="Metered API-key charges"
          series={kpis.billed.series}
          pending={kpis.isCostPending}
        />
        <KpiTile
          label="Subscription usage estimate"
          value={fmtMetric("subscription", kpis.subscription.value)}
          caption="Usage at API rates, not a bill"
          pending={kpis.isCostPending}
          series={kpis.subscription.series}
          estimate
          colorClass="text-muted-foreground"
        />
        <KpiTile
          label="Requests"
          value={formatCompact(kpis.requests.value)}
          caption="LLM requests in selected period"
          series={kpis.requests.series}
          pending={kpis.isUsagePending}
          colorClass="text-chart-2"
        />
        <KpiTile
          label="Tokens"
          value={formatCompact(kpis.tokens.value)}
          caption="Input, output and cache"
          series={kpis.tokens.series}
          pending={kpis.isUsagePending}
          colorClass="text-chart-3"
        />
        <KpiTile
          label="Active people"
          value={String(kpis.people.value)}
          caption={`Using ${appName} in selected period`}
          pending={kpis.isPeoplePending}
        />
      </div>

      <section
        aria-label="Cost explorer"
        className="overflow-hidden rounded-xl border bg-card"
      >
        {/* Query bar */}
        <div className="flex flex-wrap items-center gap-2 border-b bg-muted/30 px-3 py-2.5">
          {/* A saved view is a preset of the controls beside it; changing
              any of them makes the view custom. */}
          <QueryChip
            label="View"
            className="max-sm:grow"
            value={activeView?.id ?? CUSTOM_VIEW}
            options={[
              ...SAVED_VIEWS.filter((v) => canGroup(v.q.group)).map((v) => ({
                id: v.id,
                label: v.label,
              })),
              ...(activeView
                ? []
                : [{ id: CUSTOM_VIEW, label: "Custom", disabled: true }]),
            ]}
            onChange={(id) => {
              const view = SAVED_VIEWS.find((v) => v.id === id);
              if (!view) return;
              setQ(view.q);
              setFocus(new Set());
            }}
          />
          <span
            aria-hidden="true"
            className="mx-0.5 h-5 w-px bg-border max-sm:hidden"
          />
          <QueryChip
            label="Show"
            className="max-sm:grow"
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
            className="max-sm:grow"
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
          {q.group === "label" && (
            <SearchableSelect
              size="sm"
              ariaLabel="Label key"
              value={q.labelKey ?? "cost_center"}
              onValueChange={(labelKey) => update({ labelKey })}
              items={(labelKeys.data ?? []).map((key) => ({
                value: key,
                label: key,
              }))}
              placeholder={
                labelKeys.isPending ? "Loading label keys…" : "Label key"
              }
              disabled={labelKeys.isPending}
              searchPlaceholder="Search label keys…"
              hint={
                labelKeys.isError
                  ? "Could not load label keys. Reopen this view to retry."
                  : "Labels captured on requests in this time range."
              }
              emptyMessage={
                labelKeys.isError
                  ? "Label keys unavailable"
                  : "No label keys in this time range"
              }
              className="w-44 border-transparent bg-muted/60 shadow-none"
            />
          )}
          <QueryChip<SplitId>
            label="split by"
            className="max-sm:grow"
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
          {limitsLink && (
            <Button
              asChild
              variant="outline"
              size="sm"
              className="min-w-0 max-w-full"
            >
              <Link href={limitsLink} title={limitsLabel}>
                <span className="max-w-64 truncate">{limitsLabel}</span>
              </Link>
            </Button>
          )}
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
              q.metric === "billed" &&
              statistics.data?.costSavings.totalSubscriptionCost ? (
                <UnstyledButton
                  onClick={() => update({ metric: "subscription" })}
                  className="text-left text-foreground underline-offset-2 hover:underline"
                >
                  Subscription usage at API rates:{" "}
                  <span className="whitespace-nowrap">
                    {formatCost(
                      statistics.data.costSavings.totalSubscriptionCost,
                    )}{" "}
                    (estimate, not a bill)
                    <ArrowRight className="ml-1 inline size-3 align-[-2px]" />
                  </span>
                </UnstyledButton>
              ) : q.metric === "subscription" && statistics.data ? (
                <span>
                  Actually billed in this range:{" "}
                  <UnstyledButton
                    onClick={() => update({ metric: "billed" })}
                    className="font-medium text-foreground underline-offset-2 hover:underline"
                  >
                    {formatCost(statistics.data.costSavings.totalActualCost)}
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
    // Icon gets its own column so wrapped lines and the extra line align
    // with the note text instead of the icon.
    <div
      className={cn(
        "flex gap-1.5 text-muted-foreground text-xs leading-relaxed",
        caution &&
          "rounded-md border border-amber-500/40 bg-amber-500/5 px-2.5 py-1.5 text-amber-800 dark:bg-amber-500/10 dark:text-amber-200",
      )}
    >
      <Info className="mt-[3px] size-3.5 shrink-0" />
      <div className="flex min-w-0 flex-wrap gap-x-3 gap-y-1">
        <span>{note}</span>
        {extra && <span className="text-muted-foreground">{extra}</span>}
      </div>
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

const CUSTOM_VIEW = "custom";
