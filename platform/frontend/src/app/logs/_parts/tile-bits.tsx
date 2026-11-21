"use client";

import {
  type LucideIcon,
  Plug,
  ScrollText,
  Shield,
  Sparkles,
  Wrench,
} from "lucide-react";
import {
  type LogBucket,
  type LogSource,
  SOURCE_BY_ID,
} from "@/lib/logs/log-events.query";
import { cn } from "@/lib/utils/tailwind";

export function Sparkline({
  source,
  buckets,
  problemBuckets,
  className = "mb-1 h-8 min-w-0 flex-1",
}: {
  source: LogSource;
  buckets?: LogBucket[];
  problemBuckets?: LogBucket[];
  className?: string;
}) {
  if (!buckets?.length) {
    return <span className={cn("pointer-events-none", className)} />;
  }
  const values = buckets.map((b) => b.bySource[source]);
  const bad = problemBuckets?.map((b) => b.bySource[source]) ?? [];
  const max = Math.max(1, ...values);
  const H = 24;
  return (
    <svg
      viewBox={`0 0 ${values.length * 2} ${H}`}
      preserveAspectRatio="none"
      aria-hidden="true"
      className={cn("pointer-events-none", className)}
    >
      {values.map((v, i) => {
        const h = v === 0 ? 0 : Math.max(1.5, (v / max) * H);
        const p = Math.min(h, bad[i] ? Math.max(1.5, (bad[i] / max) * H) : 0);
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: fixed bucket order
          <g key={i}>
            {h > 0 && (
              <rect
                x={i * 2 + 0.25}
                y={H - h}
                width={1.5}
                height={h}
                className={SPARK_FILL[source]}
              />
            )}
            {p > 0 && (
              <rect
                x={i * 2 + 0.25}
                y={H - p}
                width={1.5}
                height={p}
                className={
                  source === "guardrails" ? "fill-orange-500" : "fill-red-500"
                }
              />
            )}
          </g>
        );
      })}
    </svg>
  );
}

export function compact(n: number) {
  return n >= 10_000 ? `${(n / 1000).toFixed(0)}k` : n.toLocaleString();
}

export const SHORT_LABEL: Record<LogSource, string> = {
  llm: "LLM",
  mcp: "MCP",
  guardrails: "Guardrails",
  connections: "Connections",
  audit: "Audit",
};

const SPARK_FILL: Record<LogSource, string> = {
  llm: "fill-violet-500/60",
  mcp: "fill-sky-500/60",
  guardrails: "fill-amber-500/60",
  connections: "fill-emerald-500/60",
  audit: "fill-slate-500/60",
};

export function SourceTile({
  source,
  size = "sm",
}: {
  source: LogSource;
  size?: "xs" | "sm" | "md";
}) {
  const Icon = SOURCE_ICON[source];
  return (
    <span
      className={cn(
        "flex shrink-0 items-center justify-center",
        SOURCE_BY_ID[source].chip,
        size === "xs" && "size-5 rounded-[5px]",
        size === "sm" && "size-5 rounded-md",
        size === "md" && "size-8 rounded-lg",
      )}
    >
      <Icon className={size === "md" ? "size-4" : "size-3"} />
    </span>
  );
}

export function problemWord(source: LogSource, n: number) {
  const s = n === 1 ? "" : "s";
  if (source === "guardrails") return `${n.toLocaleString()} blocked`;
  if (source === "audit") return `${n.toLocaleString()} failed`;
  return `${n.toLocaleString()} error${s}`;
}

const SOURCE_ICON: Record<LogSource, LucideIcon> = {
  llm: Sparkles,
  mcp: Wrench,
  guardrails: Shield,
  connections: Plug,
  audit: ScrollText,
};
