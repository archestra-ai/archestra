"use client";
import { ArrowDownRight, ArrowUpRight } from "lucide-react";
import type { ReactNode } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils/tailwind";
import { formatCompact, formatCost, formatInt } from "./cost-explorer.query";

const sum = (values: number[]) =>
  values.reduce((total, value) => total + value, 0);
export function fmtMetric(
  metric: "billed" | "subscription" | "requests" | "tokens",
  n: number,
  precise = false,
) {
  if (metric === "billed" || metric === "subscription") {
    return precise && n < 1000 ? `$${n.toFixed(2)}` : formatCost(n);
  }
  if (metric === "requests" && precise) return formatInt(n);
  return formatCompact(n);
}

function Sparkline({
  values,
  className,
  dashed,
  fill = true,
}: {
  values: number[];
  className?: string;
  dashed?: boolean;
  fill?: boolean;
}) {
  if (values.length < 2) return <div className={cn("h-6", className)} />;
  const max = Math.max(...values) || 1;
  const pts = values.map((v, i) => [
    (i / (values.length - 1)) * 100,
    23 - (v / max) * 21,
  ]);
  const line = pts
    .map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(2)},${y.toFixed(2)}`)
    .join("");
  return (
    <svg
      viewBox="0 0 100 24"
      preserveAspectRatio="none"
      aria-hidden="true"
      className={cn("h-6 w-full overflow-visible", className)}
    >
      {fill && (
        <path d={`${line}L100,24L0,24Z`} fill="currentColor" opacity={0.1} />
      )}
      <path
        d={line}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeDasharray={dashed ? "3 2" : undefined}
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

/** Second half of the range vs the first half. */
function halfDelta(series: number[]) {
  if (series.length < 4) return null;
  const h = Math.floor(series.length / 2);
  const a = sum(series.slice(0, h));
  const b = sum(series.slice(series.length - h));
  if (!a) return null;
  return (b - a) / a;
}

function DeltaChip({ delta }: { delta: number | null }) {
  if (delta === null || !Number.isFinite(delta)) return null;
  const up = delta >= 0;
  const Icon = up ? ArrowUpRight : ArrowDownRight;
  return (
    <span
      title="Second half of the range vs the first half"
      className="inline-flex items-center gap-0.5 rounded-full bg-muted px-1.5 py-0.5 text-[11px] font-medium tabular-nums text-muted-foreground"
    >
      <Icon className="size-3" />
      {Math.abs(delta * 100).toFixed(0)}%
    </span>
  );
}

// ===== KPI tile =====
export function KpiTile({
  label,
  value,
  caption,
  series,
  pending,
  estimate,
  colorClass = "text-chart-1",
  extra,
}: {
  label: string;
  value: string;
  caption: ReactNode;
  series?: number[];
  pending?: boolean;
  estimate?: boolean;
  colorClass?: string;
  extra?: ReactNode;
}) {
  const body = (
    <>
      <div className="flex items-center justify-between gap-2">
        <span className="line-clamp-2 text-xs font-medium text-muted-foreground sm:line-clamp-none sm:truncate">
          {label}
        </span>
        {series && <DeltaChip delta={halfDelta(series)} />}
      </div>
      {pending ? (
        <Skeleton className="h-8 w-24" />
      ) : (
        <div className="flex items-baseline gap-1.5">
          <span className="text-2xl font-semibold tracking-tight tabular-nums">
            {value}
          </span>
          {estimate && (
            <span className="text-xs font-medium text-muted-foreground">
              est.
            </span>
          )}
        </div>
      )}
      <div className="line-clamp-2 text-xs text-muted-foreground sm:line-clamp-none sm:truncate">
        {caption}
      </div>
      <div className={cn("mt-auto pt-1", colorClass)}>
        {series ? (
          <Sparkline values={series} dashed={estimate} />
        ) : (
          (extra ?? <div className="h-6" />)
        )}
      </div>
    </>
  );
  return (
    <div
      className={cn(
        "relative flex min-w-0 flex-col gap-1 rounded-xl border bg-card p-3 sm:p-4",
        estimate && "border-dashed bg-transparent",
      )}
    >
      {body}
    </div>
  );
}
