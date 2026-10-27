"use client";

import type { AutoRoutingDiagnostics } from "@/lib/auto-routing.query";
import { formatCompactNumber } from "@/lib/utils/format-compact-number";
import { centroid, type Point, routingRegions } from "./routing-regions";
import { TIER_NAMES, type TierName } from "./tiers";

type Ready = Extract<AutoRoutingDiagnostics, { status: "ready" }>;
type Session = Ready["sessions"][number];

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

const BAR = "fill-[#2a78d6] dark:fill-[#3987e5]";
const GRID = "stroke-border";
const TICK = "fill-muted-foreground text-[10px]";
const LABEL = "fill-foreground stroke-background text-sm font-semibold";

// === Jev answers ===

const BINS = 20;
const HIST = { w: 220, h: 150, left: 28, right: 6, top: 18, bottom: 18 };
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
      percents: counts.map((c) => (100 * c) / Math.max(values.length, 1)),
      median: median(values),
    };
  });
  const all = panels.flatMap((p) => p.percents);
  const top = Math.max(...all, 1);
  // One spike would flatten every other bin: cap the shared axis and label the spike.
  const rest = all.filter((v) => v < top / 2);
  const restMax = Math.max(...rest, 0);
  const yMax = restMax > 0 && top > 2.5 * restMax ? restMax * 1.25 : top;
  const ticks = niceTicks(yMax);

  return (
    <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
      {panels.map((panel, index) => {
        const { w, h, left, right, top: t, bottom } = HIST;
        const x = (v: number) => left + v * (w - left - right);
        const y = (v: number) => h - bottom - (v / yMax) * (h - t - bottom);
        const binWidth = (w - left - right) / BINS;
        return (
          <figure key={panel.label} className="min-w-0">
            <figcaption className="text-center text-xs font-medium">
              {panel.label}
            </figcaption>
            <svg
              viewBox={`0 0 ${w} ${h}`}
              className="w-full"
              role="img"
              aria-label={panel.label}
            >
              {ticks.map((tick) => (
                <g key={tick}>
                  <line
                    x1={left}
                    x2={w - right}
                    y1={y(tick)}
                    y2={y(tick)}
                    className={GRID}
                    strokeWidth={0.5}
                  />
                  {index === 0 && (
                    <text
                      x={left - 4}
                      y={y(tick) + 3}
                      textAnchor="end"
                      className={TICK}
                    >
                      {tick}
                    </text>
                  )}
                </g>
              ))}
              {panel.percents.map((pct, bin) => (
                <rect
                  // biome-ignore lint/suspicious/noArrayIndexKey: bins are positional
                  key={bin}
                  x={x(bin / BINS) + 0.5}
                  y={y(Math.min(pct, yMax))}
                  width={binWidth - 1}
                  height={Math.max(0, h - bottom - y(Math.min(pct, yMax)))}
                  rx={1.5}
                  className={BAR}
                >
                  <title>{`${(bin / BINS).toFixed(2)}–${((bin + 1) / BINS).toFixed(2)}: ${pct.toFixed(1)}%`}</title>
                </rect>
              ))}
              {panel.percents.map((pct, bin) =>
                pct > yMax ? (
                  <text
                    // biome-ignore lint/suspicious/noArrayIndexKey: bins are positional
                    key={`spike-${bin}`}
                    x={x((bin + 1) / BINS) + 2}
                    y={t + 8}
                    className={TICK}
                  >
                    {`▲ ${pct.toFixed(0)}%`}
                  </text>
                ) : null,
              )}
              <line
                x1={x(panel.median)}
                x2={x(panel.median)}
                y1={t - 4}
                y2={h - bottom}
                className="stroke-foreground"
                strokeWidth={1}
              />
              <text
                x={x(panel.median) + (panel.median > 0.6 ? -3 : 3)}
                y={t - 6}
                textAnchor={panel.median > 0.6 ? "end" : "start"}
                className="fill-foreground text-[10px]"
              >
                {`median ${panel.median.toFixed(2)}`}
              </text>
              {[0, 0.5, 1].map((tick) => (
                <text
                  key={tick}
                  x={x(tick)}
                  y={h - 4}
                  textAnchor="middle"
                  className={TICK}
                >
                  {tick}
                </text>
              ))}
              {index === 0 && (
                <text
                  transform={`translate(8 ${(h - bottom + t) / 2}) rotate(-90)`}
                  textAnchor="middle"
                  className={TICK}
                >
                  % of sessions
                </text>
              )}
            </svg>
          </figure>
        );
      })}
    </div>
  );
}

// === Predicted vs realized ===

const SCATTER = { w: 640, h: 320, left: 52, right: 12, top: 12, bottom: 34 };

