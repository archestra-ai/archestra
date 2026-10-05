"use client";

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { CoverageRuleCounts } from "@/lib/openappa-coverage.query";
import { cn } from "@/lib/utils/tailwind";

/** Shared coverage categories for the overview chart and entity bars. */
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
    key: "catchAll",
    label: "Catch-all rule",
    description:
      "One rule covers these tools. Add specific rules for more control.",
    color: "var(--chart-3)",
    count: (counts: CoverageRuleCounts) => counts.catchAll,
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
    key: "notCovered",
    label: "No rule",
    description: "Always allowed. Add rules to set limits.",
    // Opaque, so it reads the same over a card, a table row, or a bar track.
    color:
      "color-mix(in oklch, var(--muted-foreground) 55%, var(--background))",
    count: (counts: CoverageRuleCounts) => counts.notCovered,
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
