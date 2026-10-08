"use client";

import { ArrowRight, CircleCheck, TriangleAlert } from "lucide-react";
import { type ReactNode, useState } from "react";
import { QueryLoadError } from "@/components/query-load-error";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { UnstyledButton } from "@/components/ui/unstyled-button";
import {
  type RemediesView,
  type Remedy,
  useRemedies,
} from "@/lib/openappa-remedies.query";
import { cn } from "@/lib/utils/tailwind";
import { gapCount, gapLines, runsAsBreakdown } from "./remedies.utils";
import { RemediesDialog, type RemedyFilter } from "./remedies-dialog";

/**
 * Three panels beside the security label: the authorities that can approve
 * a blocked call, the sanitizers that can clean data, and the kinds of block
 * the rules can cause that nothing lifts.
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
        <Panel title="Authorities" loading />
        <Panel title="Sanitizers" loading />
        <Panel title="Gaps" loading />
      </>
    );

  return (
    <>
      <CountPanel
        title="Authorities"
        remedies={view.data.authorities}
        detail="can approve a blocked call"
        empty="nobody can approve a blocked call"
        onOpen={() => setOpen("authority")}
      />
      <CountPanel
        title="Sanitizers"
        remedies={view.data.sanitizers}
        detail="can clean a tool result or arguments to approve a blocked call"
        empty="nothing cleans data"
        onOpen={() => setOpen("sanitizer")}
      />
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

function Panel({
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
    <Card className="gap-3 py-4">
      <CardHeader className="flex items-center justify-between px-4">
        <CardTitle className="text-xs font-medium">{title}</CardTitle>
        {action}
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

function CountPanel({
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
  const breakdown = runsAsBreakdown(remedies);
  const wired = breakdown.reduce((total, group) => total + group.count, 0);
  return (
    <Panel
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
      {wired > 0 && (
        <div className="mt-auto space-y-1.5 pt-2">
          <div
            role="img"
            aria-label={breakdown
              .map((group) => `${group.label}: ${group.count}`)
              .join(", ")}
            className="flex h-1.5 gap-0.5"
          >
            {breakdown.map((group) => (
              <span
                key={group.key}
                className="rounded-sm"
                style={{
                  flex: `${group.count} 1 0`,
                  backgroundColor: group.color,
                }}
              />
            ))}
          </div>
          <ul className="text-muted-foreground flex flex-wrap gap-x-2.5 gap-y-1 text-[11px]">
            {breakdown.map((group) => (
              <li key={group.key} className="flex items-center gap-1">
                <span
                  aria-hidden
                  className="size-1.5 rounded-sm"
                  style={{ backgroundColor: group.color }}
                />
                <span className="tabular-nums">{`${group.count} ${group.label}`}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Panel>
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
          ? "every block has a way out"
          : "kinds of block with no way out"}
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
