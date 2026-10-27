"use client";

import {
  Bar,
  BarChart,
  CartesianGrid,
  LabelList,
  ReferenceLine,
  Scatter,
  ScatterChart,
  XAxis,
  YAxis,
} from "recharts";
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import type { AutoRoutingDiagnostics } from "@/lib/auto-routing.query";
import { formatCompactNumber } from "@/lib/utils/format-compact-number";
import {
  area,
  centroid,
  isoFastGuide,
  type Point,
  routingRegions,
  warp,
  warpPolygon,
} from "./routing-regions";
import { TIER_COLOR, TIER_NAMES, type TierName } from "./tiers";

type Ready = Extract<AutoRoutingDiagnostics, { status: "ready" }>;
type Session = Ready["sessions"][number];
type TierTriple = Session["usdPerToken"];

const SERIES: ChartConfig = {
  sessions: {
    label: "% of sessions",
    theme: { light: "#2a78d6", dark: "#3987e5" },
  },
};
const TICK = "fill-muted-foreground text-[10px]";
const LABEL = "fill-foreground stroke-background text-sm font-semibold";

// === Jev answers ===

const BINS = 20;
/** Room above the plot for the spike marker, clear of the median label inside it. */
const HIST_TOP = 18;
const PANELS = [
  { label: "p_fast", value: (s: Session) => s.tierNeeded[0] },
  { label: "p_normal", value: (s: Session) => s.tierNeeded[1] },
  { label: "p_smart", value: (s: Session) => s.tierNeeded[2] },
  { label: "p_long", value: (s: Session) => s.pLong },
] as const;

export function JevHistograms({ sessions }: { sessions: Session[] }) {
  const panels = PANELS.map(({ label, value }) => {
    const values = sessions.map(value);
    const counts = new Array<number>(BINS).fill(0);
    for (const v of values) counts[Math.min(BINS - 1, Math.floor(v * BINS))]++;
    return {
      label,
      bins: counts.map((c, bin) => ({
        x: (bin + 0.5) / BINS,
        sessions: (100 * c) / Math.max(values.length, 1),
      })),
      median: median(values),
    };
  });
  const all = panels.flatMap((p) => p.bins.map((b) => b.sessions));
  const top = Math.max(...all, 1);
  // One spike would flatten every other bin: cap the shared axis and label the spike.
  const restMax = Math.max(...all.filter((v) => v < top / 2), 0);
  const yMax = restMax > 0 && top > 2.5 * restMax ? restMax * 1.25 : top;

  return (
    <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
      {panels.map((panel, index) => (
        <figure key={panel.label} className="min-w-0">
          <figcaption className="text-center text-xs font-medium">
            {panel.label}
          </figcaption>
          <ChartContainer config={SERIES} className="aspect-[3/2] w-full">
            <BarChart
              data={panel.bins}
              margin={{ top: HIST_TOP, right: 6, bottom: 0, left: 0 }}
              barCategoryGap={1}
            >
              <CartesianGrid vertical={false} />
              <XAxis
                dataKey="x"
                type="number"
                domain={[0, 1]}
                ticks={[0, 0.5, 1]}
                tickLine={false}
              />
              <YAxis
                domain={[0, yMax]}
                ticks={niceTicks(yMax)}
                allowDataOverflow
                tick={index === 0}
                tickFormatter={(v) => `${v}%`}
                tickLine={false}
                axisLine={false}
                width={36}
              />
              <ChartTooltip
                cursor={false}
                content={
                  <ChartTooltipContent
                    hideLabel
                    formatter={(v) => `${Number(v).toFixed(1)}%`}
                  />
                }
              />
              <Bar
                dataKey="sessions"
                fill="var(--color-sessions)"
                radius={1.5}
                isAnimationActive={false}
              >
                <LabelList
                  dataKey="sessions"
                  content={({ x, width, value }) =>
                    Number(value) > yMax ? (
                      <text
                        x={Number(x) + Number(width) + 2}
                        y={HIST_TOP - 6}
                        className={TICK}
                      >
                        {`▲ ${Number(value).toFixed(0)}%`}
                      </text>
                    ) : null
                  }
                />
              </Bar>
              <ReferenceLine
                x={panel.median}
                className="stroke-foreground"
                label={{
                  value: `median ${panel.median.toFixed(2)}`,
                  position:
                    panel.median > 0.6 ? "insideTopRight" : "insideTopLeft",
                  className: "fill-foreground text-[10px]",
                }}
              />
            </BarChart>
          </ChartContainer>
        </figure>
      ))}
    </div>
  );
}

// === Predicted vs realized ===

