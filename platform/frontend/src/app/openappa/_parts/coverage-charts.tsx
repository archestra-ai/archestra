"use client";

import { useState } from "react";
import { QueryLoadError } from "@/components/query-load-error";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  type CoverageSummary,
  useCoverageSummary,
} from "@/lib/openappa-coverage.query";
import { cn } from "@/lib/utils/tailwind";
import { CoverageWarnings } from "./coverage-warnings";
import { RULE_BUCKETS } from "./rule-coverage-bar";
import { StepCard } from "./step-card";

type Totals = CoverageSummary["totals"];

/**
 * Step two of "How your policy decides": how many of the visible tools a rule
 * annotates, as a donut, with a warning when tools run with no rule at all.
 */
export function RulesCard() {
  const summary = useCoverageSummary();
  const totals = summary.data?.totals;

  return (
    <StepCard
      step={2}
      title="Rules annotate your tools"
      description="A rule says which label a tool needs. Tools without one always run."
    >
      {summary.isLoadingError ? (
        <QueryLoadError
          title="Could not load tool coverage"
          onRetry={() => summary.refetch()}
        />
      ) : !totals ? (
        <div className="flex items-center justify-center gap-6">
          <Skeleton className="size-32 shrink-0 rounded-full" />
          <Skeleton className="hidden h-28 flex-1 @[22rem]:block" />
        </div>
      ) : totals.tools === 0 ? (
        <p className="text-muted-foreground py-8 text-center text-sm">
          No MCP server tools yet.
        </p>
      ) : (
        <>
          <CoverageDonut totals={totals} />
          <div className="mt-auto space-y-2">
            <CompositionCaption composition={summary.data?.composition} />
            <CoverageWarnings totals={totals} />
          </div>
        </>
      )}
    </StepCard>
  );
}

/** Which composition the chart describes, when it is not the latest revision's. */
function CompositionCaption({
  composition,
}: {
  composition: CoverageSummary["composition"] | undefined;
}) {
  if (!composition || composition.kind === "current") return null;
  return (
    <p
      className="text-xs text-muted-foreground"
      data-testid="coverage-composition-caption"
    >
      <span>{compositionCaption(composition)}</span>
    </p>
  );
}

function compositionCaption(composition: CoverageSummary["composition"]) {
  if (composition.kind === "root_only")
    return "Nothing is enforced: the policy could not be composed and no composition opened before it.";
  const { servedRootRevision: served, refusedRootRevision: refused } =
    composition;
  const showing =
    served === null
      ? "Showing the earlier composition the runtime still enforces"
      : served === refused
        ? `Showing the earlier composition of revision ${served} the runtime still enforces`
        : `Showing revision ${served}, which the runtime still enforces`;
  const attempt =
    refused === null ? "the latest revision" : `revision ${refused}`;
  const differ = composition.rulesMayDiffer
    ? " The rules below are the current text's and may differ from what runs."
    : "";
  return `${showing}; ${attempt} was refused.${differ}`;
}

const share = (count: number, of: number) => Math.round((count / of) * 100);

const RADIUS = 42;
/** The gap between two slices, as an arc length on the ring. */
const GAP = 1.5;

/** The point on the ring at `angle` radians clockwise from the top. */
const point = (angle: number) =>
  `${50 + RADIUS * Math.sin(angle)} ${50 - RADIUS * Math.cos(angle)}`;

type Slice = (typeof RULE_BUCKETS)[number] & { value: number };

/**
 * Every tool once, by what judges it, as a donut with its legend. Hovering a
 * slice or its legend row picks it out and puts its share in the middle.
 */
