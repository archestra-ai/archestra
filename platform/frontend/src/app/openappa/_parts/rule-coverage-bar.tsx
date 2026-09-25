"use client";

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { CoverageRuleCounts } from "@/lib/openappa-coverage.query";
import { cn } from "@/lib/utils";

/**
 * What judges a tool, in a fixed order, name, and color so the same bucket
 * reads the same in every chart: enforced rules first, then the ones that do
 * not hold, then the tools no rule names. The catch-all and the built-in
 * fallback both judge a tool no rule names, so they are one bucket.
 */
export const RULE_BUCKETS = [
  {
    key: "root",
    label: "Custom rule",
    description: "A rule you wrote in your policy judges these tools.",
    color: "var(--chart-1)",
    count: (counts: CoverageRuleCounts) => counts.root,
  },
  {
    key: "battery",
    label: "Battery rule",
    description: "A rule from an included battery judges these tools.",
    color: "var(--chart-2)",
    count: (counts: CoverageRuleCounts) => counts.battery,
  },
  {
    key: "notEnforced",
    label: "Not enforced",
    description:
      "A rule names these tools but does not run, usually because its battery is broken.",
    color: "var(--chart-4)",
    count: (counts: CoverageRuleCounts) => counts.notEnforced,
  },
  {
    key: "noRule",
    label: "No rule",
    description:
      "No rule names these tools, so your policy's catch-all decides their calls.",
    // Opaque, so it reads the same over a card, a table row, or a bar track.
    color:
      "color-mix(in oklch, var(--muted-foreground) 55%, var(--background))",
    count: (counts: CoverageRuleCounts) =>
      counts.catchAll + counts.builtInFallback,
  },
] as const;

/**
 * One target's tools as a stacked bar, broken down on hover; the label carries
 * the same breakdown for screen readers.
 */
export function RuleCoverageBar({
  counts,
  total,
  className,
}: {
  counts: CoverageRuleCounts;
  total: number;
  className?: string;
}) {
  const present = RULE_BUCKETS.map((bucket) => ({
    ...bucket,
    value: bucket.count(counts),
  })).filter(({ value }) => value > 0);
  const summary = present
    .map(({ label, value }) => `${label}: ${value}`)
    .join(", ");

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div
          role="img"
          aria-label={total === 0 ? "No tools" : summary}
          className={cn(
            "bg-muted flex h-2 w-full gap-0.5 overflow-hidden rounded-full",
            className,
          )}
        >
          {total > 0 &&
            present.map(({ key, color, value }) => (
              <div
                key={key}
                className="h-full"
                style={{
                  width: `${(value / total) * 100}%`,
                  backgroundColor: color,
                }}
              />
            ))}
        </div>
      </TooltipTrigger>
      <TooltipContent>
        {total === 0 ? (
          <span>No tools</span>
        ) : (
          <dl className="space-y-1">
            {present.map(({ key, label, color, value }) => (
              <div key={key} className="flex items-center gap-2">
                <span
                  aria-hidden
                  className="size-2 shrink-0 rounded-full"
                  style={{ backgroundColor: color }}
                />
                <dt>{label}</dt>
                <dd className="ml-auto pl-3 tabular-nums">{value}</dd>
              </div>
            ))}
          </dl>
        )}
      </TooltipContent>
    </Tooltip>
  );
}
