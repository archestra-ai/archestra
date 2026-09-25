"use client";

import { MessageCircle } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { QueryLoadError } from "@/components/query-load-error";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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
import { openAppaChatHref } from "@/lib/openappa-routes";
import { cn } from "@/lib/utils";
import { BatteriesCard, hasBatteries } from "./batteries-card";
import { RULE_BUCKETS } from "./rule-coverage-bar";

type Totals = CoverageSummary["totals"];

/**
 * How many of the visible tools a rule covers, and the batteries that cover or
 * could cover them. Each card takes the width its content needs.
 */
export function CoverageCharts() {
  const summary = useCoverageSummary();
  // Held open while loading, so the layout does not jump when it fits.
  const batteries = summary.data
    ? hasBatteries(summary.data.batteries)
    : !summary.isLoadingError;

  return (
    <div className="@container">
      <div className="grid gap-4 @3xl:grid-cols-[auto_minmax(0,1fr)]">
        <ToolCoverageCard summary={summary} />
        {batteries && <BatteriesCard summary={summary.data ?? undefined} />}
      </div>
    </div>
  );
}

function ToolCoverageCard({
  summary,
}: {
  summary: ReturnType<typeof useCoverageSummary>;
}) {
  const totals = summary.data?.totals;

  return (
    <Card className="gap-4 py-5">
      <CardHeader className="gap-1 px-5">
        <CardTitle>Tool coverage</CardTitle>
        <CardDescription className="text-xs">
          {totals
            ? `What judges each of your ${totals.tools.toLocaleString()} MCP server tools`
            : "What judges each of your MCP server tools"}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col justify-center px-5">
        {summary.isLoadingError ? (
          <QueryLoadError
            title="Could not load tool coverage"
            onRetry={() => summary.refetch()}
          />
        ) : !totals ? (
          <div className="flex items-center gap-6">
            <Skeleton className="size-40 shrink-0 rounded-full" />
            <Skeleton className="h-32 w-64" />
          </div>
        ) : totals.tools === 0 ? (
          <p className="text-muted-foreground py-8 text-center text-sm">
            No MCP server tools yet.
          </p>
        ) : (
          <CoverageDonut totals={totals} />
        )}
      </CardContent>
      {totals && totals.tools > 0 && (
        <CardFooter className="px-5">
          <Button size="sm" variant="outline" asChild>
            <Link href={openAppaChatHref({ promptKey: "improveCoverage" })}>
              <MessageCircle />
              <span>Improve with chat</span>
            </Link>
          </Button>
        </CardFooter>
      )}
    </Card>
  );
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
  const covered = totals.root + totals.battery;
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
    <div className="flex flex-col items-center gap-x-8 gap-y-5 @md:flex-row">
      <div className="relative size-40 shrink-0">
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
          <span className="text-3xl font-semibold tabular-nums">
            {`${share(focus ? focus.value : covered, totals.tools)}%`}
          </span>
          <span className="text-muted-foreground text-sm">
            {focus ? focus.label.toLowerCase() : "have a rule"}
          </span>
        </div>
      </div>
      <dl className="grid min-w-64 grid-cols-[auto_minmax(0,1fr)_auto_auto] items-center gap-x-3 text-sm">
        {slices.map((slice) => (
          <Tooltip key={slice.key}>
            <TooltipTrigger asChild>
              <div
                className={cn(
                  "col-span-4 grid grid-cols-subgrid items-center py-1.5 transition-opacity duration-150 motion-reduce:transition-none",
                  hovered && slice.key !== hovered && "opacity-50",
                )}
                {...hover(slice.key)}
              >
                <span
                  aria-hidden
                  className="size-2.5 rounded-full"
                  style={{ backgroundColor: slice.color }}
                />
                <dt className="text-muted-foreground truncate">
                  {slice.label}
                </dt>
                <dd className="text-right font-medium tabular-nums">
                  {slice.value.toLocaleString()}
                </dd>
                <dd className="text-muted-foreground w-9 text-right text-xs tabular-nums">
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