function CoverageDonut({ totals }: { totals: Totals }) {
  const [hovered, setHovered] = useState<string | null>(null);
  const covered = totals.root + totals.battery + totals.catchAll;
  const slices: Slice[] = RULE_BUCKETS.map((bucket) => ({
    ...bucket,
    value: bucket.count(totals),
  }));
  const shown = slices.filter((slice) => slice.value > 0);
  const focus = slices.find((slice) => slice.key === hovered);
  const hover = (key: string) => ({
    onPointerEnter: () => setHovered(key),
    onPointerLeave: () => setHovered(null),
  });

  // A sliver between slices, unless one slice is the whole ring.
  const gap = shown.length > 1 ? GAP / RADIUS : 0;
  let start = 0;
  const arcs = shown.map((slice) => {
    const sweep = (slice.value / totals.tools) * 2 * Math.PI;
    const from = start + gap / 2;
    const to = Math.max(start + sweep - gap / 2, from + 0.01);
    start += sweep;
    return { slice, from, to };
  });

  return (
    // The legend shows beside the donut while the card is wide enough for
    // both; narrower, the donut stands alone and hovering a slice names it.
    <div className="flex items-center justify-center gap-5">
      <div className="relative size-32 shrink-0">
        <svg
          viewBox="0 0 100 100"
          className="size-full"
          role="img"
          aria-label={slices
            .map((slice) => `${slice.label}: ${slice.value}`)
            .join(", ")}
        >
          <circle
            cx="50"
            cy="50"
            r={RADIUS}
            fill="none"
            strokeWidth="10"
            className="stroke-muted"
          />
          {arcs.map(({ slice, from, to }) => (
            <Tooltip key={slice.key}>
              <TooltipTrigger asChild>
                {shown.length === 1 ? (
                  <circle
                    cx="50"
                    cy="50"
                    r={RADIUS}
                    fill="none"
                    strokeWidth="10"
                    stroke={slice.color}
                    {...hover(slice.key)}
                  />
                ) : (
                  <path
                    d={`M ${point(from)} A ${RADIUS} ${RADIUS} 0 ${to - from > Math.PI ? 1 : 0} 1 ${point(to)}`}
                    fill="none"
                    strokeWidth={slice.key === hovered ? 12 : 10}
                    stroke={slice.color}
                    className={cn(
                      "transition-[opacity,stroke-width] duration-150 motion-reduce:transition-none",
                      hovered && slice.key !== hovered && "opacity-40",
                    )}
                    {...hover(slice.key)}
                  />
                )}
              </TooltipTrigger>
              <SliceTooltip slice={slice} total={totals.tools} />
            </Tooltip>
          ))}
        </svg>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-2xl font-semibold tabular-nums">
            {`${share(focus ? focus.value : covered, totals.tools)}%`}
          </span>
          <span className="text-muted-foreground text-xs">
            {focus ? focus.label.toLowerCase() : "covered"}
          </span>
        </div>
      </div>
      <dl className="hidden min-w-0 flex-1 grid-cols-[auto_minmax(0,1fr)_auto_auto] items-center gap-x-2.5 text-xs @[22rem]:grid">
        {slices.map((slice) => (
          <Tooltip key={slice.key}>
            <TooltipTrigger asChild>
              <div
                className={cn(
                  "col-span-4 grid grid-cols-subgrid items-center py-1 transition-opacity duration-150 motion-reduce:transition-none",
                  hovered && slice.key !== hovered && "opacity-50",
                )}
                {...hover(slice.key)}
              >
                <span
                  aria-hidden
                  className="size-2 rounded-full"
                  style={{ backgroundColor: slice.color }}
                />
                <dt className="text-muted-foreground truncate">
                  {slice.label}
                </dt>
                <dd className="text-right font-medium tabular-nums">
                  {slice.value.toLocaleString()}
                </dd>
                <dd className="text-muted-foreground w-8 text-right tabular-nums">
                  {`${share(slice.value, totals.tools)}%`}
                </dd>
              </div>
            </TooltipTrigger>
            <SliceTooltip slice={slice} total={totals.tools} />
          </Tooltip>
        ))}
      </dl>
    </div>
  );
}

function SliceTooltip({ slice, total }: { slice: Slice; total: number }) {
  return (
    <TooltipContent className="max-w-64">
      <div className="flex items-center gap-2 font-medium">
        <span
          aria-hidden
          className="size-2 shrink-0 rounded-full"
          style={{ backgroundColor: slice.color }}
        />
        <span>{slice.label}</span>
        <span className="ml-auto pl-3 tabular-nums">
          {`${slice.value.toLocaleString()} ${slice.value === 1 ? "tool" : "tools"}, ${share(slice.value, total)}%`}
        </span>
      </div>
      <p className="mt-1 opacity-80">{slice.description}</p>
    </TooltipContent>
  );
}
