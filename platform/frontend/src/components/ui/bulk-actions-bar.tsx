"use client";

import type { ReactNode } from "react";
import { LoadingState } from "@/components/loading";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Lets a selection escalate past the page it was made on: tick every row on
 * screen and the bar offers the whole matching set instead.
 *
 * The caller decides what "matching" means and how to act on it — this only
 * owns the offer and the state it reports.
 */
export interface SelectAllMatching {
  /** Rows matching the current filters across every page. */
  total: number;
  /** True when every row on the current page is ticked. */
  pageFullySelected: boolean;
  /** True once the caller has escalated to the whole matching set. */
  active: boolean;
  /** Escalate to every matching row. */
  onSelectAll: () => void;
  /**
   * Completes "…that {matchDescription}." Defaults to "match the current
   * filters"; pass "match this search query" when a search term is what
   * narrowed the table.
   */
  matchDescription?: string;
  /**
   * Largest set the caller's action can actually express, for callers whose
   * action sends an ID LIST — the bulk endpoints take at most `MAX_BULK_IDS`
   * of them. Above it the offer is withheld rather than promising a batch that
   * would be refused.
   *
   * Omit it when the action can send the FILTER instead, as the connector
   * documents table does: there is no id list to outgrow, so a corpus of
   * 22,000 is as selectable as one of 5, and capping the offer would withhold
   * exactly the case the escalation exists for.
   */
  max?: number;
}

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
  /** Omit to keep the selection confined to the current page. */
  selectAllMatching?: SelectAllMatching;
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
  selectAllMatching,
  className,
  children,
}: BulkActionsBarProps) {
  const pluralize = (n: number) => (n === 1 ? noun : (plural ?? `${noun}s`));

  const allMatchingActive = selectAllMatching?.active ?? false;
  const text = allMatchingActive
    ? `All ${selectAllMatching?.total} ${pluralize(selectAllMatching?.total ?? 0)} selected`
    : (label ?? `${count} ${pluralize(count)} selected`);

  // Offered only once the page is exhausted and there is genuinely more behind
  // it — and only when the caller's action could carry the whole set.
  const offerSelectAll =
    selectAllMatching !== undefined &&
    !selectAllMatching.active &&
    selectAllMatching.pageFullySelected &&
    selectAllMatching.total > count &&
    (selectAllMatching.max === undefined ||
      selectAllMatching.total <= selectAllMatching.max);

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
            "rounded-md border bg-muted/40",
            // The offer is a second row, so the padding moves inside to let it
            // span the full width with its own separator.
            offerSelectAll ? "" : "px-3 py-2",
            className,
          )}
        >
          <div
            className={cn(
              "flex flex-wrap items-center gap-2",
              offerSelectAll && "px-3 py-2",
            )}
          >
            <span
              aria-hidden="true"
              data-testid={countTestId}
              className="text-sm font-medium"
            >
              {text}
            </span>
            {busy && <LoadingState variant="inline" />}
            {onClear && (
              <Button variant="ghost" size="sm" onClick={onClear}>
                <span>Clear</span>
              </Button>
            )}
            <div className="ml-auto flex flex-wrap items-center gap-2">
              {children}
            </div>
          </div>

          {offerSelectAll && selectAllMatching && (
            <div className="flex flex-wrap items-center gap-1 border-t px-3 py-2 text-sm">
              <span className="text-muted-foreground">
                {count} {pluralize(count)} on this page selected.
              </span>
              <Button
                variant="link"
                size="sm"
                className="h-auto p-0 text-sm"
                onClick={selectAllMatching.onSelectAll}
              >
                Select all {selectAllMatching.total}{" "}
                {pluralize(selectAllMatching.total)} that{" "}
                {selectAllMatching.matchDescription ??
                  "match the current filters"}
                .
              </Button>
            </div>
          )}
        </div>
      )}
    </>
  );
}
