"use client";

import { ArrowRight, CircleCheck, TriangleAlert } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Bar, BarChart } from "recharts";
import { QueryLoadError } from "@/components/query-load-error";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import { Skeleton } from "@/components/ui/skeleton";
import { UnstyledButton } from "@/components/ui/unstyled-button";
import {
  type ActivityDay,
  type RemediesView,
  type Remedy,
  useRemedies,
  useRemediesActivity,
} from "@/lib/openappa-remedies.query";
import { cn } from "@/lib/utils/tailwind";
import { gapCount, gapLines } from "./remedies.utils";
import {
  activityBars,
  activityHeadline,
  activityTotals,
} from "./remedies-activity.utils";
import { RemediesDialog, type RemedyFilter } from "./remedies-dialog";

/** The three ways a denied call ends, bottom of the stack first. */
const OUTCOMES: ChartConfig = {
  blocked: { label: "stayed blocked", color: "var(--muted-foreground)" },
  approved: {
    label: "approved by an authority",
    color: "var(--color-blue-400)",
  },
  cleaned: { label: "cleaned by a sanitizer", color: "var(--color-pink-400)" },
};

/**
 * Beside the security label: one card with the authorities that can approve
 * a blocked call and the sanitizers that can clean data, and under them the
 * week's denied calls by how each ended; then the kinds of block nothing
 * lifts.
 */
export function RemediesPanels() {
  const view = useRemedies();
  const [open, setOpen] = useState<RemedyFilter | null>(null);

  if (view.isLoadingError)
    return (
      <Card className="py-5 xl:col-span-3">
        <CardContent className="px-5">
          <QueryLoadError
            title="Could not load authorities and sanitizers"
            onRetry={() => view.refetch()}
          />
        </CardContent>
      </Card>
    );
  if (!view.data)
    return (
      <>
        <Card className="py-4 xl:col-span-2">
          <CardContent className="grid gap-6 px-4 sm:grid-cols-2">
            <Column title="Authorities" loading />
            <Column title="Sanitizers" loading />
          </CardContent>
          <CardContent className="mt-auto px-4">
            <Skeleton className="h-24 w-full" />
          </CardContent>
        </Card>
        <Panel title="Gaps" loading />
      </>
    );

  return (
    <>
      <Card className="py-4 xl:col-span-2">
        <CardContent className="grid gap-6 px-4 sm:grid-cols-2">
          <CountColumn
            title="Authorities"
            remedies={view.data.authorities}
            detail="can approve a blocked call"
            empty="nobody can approve a blocked call"
            onOpen={() => setOpen("authority")}
          />
          <CountColumn
            title="Sanitizers"
            remedies={view.data.sanitizers}
            detail="can clean a tool result or arguments to approve a blocked call"
            empty="nothing cleans data"
            onOpen={() => setOpen("sanitizer")}
          />
        </CardContent>
        <CardContent className="mt-auto px-4">
          <ActivityWeek />
        </CardContent>
      </Card>
      <GapsPanel view={view.data} />
      <RemediesDialog
        view={view.data}
        filter={open}
        onClose={() => setOpen(null)}
      />
    </>
  );
}

// =============================================================================
// Internal components
// =============================================================================

/** A column of the shared card: the title row, then its body. */
function Column({
  title,
  action,
  loading,
  children,
}: {
  title: string;
  action?: ReactNode;
  loading?: boolean;
  children?: ReactNode;
}) {
  return (
    <section className="flex min-w-0 flex-col gap-2.5">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-medium">{title}</h3>
        {action}
      </div>
      {loading ? (
        <>
          <Skeleton className="h-9 w-16" />
          <Skeleton className="h-4 w-40" />
        </>
      ) : (
        children
      )}
    </section>
  );
}

function Panel({
  title,
  loading,
  children,
}: {
  title: string;
  loading?: boolean;
  children?: ReactNode;
}) {
  return (
    <Card className="gap-3 py-4">
      <CardHeader className="flex items-center justify-between px-4">
        <CardTitle className="text-xs font-medium">{title}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col gap-2.5 px-4">
        {loading ? (
          <>
            <Skeleton className="h-9 w-16" />
            <Skeleton className="h-4 w-40" />
          </>
        ) : (
          children
        )}
      </CardContent>
    </Card>
  );
}

