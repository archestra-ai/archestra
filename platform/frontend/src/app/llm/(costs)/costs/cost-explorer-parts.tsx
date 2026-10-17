"use client";
import {
  ArrowDown,
  ArrowUp,
  BarChart3,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  LineChart as LineIcon,
  Table2,
  TerminalSquare,
} from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  XAxis,
  YAxis,
} from "recharts";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
} from "@/components/ui/chart";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { UnstyledButton } from "@/components/ui/unstyled-button";
import { cn } from "@/lib/utils/tailwind";
import {
  bucketFormatter,
  type ChartKind,
  type Cube,
  type CubeRow,
  formatCell,
  formatValue,
  type MetricId,
} from "./cost-explorer-data";

// ===== palette =====
export const PALETTE = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
  "oklch(0.7 0.12 200)",
  "oklch(0.68 0.19 350)",
  "oklch(0.74 0.15 128)",
];
const OTHER = "color-mix(in oklch, var(--muted-foreground) 40%, transparent)";
export const colorAt = (rank: number) => PALETTE[rank % PALETTE.length];

// ===== query chip =====
export function QueryChip<T extends string>({
  label,
  value,
  options,
  onChange,
  tone,
  className,
}: {
  label: string;
  value: T;
  options: { id: T; label: string; disabled?: boolean; hint?: string }[];
  onChange: (v: T) => void;
  tone?: "caution";
  className?: string;
}) {
  const current = options.find((o) => o.id === value);
  const enabled = options.filter((o) => !o.disabled);
  const disabled = options.filter((o) => o.disabled);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <UnstyledButton
          aria-label={`${label} ${current?.label ?? ""}`}
          className={cn(
            "group inline-flex h-8 min-w-0 items-center gap-1.5 rounded-md border bg-background px-2.5 text-sm transition-colors hover:bg-accent dark:bg-input/30 dark:hover:bg-input/50",
            tone === "caution" &&
              "border-amber-500/50 bg-amber-500/5 dark:bg-amber-500/10",
            className,
          )}
        >
          <span className="shrink-0 text-muted-foreground text-xs">
            {label}
          </span>
          <span className="grow truncate text-left font-medium">
            {current?.label}
          </span>
          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
        </UnstyledButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="min-w-52 max-w-[min(24rem,calc(100vw-2rem))]"
      >
        <DropdownMenuLabel className="text-muted-foreground text-xs font-normal">
          {label}
        </DropdownMenuLabel>
        {enabled.map((o) => (
          <DropdownMenuItem key={o.id} onSelect={() => onChange(o.id)}>
            <span className="flex-1">{o.label}</span>
            {o.id === value && <Check className="size-4" />}
          </DropdownMenuItem>
        ))}
        {disabled.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-muted-foreground text-xs font-normal">
              Not available for this metric
            </DropdownMenuLabel>
            {disabled.map((o) => (
              <DropdownMenuItem key={o.id} disabled>
                <span className="flex-1">{o.label}</span>
              </DropdownMenuItem>
            ))}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function ChartKindToggle({
  value,
  onChange,
}: {
  value: ChartKind;
  onChange: (v: ChartKind) => void;
}) {
  const items: { id: ChartKind; label: string; icon: ReactNode }[] = [
    { id: "bars", label: "Stacked bars", icon: <BarChart3 /> },
    { id: "lines", label: "Lines", icon: <LineIcon /> },
    { id: "table", label: "Table only", icon: <Table2 /> },
  ];
  return (
    <div className="inline-flex h-8 items-center rounded-md border bg-background p-0.5 dark:bg-input/30">
      {items.map((it) => (
        <UnstyledButton
          key={it.id}
          type="button"
          title={it.label}
          aria-label={it.label}
          aria-pressed={value === it.id}
          onClick={() => onChange(it.id)}
          className={cn(
            "inline-flex h-full items-center rounded-[5px] px-2 text-muted-foreground transition-colors [&_svg]:size-4",
            value === it.id
              ? "bg-accent text-foreground"
              : "hover:text-foreground",
          )}
        >
          {it.icon}
        </UnstyledButton>
      ))}
    </div>
  );
}

// ===== sparkline =====
export function Sparkline({
  values,
  color,
  width = 96,
  height = 22,
}: {
  values: number[];
  color: string;
  width?: number;
  height?: number;
}) {
  if (values.length < 2)
    return <span className="text-muted-foreground">—</span>;
  const max = Math.max(...values, 1e-9);
  const step = width / (values.length - 1);
  const pts = values.map(
    (v, i) =>
      `${(i * step).toFixed(1)},${(height - 2 - (v / max) * (height - 4)).toFixed(1)}`,
  );
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className="overflow-visible"
      aria-hidden="true"
    >
      <polyline
        points={`0,${height} ${pts.join(" ")} ${width},${height}`}
        fill={color}
        fillOpacity={0.12}
        stroke="none"
      />
      <polyline
        points={pts.join(" ")}
        fill="none"
        stroke={color}
        strokeWidth={1.5}
        strokeLinejoin="round"
      />
    </svg>
  );
}

// ===== chart =====
type TipItem = {
  dataKey?: string | number;
  value?: number | string;
  color?: string;
  fill?: string;
  stroke?: string;
};

export function PivotChart({
  cube,
  metric,
  kind,
  split,
  focus,
}: {
  cube: Cube;
  metric: MetricId;
  kind: Exclude<ChartKind, "table">;
  split: boolean;
  focus: Set<string>;
}) {
  const fmt = useMemo(() => bucketFormatter(cube.buckets), [cube.buckets]);
  const ranked = cube.rows.map((r, rank) => ({ r, rank }));
  const chosen =
    focus.size > 0
      ? ranked.filter(({ r }) => focus.has(r.key))
      : ranked.slice(0, kind === "lines" ? 6 : 7);
  const rest =
    focus.size > 0 || kind === "lines"
      ? []
      : ranked.slice(7).filter(({ r }) => r.hasSeries);

  const config: ChartConfig = {};
  const labelFor: Record<string, string> = {};

  if (split && kind === "bars") {
    // Composition: one bar per row, segments by split value.
    const top = chosen.slice(0, 8);
    const segs = cube.splitKeys.slice(0, 6);
    const segKeys = new Set(segs.map((s) => s.key));
    segs.forEach((s, j) => {
      config[`p${j}`] = { label: s.label, color: PALETTE[j] };
      labelFor[`p${j}`] = s.label;
    });
    config.other = { label: "Other", color: OTHER };
    labelFor.other = "Other";
    const data = top.map(({ r }) => {
      const d: Record<string, number | string> = { name: r.label };
      segs.forEach((s, j) => {
        d[`p${j}`] = r.children.find((c) => c.key === s.key)?.total ?? 0;
      });
      d.other = r.children
        .filter((c) => !segKeys.has(c.key))
        .reduce((a, c) => a + c.total, 0);
      return d;
    });
    return (
      <div className="space-y-3">
        <ChartContainer
          config={config}
          className="aspect-auto w-full"
          style={{ height: Math.max(160, top.length * 34 + 30) }}
        >
          <BarChart
            data={data}
            layout="vertical"
            margin={{ left: 4, right: 12, top: 4, bottom: 4 }}
          >
            <CartesianGrid horizontal={false} strokeDasharray="3 3" />
            <XAxis
              type="number"
              tickLine={false}
              axisLine={false}
              tickFormatter={(v: number) => formatCell(metric, v)}
            />
            <YAxis
              type="category"
              dataKey="name"
              width={124}
              tickLine={false}
              axisLine={false}
              tickFormatter={(v: string) =>
                v.length > 18 ? `${v.slice(0, 17)}…` : v
              }
            />
            <ChartTooltip
              cursor={{ fill: "var(--muted)", opacity: 0.4 }}
              content={(p) => (
                <PivotTooltip
                  {...(p as unknown as TipProps)}
                  metric={metric}
                  labelFor={labelFor}
                />
              )}
            />
            {segs.map((_, j) => (
              <Bar
                // biome-ignore lint/suspicious/noArrayIndexKey: series slot
                key={j}
                dataKey={`p${j}`}
                stackId="a"
                fill={`var(--color-p${j})`}
                isAnimationActive={false}
              />
            ))}
            <Bar
              dataKey="other"
              stackId="a"
              fill="var(--color-other)"
              radius={[0, 3, 3, 0]}
              isAnimationActive={false}
            />
          </BarChart>
        </ChartContainer>
        <Legend
          items={[
            ...segs.map((s, j) => ({ label: s.label, color: PALETTE[j] })),
            ...(cube.splitKeys.length > segs.length
              ? [
                  {
                    label: `${cube.splitKeys.length - segs.length} more`,
                    color: OTHER,
                  },
                ]
              : []),
          ]}
        />
      </div>
    );
  }

  for (const { r, rank } of chosen) {
    config[`s${rank}`] = { label: r.label, color: colorAt(rank) };
    labelFor[`s${rank}`] = r.label;
  }
  if (rest.length) {
    config.other = { label: `${rest.length} more`, color: OTHER };
    labelFor.other = `${rest.length} more`;
  }
  const data = cube.buckets.map((b, i) => {
    const d: Record<string, number | string> = { t: fmt(b) };
    for (const { r, rank } of chosen) d[`s${rank}`] = r.series[i];
    if (rest.length) d.other = rest.reduce((a, { r }) => a + r.series[i], 0);
    return d;
  });
  const keys = [
    ...chosen.map(({ rank }) => `s${rank}`),
    ...(rest.length ? ["other"] : []),
  ];
  const noSeries = chosen.length > 0 && chosen.every(({ r }) => !r.hasSeries);

  const axes = (
    <>
      <CartesianGrid vertical={false} strokeDasharray="3 3" />
      <XAxis
        dataKey="t"
        tickLine={false}
        axisLine={false}
        minTickGap={24}
        tickMargin={8}
      />
      <YAxis
        tickLine={false}
        axisLine={false}
        width={52}
        tickFormatter={(v: number) => formatCell(metric, v)}
      />
      <ChartTooltip
        cursor={kind === "bars" ? { fill: "var(--muted)", opacity: 0.4 } : true}
        content={(p) => (
          <PivotTooltip
            {...(p as unknown as TipProps)}
            metric={metric}
            labelFor={labelFor}
            showTotal
          />
        )}
      />
    </>
  );

  return (
    <div className="space-y-3">
      {noSeries ? (
        <div className="flex h-[260px] items-center justify-center rounded-md border border-dashed text-muted-foreground text-sm">
          No daily trend for this selection. Totals are in the table.
        </div>
      ) : (
        <ChartContainer
          config={config}
          className="aspect-auto h-[260px] w-full"
        >
          {kind === "bars" ? (
            <BarChart data={data} margin={{ left: 0, right: 4, top: 4 }}>
              {axes}
              {keys.map((k, i) => (
                <Bar
                  key={k}
                  dataKey={k}
                  stackId="a"
                  fill={`var(--color-${k})`}
                  radius={i === keys.length - 1 ? [3, 3, 0, 0] : 0}
                  isAnimationActive={false}
                />
              ))}
            </BarChart>
          ) : (
            <LineChart data={data} margin={{ left: 0, right: 8, top: 4 }}>
              {axes}
              {keys.map((k) => (
                <Line
                  key={k}
                  dataKey={k}
                  type="monotone"
                  stroke={`var(--color-${k})`}
                  strokeWidth={2}
                  dot={false}
                  isAnimationActive={false}
                />
              ))}
            </LineChart>
          )}
        </ChartContainer>
      )}
      <Legend
        items={[
          ...chosen.map(({ r, rank }) => ({
            label: r.label,
            color: colorAt(rank),
          })),
          ...(rest.length
            ? [{ label: `${rest.length} more`, color: OTHER }]
            : []),
        ]}
      />
    </div>
  );
}

function Legend({ items }: { items: { label: string; color: string }[] }) {
  return (
    <ul
      aria-label="Usage chart legend"
      className="flex flex-wrap gap-x-4 gap-y-1.5 text-xs"
    >
      {items.map((it) => (
        <li
          key={it.label}
          className="inline-flex min-w-0 max-w-full items-center gap-1.5"
        >
          <span
            className="size-2.5 shrink-0 rounded-[3px]"
            style={{ background: it.color }}
          />
          <span
            title={it.label}
            className="min-w-0 break-words text-muted-foreground"
          >
            {it.label}
          </span>
        </li>
      ))}
    </ul>
  );
}

type TipProps = {
  active?: boolean;
  label?: string | number;
  payload?: TipItem[];
};

function PivotTooltip({
  active,
  label,
  payload,
  metric,
  labelFor,
  showTotal,
}: TipProps & {
  metric: MetricId;
  labelFor: Record<string, string>;
  showTotal?: boolean;
}) {
  if (!active || !payload?.length) return null;
  const items = [...payload]
    .filter((p) => Number(p.value) > 0)
    .sort((a, b) => Number(b.value) - Number(a.value));
  const total = items.reduce((a, p) => a + Number(p.value), 0);
  return (
    <div className="grid min-w-44 gap-1.5 rounded-lg border bg-background px-2.5 py-2 text-xs shadow-xl">
      <div className="flex items-baseline justify-between gap-4 font-medium">
        <span>{label}</span>
        {showTotal && items.length > 1 && (
          <span className="font-mono tabular-nums">
            {formatValue(metric, total)}
          </span>
        )}
      </div>
      {items.slice(0, 8).map((p) => (
        <div key={String(p.dataKey)} className="flex items-center gap-2">
          <span
            className="size-2 shrink-0 rounded-[2px]"
            style={{ background: p.fill ?? p.stroke ?? p.color }}
          />
          <span className="max-w-40 flex-1 truncate text-muted-foreground">
            {labelFor[String(p.dataKey)] ?? p.dataKey}
          </span>
          <span className="font-mono tabular-nums">
            {formatValue(metric, Number(p.value))}
          </span>
        </div>
      ))}
    </div>
  );
}

// ===== tables =====
type SortKey = "label" | "total" | "peak" | `x:${string}`;

export function SummaryTable({
  cube,
  metric,
  dimLabel,
  splitLabel,
  focus,
  onToggle,
  showTimeline = true,
}: {
  cube: Cube;
  metric: MetricId;
  dimLabel: string;
  splitLabel: string | null;
  focus: Set<string>;
  onToggle: (key: string) => void;
  showTimeline?: boolean;
}) {
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({
    key: "total",
    dir: -1,
  });
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [showAll, setShowAll] = useState(false);
  const fmtBucket = useMemo(
    () => bucketFormatter(cube.buckets),
    [cube.buckets],
  );
  const rank = new Map(cube.rows.map((r, i) => [r.key, i]));
  const peakOf = (r: CubeRow) => Math.max(0, ...r.series);
  const rows = [...cube.rows].sort((a, b) => {
    const v = (r: CubeRow) =>
      sort.key === "label"
        ? r.label
        : sort.key === "total"
          ? r.total
          : sort.key === "peak"
            ? peakOf(r)
            : (r.extras[sort.key.slice(2)] ?? 0);
    const av = v(a);
    const bv = v(b);
    return typeof av === "string"
      ? av.localeCompare(String(bv)) * sort.dir
      : (av - Number(bv)) * sort.dir;
  });
  const visible = showAll ? rows : rows.slice(0, 15);
  const head = (key: SortKey, label: string, right = true) => (
    <SortHead
      label={label}
      active={sort.key === key}
      dir={sort.dir}
      right={right}
      onClick={() =>
        setSort((s) => ({
          key,
          dir:
            s.key === key ? (s.dir === 1 ? -1 : 1) : key === "label" ? 1 : -1,
        }))
      }
    />
  );

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[600px] text-sm sm:min-w-[850px]">
        <thead>
          <tr className="border-b text-muted-foreground text-xs">
            {head("label", dimLabel, false)}
            {cube.extraCols.map((c) => (
              <RowGroup key={c.id}>{head(`x:${c.id}`, c.label)}</RowGroup>
            ))}
            {head("total", "Total")}
            <th className="w-[15%] px-3 py-2 text-left font-medium">Share</th>
            {showTimeline && (
              <>
                <th className="px-3 py-2 text-left font-medium">
                  <span className="block">Trend</span>
                  <span className="block text-[10px] font-normal">
                    {cube.buckets.length
                      ? `${fmtBucket(cube.buckets[0])}–${fmtBucket(cube.buckets[cube.buckets.length - 1])} UTC`
                      : "No time series"}
                  </span>
                </th>
                {head("peak", "Peak")}
              </>
            )}
          </tr>
        </thead>
        <tbody>
          {visible.map((r) => {
            const i = rank.get(r.key) ?? 0;
            const share = cube.total ? r.total / cube.total : 0;
            const peakIdx = r.series.indexOf(peakOf(r));
            const isOpen = open.has(r.key);
            const focused = focus.has(r.key);
            return (
              <RowGroup key={r.key}>
                <tr
                  onClick={() => onToggle(r.key)}
                  className={cn(
                    "cursor-pointer border-b transition-colors hover:bg-muted/40",
                    focused && "bg-muted/60 hover:bg-muted/60",
                  )}
                >
                  {/* Pinned on phones so the label stays beside the scrolled metrics. */}
                  <td
                    className={cn(
                      "min-w-40 max-w-sm px-3 py-2 max-sm:sticky max-sm:left-0 max-sm:z-10 max-sm:max-w-44 max-sm:bg-card sm:min-w-72",
                      focused &&
                        "max-sm:bg-[color-mix(in_oklch,var(--muted)_60%,var(--card))]",
                    )}
                  >
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                      {r.children.length > 0 ? (
                        <UnstyledButton
                          aria-label={
                            isOpen ? "Collapse" : `Expand by ${splitLabel}`
                          }
                          onClick={(e) => {
                            e.stopPropagation();
                            setOpen((s) => {
                              const n = new Set(s);
                              n.has(r.key) ? n.delete(r.key) : n.add(r.key);
                              return n;
                            });
                          }}
                          className="-ml-1 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                        >
                          {isOpen ? (
                            <ChevronDown className="size-3.5" />
                          ) : (
                            <ChevronRight className="size-3.5" />
                          )}
                        </UnstyledButton>
                      ) : null}
                      <span
                        className={cn(
                          "size-2.5 shrink-0 rounded-[3px] ring-offset-background",
                          focused && "ring-2 ring-ring ring-offset-1",
                        )}
                        style={{ background: colorAt(i) }}
                      />
                      <span
                        title={r.label}
                        className="min-w-0 flex-1 whitespace-normal break-words font-medium"
                      >
                        {r.label}
                      </span>
                      {r.sub && (
                        <span
                          title={r.sub}
                          className="hidden break-all text-muted-foreground text-xs sm:inline"
                        >
                          {r.sub}
                        </span>
                      )}
                      {r.tag && <Tag text={r.tag} />}
                    </div>
                  </td>
                  {cube.extraCols.map((c) => (
                    <td
                      key={c.id}
                      className="px-3 py-2 text-right font-mono text-muted-foreground text-xs tabular-nums"
                    >
                      {c.format(r.extras[c.id] ?? 0)}
                    </td>
                  ))}
                  <td className="px-3 py-2 text-right font-mono font-medium tabular-nums">
                    {formatValue(metric, r.total)}
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-2">
                      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                        <div
                          className="h-full rounded-full"
                          style={{
                            width: `${Math.max(share * 100, 0.5)}%`,
                            background: colorAt(i),
                          }}
                        />
                      </div>
                      <span className="w-11 text-right font-mono text-muted-foreground text-xs tabular-nums">
                        {(share * 100).toFixed(share < 0.1 ? 1 : 0)}%
                      </span>
                    </div>
                  </td>
                  {showTimeline && (
                    <>
                      <td className="px-3 py-1.5">
                        {r.hasSeries ? (
                          <Sparkline values={r.series} color={colorAt(i)} />
                        ) : (
                          <span className="text-muted-foreground text-xs">
                            no trend
                          </span>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2 text-right text-muted-foreground text-xs">
                        {r.hasSeries && peakIdx >= 0 ? (
                          <>
                            <span className="font-mono text-foreground tabular-nums">
                              {formatCell(metric, r.series[peakIdx])}
                            </span>{" "}
                            <span>{fmtBucket(cube.buckets[peakIdx])}</span>
                          </>
                        ) : (
                          <span>—</span>
                        )}
                      </td>
                    </>
                  )}
                </tr>
                {isOpen &&
                  r.children.slice(0, 12).map((c) => (
                    <tr key={c.key} className="border-b bg-muted/20 text-xs">
                      <td className="max-w-0 py-1.5 pr-3 pl-12 max-sm:sticky max-sm:left-0 max-sm:z-10 max-sm:bg-card">
                        <span className="block truncate text-muted-foreground">
                          {c.label}
                        </span>
                      </td>
                      {cube.extraCols.map((x) => (
                        <td key={x.id} />
                      ))}
                      <td className="px-3 py-1.5 text-right font-mono tabular-nums">
                        {formatValue(metric, c.total)}
                      </td>
                      <td className="px-3 py-1.5 font-mono text-muted-foreground tabular-nums">
                        {r.total ? ((c.total / r.total) * 100).toFixed(0) : 0}%
                        of{" "}
                        {r.label.length > 16
                          ? `${r.label.slice(0, 15)}…`
                          : r.label}
                      </td>
                      {showTimeline && (
                        <>
                          <td className="px-3 py-1">
                            <Sparkline
                              values={c.series}
                              color="var(--muted-foreground)"
                              height={16}
                            />
                          </td>
                          <td />
                        </>
                      )}
                    </tr>
                  ))}
              </RowGroup>
            );
          })}
        </tbody>
      </table>
      {rows.length > 15 && (
        <div className="border-t px-3 py-2">
          <Button
            variant="ghost"
            size="xs"
            onClick={() => setShowAll((s) => !s)}
          >
            {showAll ? "Show top 15" : `Show all ${rows.length}`}
          </Button>
        </div>
      )}
    </div>
  );
}

export function PivotTable({
  cube,
  metric,
  dimLabel,
  bySplit,
  focus,
  onToggle,
}: {
  cube: Cube;
  metric: MetricId;
  dimLabel: string;
  bySplit: boolean;
  focus: Set<string>;
  onToggle: (key: string) => void;
}) {
  const cols = pivotColumns(cube, bySplit);
  const matrix = cube.rows.map((r) => pivotValues(r, cube, bySplit));
  const max = Math.max(1e-9, ...matrix.flat());
  const colTotals = cols.map((_, j) =>
    matrix.reduce((a, row) => a + row[j], 0),
  );
  return (
    <div className="overflow-x-auto">
      <table className="w-max min-w-full border-separate border-spacing-0 text-xs">
        <thead>
          <tr className="text-muted-foreground">
            <th className="sticky left-0 z-10 min-w-28 max-w-56 border-b bg-card px-3 py-2 text-left font-medium sm:min-w-40">
              {dimLabel}
            </th>
            {cols.map((c) => (
              <th
                key={c.key}
                title={c.label}
                className="min-w-14 max-w-24 truncate border-b px-1.5 py-2 text-right font-medium whitespace-nowrap"
              >
                {c.label}
              </th>
            ))}
            <th className="border-b border-l bg-card px-3 py-2 text-right font-medium sm:sticky sm:right-0 sm:z-10">
              Total
            </th>
          </tr>
        </thead>
        <tbody>
          {cube.rows.map((r, i) => (
            <tr
              key={r.key}
              onClick={() => onToggle(r.key)}
              className="group cursor-pointer"
            >
              <td
                className={cn(
                  "sticky left-0 z-10 max-w-56 border-b bg-card px-3 py-1.5 group-hover:bg-muted",
                  focus.has(r.key) && "bg-muted",
                )}
              >
                <div className="flex min-w-0 max-w-36 items-center gap-2 sm:max-w-none sm:flex-wrap">
                  <span
                    className="size-2 shrink-0 rounded-[2px]"
                    style={{ background: colorAt(i) }}
                  />
                  <span
                    title={r.label}
                    className="min-w-0 flex-1 truncate font-medium sm:whitespace-normal sm:break-words"
                  >
                    {r.label}
                  </span>
                </div>
              </td>
              {matrix[i].map((v, j) => (
                <td
                  key={cols[j].key}
                  className="border-b border-l border-l-background px-1.5 py-1.5 text-right font-mono tabular-nums"
                  style={{
                    background:
                      v > 0
                        ? `color-mix(in oklch, var(--chart-1) ${Math.round(8 + Math.sqrt(v / max) * 62)}%, transparent)`
                        : undefined,
                  }}
                >
                  <span className={v === 0 ? "text-muted-foreground/50" : ""}>
                    {r.hasSeries || bySplit ? formatCell(metric, v) : ""}
                  </span>
                </td>
              ))}
              <td className="border-b border-l bg-card px-3 py-1.5 text-right font-mono font-medium tabular-nums group-hover:bg-muted sm:sticky sm:right-0 sm:z-10">
                {formatValue(metric, r.total)}
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="text-muted-foreground">
            <td className="sticky left-0 z-10 bg-card px-3 py-2 font-medium">
              All
            </td>
            {colTotals.map((v, j) => (
              <td
                key={cols[j].key}
                className="px-1.5 py-2 text-right font-mono tabular-nums"
              >
                {formatCell(metric, v)}
              </td>
            ))}
            <td className="border-l bg-card px-3 py-2 text-right font-mono font-medium text-foreground tabular-nums sm:sticky sm:right-0 sm:z-10">
              {formatValue(metric, cube.total)}
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

// ===== api line + csv =====
export function ApiLine({ call }: { call: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex min-w-0 items-center gap-2 rounded-md border border-dashed px-2.5 py-1.5">
      <TerminalSquare className="size-3.5 shrink-0 text-muted-foreground" />
      <code className="min-w-0 flex-1 truncate font-mono text-muted-foreground text-xs">
        {call}
      </code>
      <UnstyledButton
        aria-label="Copy API call"
        onClick={() => {
          void navigator.clipboard?.writeText(call.replace(/^GET /, ""));
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        }}
        className="shrink-0 rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        {copied ? (
          <Check className="size-3.5" />
        ) : (
          <Copy className="size-3.5" />
        )}
      </UnstyledButton>
    </div>
  );
}

export function copyCsv({
  cube,
  metric,
  dimLabel,
  view,
  bySplit,
}: {
  cube: Cube;
  metric: MetricId;
  dimLabel: string;
  view: "summary" | "pivot";
  bySplit: boolean;
}) {
  const esc = (s: string | number) => {
    const t = String(s);
    return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  };
  const num = (v: number) => (Number.isInteger(v) ? v : v.toFixed(4));
  let lines: (string | number)[][];
  if (view === "summary") {
    lines = [
      [dimLabel, ...cube.extraCols.map((c) => c.label), metric, "share"],
      ...cube.rows.map((r) => [
        r.label,
        ...cube.extraCols.map((c) => num(r.extras[c.id] ?? 0)),
        num(r.total),
        num(cube.total ? r.total / cube.total : 0),
      ]),
    ];
  } else {
    const cols = pivotColumns(cube, bySplit);
    lines = [
      [dimLabel, ...cols.map((c) => c.csv), "total"],
      ...cube.rows.map((r) => [
        r.label,
        ...pivotValues(r, cube, bySplit).map(num),
        num(r.total),
      ]),
    ];
  }
  const text = lines.map((l) => l.map(esc).join(",")).join("\n");
  void navigator.clipboard
    ?.writeText(text)
    .then(() => toast.success(`Copied ${cube.rows.length} rows as CSV`))
    .catch(() => toast.error("Clipboard is not available"));
}

// ===== helpers =====
function pivotColumns(cube: Cube, bySplit: boolean) {
  if (bySplit) {
    const top = cube.splitKeys.slice(0, 12);
    return [
      ...top.map((s) => ({ key: s.key, label: s.label, csv: s.label })),
      ...(cube.splitKeys.length > 12
        ? [{ key: "__other", label: "Other", csv: "Other" }]
        : []),
    ];
  }
  const fmt = bucketFormatter(cube.buckets);
  return cube.buckets.map((b) => ({ key: b, label: fmt(b), csv: b }));
}

function pivotValues(r: CubeRow, cube: Cube, bySplit: boolean) {
  if (!bySplit) return r.series;
  const top = cube.splitKeys.slice(0, 12);
  const keys = new Set(top.map((s) => s.key));
  const vals = top.map(
    (s) => r.children.find((c) => c.key === s.key)?.total ?? 0,
  );
  if (cube.splitKeys.length > 12)
    vals.push(
      r.children
        .filter((c) => !keys.has(c.key))
        .reduce((a, c) => a + c.total, 0),
    );
  return vals;
}

function SortHead({
  label,
  active,
  dir,
  right,
  onClick,
}: {
  label: string;
  active: boolean;
  dir: 1 | -1;
  right?: boolean;
  onClick: () => void;
}) {
  const btn = (
    <UnstyledButton
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1 hover:text-foreground",
        active && "text-foreground",
      )}
    >
      {label}
      {active &&
        (dir === 1 ? (
          <ArrowUp className="size-3" />
        ) : (
          <ArrowDown className="size-3" />
        ))}
    </UnstyledButton>
  );
  if (!right) {
    return (
      <th className="px-3 py-2 text-left font-medium max-sm:sticky max-sm:left-0 max-sm:z-10 max-sm:bg-card">
        {btn}
      </th>
    );
  }
  return <th className="px-3 py-2 text-right font-medium">{btn}</th>;
}

function Tag({ text }: { text: string }) {
  return (
    <span className="shrink-0 rounded border px-1.5 py-px text-[10px] text-muted-foreground uppercase tracking-wide">
      {text}
    </span>
  );
}

function RowGroup({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

/**
 * Saved-view pills. One swipeable row on phones (bleeding to the page gutter),
 * wrapping from `sm` up.
 */
export function ViewPills({
  label,
  items,
}: {
  label: string;
  items: { id: string; label: string; active: boolean; onSelect: () => void }[];
}) {
  return (
    <nav
      aria-label={label}
      className="-mx-4 flex gap-1.5 overflow-x-auto px-4 [scrollbar-width:none] sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0 [&::-webkit-scrollbar]:hidden"
    >
      {items.map((it) => (
        <UnstyledButton
          key={it.id}
          type="button"
          aria-pressed={it.active}
          onClick={it.onSelect}
          className={cn(
            "h-7 shrink-0 whitespace-nowrap rounded-full border px-3 text-xs transition-colors",
            it.active
              ? "border-foreground bg-foreground text-background"
              : "bg-background text-muted-foreground hover:border-foreground/40 hover:text-foreground dark:bg-input/30",
          )}
        >
          {it.label}
        </UnstyledButton>
      ))}
    </nav>
  );
}

export function Segmented<T extends string>({
  value,
  onChange,
  items,
}: {
  value: T;
  onChange: (v: T) => void;
  items: { id: T; label: string; disabled?: boolean; title?: string }[];
}) {
  return (
    <div className="inline-flex h-7 items-center rounded-md bg-muted p-0.5 text-xs">
      {items.map((it) => (
        <UnstyledButton
          key={it.id}
          type="button"
          disabled={it.disabled}
          title={it.title}
          aria-pressed={value === it.id}
          onClick={() => onChange(it.id)}
          className={cn(
            "h-full rounded-[5px] px-2.5 transition-colors disabled:opacity-40",
            value === it.id
              ? "bg-background font-medium text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          <span>{it.label}</span>
        </UnstyledButton>
      ))}
    </div>
  );
}
