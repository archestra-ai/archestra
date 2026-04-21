"use client";

import { Check, ChevronDown, Minus } from "lucide-react";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export type StepState = "todo" | "active" | "done" | "skipped";

interface StepNumberProps {
  n?: number;
  state: StepState;
}

function StepNumber({ n, state }: StepNumberProps) {
  return (
    <div
      className={cn(
        "flex size-8 shrink-0 items-center justify-center rounded-full border text-[13px] font-bold transition-all",
        "font-mono",
        state === "active" &&
          "border-primary bg-primary text-primary-foreground ring-4 ring-primary/10",
        state === "done" &&
          "border-green-300 bg-green-100 text-green-700 dark:border-green-700 dark:bg-green-950 dark:text-green-400",
        state === "skipped" && "border-border bg-muted text-muted-foreground",
        state === "todo" && "border-border bg-background text-muted-foreground",
      )}
    >
      {state === "done" ? (
        <Check className="size-3.5" strokeWidth={3} />
      ) : state === "skipped" ? (
        <Minus className="size-3" strokeWidth={2.5} />
      ) : n !== undefined ? (
        n
      ) : null}
    </div>
  );
}

function StatusChip({ state }: { state: StepState }) {
  if (state === "done") {
    return (
      <Badge
        variant="outline"
        className="border-green-300 bg-green-100 font-mono text-[10.5px] font-bold uppercase tracking-wider text-green-700 dark:border-green-800 dark:bg-green-950 dark:text-green-400"
      >
        Done
      </Badge>
    );
  }
  if (state === "skipped") {
    return (
      <Badge
        variant="outline"
        className="bg-muted font-mono text-[10.5px] font-bold uppercase tracking-wider text-muted-foreground"
      >
        Skipped
      </Badge>
    );
  }
  if (state === "active") {
    return (
      <Badge
        variant="outline"
        className="gap-1.5 border-primary/20 bg-primary/10 font-mono text-[10.5px] font-bold uppercase tracking-wider text-primary"
      >
        <span className="size-1.5 animate-pulse rounded-full bg-primary" />
        In progress
      </Badge>
    );
  }
  return null;
}

interface StepCardProps {
  number?: number;
  title: ReactNode;
  subtitle?: ReactNode;
  state: StepState;
  expanded: boolean;
  /** Omit to make the card non-interactive (e.g. always-expanded). */
  onToggle?: () => void;
  actions?: ReactNode;
  children?: ReactNode;
  /**
   * When true, render at full opacity and omit the chevron — the card is
   * always expanded by design, not because a pre-requisite is missing.
   */
  pinned?: boolean;
  /** Hide the number/state indicator and the status chip. */
  hideStatus?: boolean;
}

export function StepCard({
  number,
  title,
  subtitle,
  state,
  expanded,
  onToggle,
  actions,
  children,
  pinned = false,
  hideStatus = false,
}: StepCardProps) {
  const dimmed = !onToggle && !pinned;
  const showChevron = !!onToggle;

  return (
    <section
      className={cn(
        "overflow-hidden rounded-xl border bg-card shadow-sm transition-all",
        expanded && !pinned && "border-primary/60 ring-4 ring-primary/5",
        dimmed && "opacity-55",
      )}
    >
      <div className="flex select-none flex-wrap items-center gap-3 px-5 py-4 sm:gap-3.5">
        <button
          type="button"
          disabled={!onToggle}
          onClick={onToggle}
          className={cn(
            "flex min-w-0 flex-1 basis-full items-center gap-3.5 bg-transparent text-left outline-none sm:basis-0",
            onToggle && "cursor-pointer focus-visible:opacity-80",
          )}
          aria-expanded={expanded}
        >
          {!hideStatus && <StepNumber n={number} state={state} />}

          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-[17px] font-bold tracking-tight text-foreground">
                {title}
              </h3>
              {!hideStatus && <StatusChip state={state} />}
            </div>
            {subtitle && (
              <div className="mt-0.5 text-xs text-muted-foreground">
                {subtitle}
              </div>
            )}
          </div>
        </button>

        {actions && (
          <div className="ml-[42px] flex shrink-0 flex-wrap items-center gap-2 sm:ml-0">
            {actions}
          </div>
        )}

        {showChevron && (
          <button
            type="button"
            onClick={onToggle}
            aria-label={expanded ? "Collapse step" : "Expand step"}
            className={cn(
              "ml-auto flex size-7 shrink-0 items-center justify-center rounded text-muted-foreground transition-transform hover:bg-muted sm:ml-1",
              expanded && "rotate-180",
            )}
          >
            <ChevronDown className="size-3.5" strokeWidth={2.2} />
          </button>
        )}
      </div>

      {expanded && <div className="border-t px-5 pb-5 pt-4">{children}</div>}
    </section>
  );
}
