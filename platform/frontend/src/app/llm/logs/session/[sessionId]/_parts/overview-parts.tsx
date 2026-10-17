"use client";

import { ChevronDown, ChevronUp } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import { PaneHeader } from "@/components/log-detail/pane-header";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils/tailwind";

// The pieces the details pane's left column is built from, whichever kind of
// record is selected.

/** "Overview 3 of 12" with the stepper through the page's records. */
export function OverviewHeader({
  index,
  count,
  onStep,
}: {
  index: number;
  count: number;
  onStep: (delta: number) => void;
}) {
  return (
    <PaneHeader>
      <span className="text-xs font-medium">Overview</span>
      <span className="text-[11px] text-muted-foreground tabular-nums">
        {index + 1} of {count}
      </span>
      <span className="-mr-1.5 ml-auto inline-flex items-center">
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => onStep(-1)}
          disabled={index <= 0}
          aria-label="Previous in session"
        >
          <ChevronUp />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => onStep(1)}
          disabled={index >= count - 1}
          aria-label="Next in session"
        >
          <ChevronDown />
        </Button>
      </span>
    </PaneHeader>
  );
}

export function OverviewSection({
  title,
  aside,
  children,
}: {
  title?: string;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="min-w-0 px-4 py-3.5">
      {title ? (
        <div className="mb-2.5 flex items-baseline justify-between gap-3">
          <h3 className="text-xs text-muted-foreground">{title}</h3>
          {aside}
        </div>
      ) : null}
      {children}
    </section>
  );
}

/** A label/value row; render inside a `<dl>`. */
export function OverviewFact({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4 py-[3px] text-xs">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="flex min-w-0 justify-end text-right tabular-nums">
        {children}
      </dd>
    </div>
  );
}

export function BigFigure({
  value,
  muted,
}: {
  value: string;
  muted?: boolean;
}) {
  return (
    <span
      className={cn(
        "text-base leading-5 font-semibold tracking-tight tabular-nums",
        muted && "text-muted-foreground",
      )}
    >
      {value}
    </span>
  );
}

/** Phones keep the details in page flow; the height only applies from `lg`. */
export function paneHeight(height: number): CSSProperties {
  return { "--pane-h": `${height}px` } as CSSProperties;
}