function CountColumn({
  title,
  remedies,
  detail,
  empty,
  onOpen,
}: {
  title: string;
  remedies: Remedy[];
  detail: string;
  empty: string;
  onOpen: () => void;
}) {
  return (
    <Column
      title={title}
      action={
        remedies.length > 0 && (
          <UnstyledButton
            onClick={onOpen}
            className="text-muted-foreground hover:text-foreground flex items-center gap-1 text-xs"
          >
            <span>All</span>
            <ArrowRight aria-hidden className="size-3" />
          </UnstyledButton>
        )
      }
    >
      <Count value={remedies.length} muted={remedies.length === 0} />
      <p className="text-muted-foreground text-xs">
        {remedies.length === 0 ? empty : detail}
      </p>
    </Column>
  );
}

/**
 * The last seven days of denied calls, each by how it ended: approved by an
 * authority, cleaned by a sanitizer, or blocked when neither lifted it.
 */
function ActivityWeek() {
  const activity = useRemediesActivity();
  const days: ActivityDay[] = activity.data?.days ?? [];
  const headline = activityHeadline(activityTotals(days));

  return (
    <div className="space-y-2">
      <div className="text-muted-foreground flex items-center justify-between gap-2 text-[11px]">
        <span>Denied calls · last 7 days</span>
        {activity.data ? (
          <span className="tabular-nums">{headline}</span>
        ) : activity.isLoadingError ? (
          <UnstyledButton
            onClick={() => activity.refetch()}
            className="hover:text-foreground underline"
          >
            Could not load · retry
          </UnstyledButton>
        ) : (
          <Skeleton className="h-3 w-40" />
        )}
      </div>
      {activity.data ? (
        <ChartContainer config={OUTCOMES} className="aspect-auto h-16 w-full">
          <BarChart
            accessibilityLayer
            data={activityBars(days)}
            margin={{ top: 0, left: 0, right: 0, bottom: 0 }}
            barCategoryGap={3}
          >
            <ChartTooltip
              cursor={{ fill: "var(--muted)", fillOpacity: 0.6 }}
              content={
                <ChartTooltipContent
                  labelFormatter={(_, payload) => {
                    const bar = payload[0]?.payload as
                      | { date?: string }
                      | undefined;
                    return bar?.date ?? "";
                  }}
                />
              }
            />
            {Object.entries(OUTCOMES).map(([key, series], index, all) => (
              <Bar
                key={key}
                dataKey={key}
                stackId="week"
                fill={series.color}
                fillOpacity={key === "blocked" ? 0.35 : 1}
                isAnimationActive={false}
                radius={index === all.length - 1 ? [2, 2, 0, 0] : 0}
              />
            ))}
          </BarChart>
        </ChartContainer>
      ) : (
        <Skeleton className="h-16 w-full" />
      )}
      <ul className="text-muted-foreground flex flex-wrap gap-x-2.5 gap-y-1 text-[11px]">
        {Object.entries(OUTCOMES).map(([key, series]) => (
          <li key={key} className="flex items-center gap-1">
            <span
              aria-hidden
              className="size-1.5 rounded-sm"
              style={{
                backgroundColor: series.color,
                opacity: key === "blocked" ? 0.35 : 1,
              }}
            />
            <span>{series.label}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function GapsPanel({ view }: { view: RemediesView }) {
  const lines = gapLines(view);
  const gaps = gapCount(view);
  return (
    <Panel title="Gaps">
      <Count
        value={gaps}
        className={cn(
          gaps > 0
            ? "text-amber-600 dark:text-amber-400"
            : "text-emerald-600 dark:text-emerald-400",
        )}
      />
      <p className="text-muted-foreground text-xs">
        {gaps === 0
          ? "no label keeps a blocked call blocked"
          : gaps === 1
            ? "label where blocked calls stay blocked"
            : "labels where blocked calls stay blocked"}
      </p>
      {lines.length > 0 && (
        <ul className="text-muted-foreground space-y-1.5 pt-1 text-xs">
          {lines.map((line) => (
            <li key={line.key} className="flex gap-1.5">
              {line.covered ? (
                <CircleCheck
                  aria-label="Covered"
                  className="mt-0.5 size-3 shrink-0 text-emerald-600 dark:text-emerald-400"
                />
              ) : (
                <TriangleAlert
                  aria-label="Gap"
                  className="mt-0.5 size-3 shrink-0 text-amber-600 dark:text-amber-400"
                />
              )}
              <span className="min-w-0">
                <span
                  className={cn(
                    "font-medium",
                    line.covered ? "text-muted-foreground" : "text-foreground",
                  )}
                >
                  {line.label}
                </span>
                <span>{` · ${line.text}`}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function Count({
  value,
  muted,
  className,
}: {
  value: number;
  muted?: boolean;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "text-4xl font-semibold leading-none tabular-nums",
        muted && "text-muted-foreground",
        className,
      )}
    >
      {value.toLocaleString()}
    </span>
  );
}