export function SizeScatter({ sessions }: { sessions: Session[] }) {
  const points = sessions.flatMap((s) =>
    s.predictedTokens !== null && s.predictedTokens > 0 && s.realizedTokens > 0
      ? [
          {
            predicted: Math.log10(s.predictedTokens),
            realized: Math.log10(s.realizedTokens),
          },
        ]
      : [],
  );
  if (points.length === 0) return null;
  const dx = decades(points.map((p) => p.predicted));
  const dy = decades(points.map((p) => p.realized));
  const diagonal = [Math.max(dx[0], dy[0]), Math.min(last(dx), last(dy))];
  const compact = (log: unknown) => formatCompactNumber(10 ** Number(log));

  return (
    <ChartContainer
      config={SERIES}
      className="mx-auto aspect-[2/1] w-full max-w-[760px]"
    >
      <ScatterChart margin={{ top: 12, right: 12, bottom: 16, left: 4 }}>
        <CartesianGrid />
        <XAxis
          type="number"
          dataKey="predicted"
          name="predicted"
          domain={[dx[0], last(dx)]}
          ticks={dx}
          tickFormatter={compact}
          label={{
            value: "predicted tokens",
            position: "insideBottom",
            offset: -10,
            className: TICK,
          }}
        />
        <YAxis
          type="number"
          dataKey="realized"
          name="realized"
          domain={[dy[0], last(dy)]}
          ticks={dy}
          tickFormatter={compact}
          label={{
            value: "realized tokens",
            angle: -90,
            position: "insideLeft",
            className: TICK,
          }}
        />
        {diagonal[1] > diagonal[0] && (
          <ReferenceLine
            segment={[
              { x: diagonal[0], y: diagonal[0] },
              { x: diagonal[1], y: diagonal[1] },
            ]}
            className="stroke-muted-foreground"
            label={{
              value: "y = x",
              position: "insideTopRight",
              className: TICK,
            }}
          />
        )}
        <ChartTooltip
          cursor={false}
          content={
            <ChartTooltipContent
              hideLabel
              formatter={(value, name) => `${name} ${compact(value)}`}
            />
          }
        />
        <Scatter
          data={points}
          fill="var(--color-sessions)"
          fillOpacity={0.5}
          isAnimationActive={false}
        />
      </ScatterChart>
    </ChartContainer>
  );
}

// === Routing triangle ===

const TRI = { size: 360, pad: 44 };
const LABEL_OFFSET = 22;
/** p_fast levels drawn as dashed guides; most sessions sit below the first. */
const ISO_FAST = [0.01, 0.1, 0.5];
/** Each tier's all-in corner, its name set just outside it (offsets in px). */
const CORNERS: Record<
  TierName,
  { at: Point; dx: number; dy: number; anchor: "start" | "middle" | "end" }
> = {
  fast: { at: [0, 0], dx: -4, dy: 4, anchor: "end" },
  normal: { at: [1, 0], dx: 4, dy: 4, anchor: "start" },
  smart: { at: [0, 1], dx: 0, dy: -6, anchor: "middle" },
};
/** Below this share of the unit square a region is too thin to hold its label. */
const MIN_LABEL_AREA = 0.02;

type TierLabel = {
  tier: TierName;
  at: Point;
  leader: readonly [Point, Point] | null;
};

