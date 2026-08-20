"use client";

import type { ReactNode } from "react";
import { LoadingSpinner } from "@/components/loading";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface BulkActionsBarProps {
  /**
   * How many rows are ticked. The bar is hidden entirely at 0, so a table
   * carries no bulk chrome until the selection makes it mean something.
   */
  count: number;
  /** Noun for the default label, e.g. `"skill"` → "3 skills selected". */
  noun: string;
  /** Plural of `noun`, when a trailing "s" is wrong. */
  plural?: string;
  /**
   * Overrides the default label. Use when the number the actions apply to is
   * not the number of ticked rows — selecting a directory ticks one row but
   * acts on the documents inside it.
   */
  label?: string;
  /** Omit to leave out the Clear button. */
  onClear?: () => void;
  /** Shows a spinner beside the count while a bulk mutation is in flight. */
  busy?: boolean;
  countTestId?: string;
  /** The bar carries no outer spacing of its own; place it in the caller's flow. */
  className?: string;
  /** The actions themselves, laid out at the end of the bar. */
  children?: ReactNode;
}

/**
 * The bar that appears above a table once rows are ticked: a count, a way to
 * drop the selection, and whatever actions apply to it.
 *
 * Callers own the selection state and pass the actions as children — this owns
 * only the shell, so every table that grows a bulk affordance looks and
 * announces the same.
 */
export function BulkActionsBar({
  count,
  noun,
  plural,
  label,
  onClear,
  busy,
  countTestId,
  className,
  children,
}: BulkActionsBarProps) {
  const text =
    label ?? `${count} ${count === 1 ? noun : (plural ?? `${noun}s`)} selected`;

  return (
    <>
      {/* Mounted unconditionally: a screen reader announces changes to a region
          already in the page, not one inserted with its text in place, so a
          region that appeared with the first tick would stay silent until the
          second. The visible count below carries the same words, so it is the
          one hidden from the reading order. */}
      <span aria-live="polite" className="sr-only">
        {count > 0 ? text : ""}
      </span>

      {count > 0 && (
        <div
          className={cn(
            "flex flex-wrap items-center gap-2 rounded-md border bg-muted/40 px-3 py-2",
            className,
          )}
        >
          <span
            aria-hidden="true"
            data-testid={countTestId}
            className="text-sm font-medium"
          >
            {text}
          </span>
          {busy && <LoadingSpinner className="h-4 w-4 text-muted-foreground" />}
          {onClear && (
            <Button variant="ghost" size="sm" onClick={onClear}>
              <span>Clear</span>
            </Button>
          )}
          <div className="ml-auto flex flex-wrap items-center gap-2">
            {children}
          </div>
        </div>
      )}
    </>
  );
}
