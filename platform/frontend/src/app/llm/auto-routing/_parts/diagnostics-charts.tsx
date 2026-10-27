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
import { centroid, type Point, routingRegions } from "./routing-regions";
import { TIER_NAMES, type TierName } from "./tiers";

type Ready = Extract<AutoRoutingDiagnostics, { status: "ready" }>;
type Session = Ready["sessions"][number];
type TierTriple = Session["usdPerToken"];

/** Validated categorical slots (aqua, blue, orange), stepped per theme. */
export const TIER_COLOR: Record<
  TierName,
  { dot: string; region: string; swatch: string }
> = {
  fast: {
    dot: "fill-[#1baf7a] dark:fill-[#199e70]",
    region: "fill-[#1baf7a]/15 dark:fill-[#199e70]/25",
    swatch: "bg-[#1baf7a] dark:bg-[#199e70]",
  },
  normal: {
    dot: "fill-[#2a78d6] dark:fill-[#3987e5]",
    region: "fill-[#2a78d6]/15 dark:fill-[#3987e5]/25",
    swatch: "bg-[#2a78d6] dark:bg-[#3987e5]",
  },
  smart: {
    dot: "fill-[#eb6834] dark:fill-[#d95926]",
    region: "fill-[#eb6834]/15 dark:fill-[#d95926]/25",
    swatch: "bg-[#eb6834] dark:bg-[#d95926]",
  },
};

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
                width={28}
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
                        y={HIST_TOP + 8}
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

const TRI = { size: 360, pad: 36 };

export function RoutingTriangle({ data }: { data: Ready }) {
  const { size, pad } = TRI;
  const span = size - 2 * pad;
  const x = (v: number) => pad + v * span;
  const y = (v: number) => size - pad - v * span;
  const path = (polygon: Point[]) =>
    `M${polygon.map(([px, py]) => `${x(px)},${y(py)}`).join("L")}Z`;
  // Region boundaries hold at one set of prices; long-context pricing gives each session its own.
  const prices = sharedPrices(data.sessions);
  const regions = prices && routingRegions(data.lamStar, prices);
  const anchor = (tier: TierName): Point | null => {
    if (regions && regions[tier].length > 0) return centroid(regions[tier]);
    const routed = data.sessions.filter((s) => s.tier === tier);
    return routed.length > 0
      ? centroid(routed.map((s) => [s.tierNeeded[1], s.tierNeeded[2]]))
      : null;
  };
  const ticks = [0, 0.25, 0.5, 0.75, 1];

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
      {ticks.map((tick) => (
        <g key={tick}>
          <text
            x={x(tick)}
            y={size - pad + 14}
            textAnchor="middle"
            className={TICK}
          >
            {tick}
          </text>
          <text x={pad - 6} y={y(tick) + 3} textAnchor="end" className={TICK}>
            {tick}
          </text>
        </g>
      ))}
      {data.sessions.map((s, i) => (
        <circle
          // biome-ignore lint/suspicious/noArrayIndexKey: points are positional
          key={i}
          data-tier={s.tier}
          cx={x(s.tierNeeded[1])}
          cy={y(s.tierNeeded[2])}
          r={3}
          className={`${TIER_COLOR[s.tier].dot} stroke-background`}
          strokeWidth={1}
        >
          <title>{`${s.tier} · p_normal ${s.tierNeeded[1].toFixed(2)} · p_smart ${s.tierNeeded[2].toFixed(2)}`}</title>
        </circle>
      ))}
      {TIER_NAMES.map((tier) => {
        const at = anchor(tier);
        return at ? (
          <text
            key={tier}
            x={x(at[0])}
            y={y(at[1])}
            textAnchor="middle"
            className={LABEL}
            strokeWidth={4}
            paintOrder="stroke"
          >
            {tier}
          </text>
        ) : null;
      })}
      <text x={size / 2} y={size - 4} textAnchor="middle" className={TICK}>
        p_normal
      </text>
      <text
        transform={`translate(10 ${size / 2}) rotate(-90)`}
        textAnchor="middle"
        className={TICK}
      >
        p_smart
      </text>
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