export function RoutingTriangle({ data }: { data: Ready }) {
  const { size, pad } = TRI;
  const span = size - 2 * pad;
  const x = (v: number) => pad + v * span;
  const y = (v: number) => size - pad - v * span;
  const path = (polygon: Point[]) =>
    `M${polygon.map(([px, py]) => `${x(px)},${y(py)}`).join("L")}Z`;
  // Region boundaries hold at one set of prices; long-context pricing gives each session its own.
  const prices = sharedPrices(data.sessions);
  const raw = prices && routingRegions(data.lamStar, prices);
  const regions =
    raw &&
    (Object.fromEntries(
      TIER_NAMES.map((tier) => [
        tier,
        raw[tier].length > 0 ? warpPolygon(raw[tier]) : [],
      ]),
    ) as Record<TierName, Point[]>);
  const dotAt = (s: Session) => warp([s.tierNeeded[1], s.tierNeeded[2]]);
  const labels = TIER_NAMES.flatMap((tier): TierLabel[] => {
    const region = regions?.[tier] ?? [];
    const routed = data.sessions.filter((s) => s.tier === tier).map(dotAt);
    if (region.length === 0 && routed.length === 0) return [];
    const anchor = centroid(region.length > 0 ? region : routed);
    if (!regions || area(region) >= MIN_LABEL_AREA)
      return [{ tier, at: anchor, leader: null }];
    // A sliver or no area would put the label over another tier's region: label it past the hypotenuse.
    const u = Math.min(0.9, Math.max(0.1, (anchor[0] - anchor[1] + 1) / 2));
    const out = LABEL_OFFSET / (span * Math.SQRT2);
    const past = (k: number): Point => [u + k * out, 1 - u + k * out];
    return [{ tier, at: past(1), leader: [past(0), past(0.4)] }];
  });

  return (
    <svg
      viewBox={`0 0 ${size} ${size}`}
      className="mx-auto w-full max-w-[520px]"
      role="img"
      aria-label="Routing regions"
    >
      {regions &&
        TIER_NAMES.map((tier) =>
          regions[tier].length > 0 ? (
            <path
              key={tier}
              data-tier={tier}
              d={path(regions[tier])}
              className={`${TIER_COLOR[tier].region} stroke-background`}
              strokeWidth={2}
            />
          ) : null,
        )}
      <path
        d={path([
          [0, 0],
          [1, 0],
          [0, 1],
        ])}
        className="fill-none stroke-muted-foreground"
        strokeWidth={1}
      />
      {ISO_FAST.map((pFast) => {
        const [[x1, y1], [x2, y2]] = isoFastGuide(pFast);
        return (
          <g key={pFast} data-iso-fast={pFast}>
            <line
              x1={x(x1)}
              y1={y(y1)}
              x2={x(x2)}
              y2={y(y2)}
              className="stroke-muted-foreground/40"
              strokeDasharray="3 3"
              strokeWidth={1}
            />
            <text x={x(x1)} y={y(y1) + 12} textAnchor="middle" className={TICK}>
              {`p_fast ${String(pFast).replace(/^0/, "")}`}
            </text>
          </g>
        );
      })}
      {TIER_NAMES.map((tier) => {
        const { at, dx, dy, anchor } = CORNERS[tier];
        return (
          <text
            key={tier}
            data-corner={tier}
            x={x(at[0]) + dx}
            y={y(at[1]) + dy}
            textAnchor={anchor}
            className={`${TIER_COLOR[tier].dot} text-[10px] font-medium`}
          >
            {tier}
          </text>
        );
      })}
      {data.sessions.map((s, i) => (
        <circle
          // biome-ignore lint/suspicious/noArrayIndexKey: points are positional
          key={i}
          data-tier={s.tier}
          cx={x(dotAt(s)[0])}
          cy={y(dotAt(s)[1])}
          r={3}
          className={`${TIER_COLOR[s.tier].dot} stroke-background`}
          strokeWidth={1}
        >
          <title>{`${s.tier} · p_fast ${s.tierNeeded[0].toFixed(2)} · p_normal ${s.tierNeeded[1].toFixed(2)} · p_smart ${s.tierNeeded[2].toFixed(2)}`}</title>
        </circle>
      ))}
      {labels.map(({ tier, at, leader }) => (
        <g key={tier} data-label={tier}>
          {leader && (
            <line
              x1={x(leader[0][0])}
              y1={y(leader[0][1])}
              x2={x(leader[1][0])}
              y2={y(leader[1][1])}
              className="stroke-muted-foreground"
              strokeWidth={1}
            />
          )}
          <text
            x={x(at[0])}
            y={y(at[1])}
            textAnchor="middle"
            dominantBaseline={leader ? "middle" : undefined}
            className={LABEL}
            strokeWidth={4}
            paintOrder="stroke"
          >
            {tier}
          </text>
        </g>
      ))}
    </svg>
  );
}

function sharedPrices(sessions: Session[]): TierTriple | null {
  const [first] = sessions;
  const same = (a: number, b: number) =>
    Math.abs(a - b) <= 1e-9 * Math.max(Math.abs(a), Math.abs(b));
  return first &&
    sessions.every((s) =>
      s.usdPerToken.every((price, k) => same(price, first.usdPerToken[k])),
    )
    ? first.usdPerToken
    : null;
}

/** Whole powers of ten spanning `logs`, at least one decade apart. */
function decades(logs: number[]): number[] {
  const lo = Math.floor(Math.min(...logs));
  const hi = Math.max(lo + 1, Math.ceil(Math.max(...logs)));
  return Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
}

function last(values: number[]): number {
  return values[values.length - 1];
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = values.toSorted((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

function niceTicks(max: number): number[] {
  const step = [1, 2, 5, 10, 20, 25, 50].find((s) => max / s <= 4) ?? 100;
  return Array.from({ length: Math.floor(max / step) + 1 }, (_, i) => i * step);
}