export function SizeScatter({ sessions }: { sessions: Session[] }) {
  const points = sessions.flatMap((s) =>
    s.predictedTokens !== null && s.predictedTokens > 0 && s.realizedTokens > 0
      ? [[Math.log10(s.predictedTokens), Math.log10(s.realizedTokens)]]
      : [],
  );
  if (points.length === 0) return null;
  const domain = (values: number[]) => {
    const lo = Math.floor(Math.min(...values));
    return { lo, hi: Math.max(lo + 1, Math.ceil(Math.max(...values))) };
  };
  const dx = domain(points.map(([px]) => px));
  const dy = domain(points.map(([, py]) => py));
  const decades = ({ lo, hi }: { lo: number; hi: number }) =>
    Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
  const { w, h, left, right, top, bottom } = SCATTER;
  const x = (v: number) =>
    left + ((v - dx.lo) / (dx.hi - dx.lo)) * (w - left - right);
  const y = (v: number) =>
    h - bottom - ((v - dy.lo) / (dy.hi - dy.lo)) * (h - top - bottom);
  const diagonal = {
    lo: Math.max(dx.lo, dy.lo),
    hi: Math.min(dx.hi, dy.hi),
  };

  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      className="mx-auto block w-full max-w-[760px]"
      role="img"
      aria-label="Predicted vs realized tokens"
    >
      {decades(dy).map((d) => (
        <g key={`y${d}`}>
          <line
            x1={left}
            x2={w - right}
            y1={y(d)}
            y2={y(d)}
            className={GRID}
            strokeWidth={0.5}
          />
          <text x={left - 6} y={y(d) + 3} textAnchor="end" className={TICK}>
            {formatCompactNumber(10 ** d)}
          </text>
        </g>
      ))}
      {decades(dx).map((d) => (
        <g key={`x${d}`}>
          <line
            x1={x(d)}
            x2={x(d)}
            y1={top}
            y2={h - bottom}
            className={GRID}
            strokeWidth={0.5}
          />
          <text
            x={x(d)}
            y={h - bottom + 14}
            textAnchor="middle"
            className={TICK}
          >
            {formatCompactNumber(10 ** d)}
          </text>
        </g>
      ))}
      {diagonal.hi > diagonal.lo && (
        <>
          <line
            x1={x(diagonal.lo)}
            y1={y(diagonal.lo)}
            x2={x(diagonal.hi)}
            y2={y(diagonal.hi)}
            className="stroke-muted-foreground"
            strokeWidth={1}
          />
          <text
            x={x(diagonal.hi) - 4}
            y={y(diagonal.hi) + 12}
            textAnchor="end"
            className={TICK}
          >
            y = x
          </text>
        </>
      )}
      {points.map(([px, py], i) => (
        <circle
          // biome-ignore lint/suspicious/noArrayIndexKey: points are positional
          key={i}
          cx={x(px)}
          cy={y(py)}
          r={2.5}
          className={`${BAR} opacity-50`}
        >
          <title>{`predicted ${formatCompactNumber(10 ** px)} · realized ${formatCompactNumber(10 ** py)}`}</title>
        </circle>
      ))}
      <text
        x={(left + w - right) / 2}
        y={h - 4}
        textAnchor="middle"
        className={TICK}
      >
        predicted tokens
      </text>
      <text
        transform={`translate(10 ${(top + h - bottom) / 2}) rotate(-90)`}
        textAnchor="middle"
        className={TICK}
      >
        realized tokens
      </text>
    </svg>
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
  const regions = routingRegions(data.lamStar, data.usdPerToken);
  const routedSmart = data.sessions.filter((s) => s.tier === "smart");
  const smartAnchor: Point | null =
    regions.smart.length === 0 && routedSmart.length > 0
      ? centroid(routedSmart.map((s) => [s.tierNeeded[1], s.tierNeeded[2]]))
      : null;
  const ticks = [0, 0.25, 0.5, 0.75, 1];

  return (
    <svg
      viewBox={`0 0 ${size} ${size}`}
      className="mx-auto w-full max-w-[520px]"
      role="img"
      aria-label="Routing regions"
    >
      {TIER_NAMES.map((tier) =>
        regions[tier].length > 0 ? (
          <path
            key={tier}
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
        if (regions[tier].length === 0) return null;
        const [cx, cy] = centroid(regions[tier]);
        return (
          <text
            key={tier}
            x={x(cx)}
            y={y(cy)}
            textAnchor="middle"
            className={LABEL}
            strokeWidth={4}
            paintOrder="stroke"
          >
            {tier}
          </text>
        );
      })}
      {smartAnchor && (
        <text
          x={x(smartAnchor[0]) + 10}
          y={y(smartAnchor[1]) - 10}
          className={LABEL}
          strokeWidth={4}
          paintOrder="stroke"
        >
          smart
        </text>
      )}
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
