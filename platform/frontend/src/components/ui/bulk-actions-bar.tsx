"use client";

import { MAX_BULK_IDS } from "@archestra/shared";
import type { ReactNode } from "react";
import { LoadingState } from "@/components/loading";
import {
  ContextualActionsPortal,
  useBulkActionsScope,
} from "@/components/ui/bulk-actions-context";
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

export interface BulkActionsBarProps {
  /**
   * How many rows are ticked. The visible bar is hidden entirely at 0.
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
  /** Additional classes for the action rail. */
  className?: string;
  /**
   * Keeps a compact, invisible bar mounted at zero selection so showing the
   * controls does not displace the collection beneath them.
   */
  reserveSpace?: boolean;
  /** Keep controls mounted while a separate toolbar hides this rail. */
  keepMounted?: boolean;
  /** Use the compact 42px visual treatment without implying layout reservation. */
  compact?: boolean;
  /** The actions themselves, laid out at the end of the bar. */
  children?: ReactNode;
}

/**
 * Default collection bulk actions. Unlike the low-level bar, this keeps the
 * compact action box in normal flow at zero selection so table and card
 * layouts never move when the controls appear. The slot also owns its 12px
 * spacing before the collection immediately after it.
 */
export function BulkActions({
  selectAllMatching,
  maxSelection = MAX_BULK_IDS,
  busy,
  children,
  reserveSpace = true,
  keepMounted,
  compact,
  ...props
}: Omit<BulkActionsBarProps, "reserveSpace"> & {
  /** `null` only for actions that send a filter instead of an ID list. */
  maxSelection?: number | null;
  /**
   * Disable only when the caller already owns the space — for example the
   * selection actions replace an existing filter toolbar in place.
   */
  reserveSpace?: boolean;
}) {
  const bulkActionsScope = useBulkActionsScope();
  const cappedSelectAll =
    selectAllMatching &&
    selectAllMatching.max === undefined &&
    maxSelection !== null
      ? { ...selectAllMatching, max: maxSelection }
      : selectAllMatching;
  const actionCount = cappedSelectAll?.active
    ? cappedSelectAll.total
    : props.count;
  const overLimit = maxSelection !== null && actionCount > maxSelection;

  const bar = (
    <BulkActionsBar
      {...props}
      busy={busy}
      selectAllMatching={cappedSelectAll}
      reserveSpace={bulkActionsScope ? false : reserveSpace}
      keepMounted={bulkActionsScope ? true : keepMounted}
      compact={bulkActionsScope ? true : compact}
    >
      {overLimit ? (
        <span className="text-sm text-destructive">
          Select at most {maxSelection} items at a time.
        </span>
      ) : null}
      <fieldset disabled={overLimit || busy} className="contents">
        {props.count > 0 ? children : null}
      </fieldset>
    </BulkActionsBar>
  );

  return bulkActionsScope ? (
    <ContextualActionsPortal
      targetId={bulkActionsScope.targetId}
      active={props.count > 0}
    >
      {bar}
    </ContextualActionsPortal>
  ) : (
    bar
  );
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
  reserveSpace,
  keepMounted,
  compact: compactProp,
  children,
}: BulkActionsBarProps) {
  const compact = compactProp ?? reserveSpace;
  const pluralize = (n: number) => (n === 1 ? noun : (plural ?? `${noun}s`));

  const allMatchingActive = selectAllMatching?.active ?? false;
  const text = allMatchingActive
    ? `All ${selectAllMatching?.total} ${pluralize(selectAllMatching?.total ?? 0)} selected`
    : (label ?? `${count} ${pluralize(count)} selected`);

  // Offered only once the page is exhausted and there is genuinely more behind
  // it — and only when the caller's action could carry the whole set.
  const offerSelectAll =
    selectAllMatching !== undefined &&
    !busy &&
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

      {count === 0 && reserveSpace ? (
        <div
          aria-hidden="true"
          data-slot="bulk-actions-bar"
          className={cn("h-[42px] !mt-0 !mb-3 [&+*]:!mt-0", className)}
        />
      ) : count > 0 || keepMounted ? (
        <div
          aria-hidden={count === 0 ? true : undefined}
          data-slot="bulk-actions-bar"
          className={cn(
            "w-full rounded-md border bg-muted/40 px-3 py-2",
            compact && "h-[42px] px-2 py-1",
            reserveSpace && "!mt-0 !mb-3 [&+*]:!mt-0",
            className,
          )}
        >
          <div
            className={cn(
              "flex flex-wrap items-center gap-2",
              compact && "flex-nowrap gap-1.5 overflow-x-auto",
            )}
          >
            <span
              aria-hidden="true"
              data-testid={countTestId}
              className="shrink-0 text-sm font-medium"
            >
              {text}
            </span>
            {busy && <LoadingState variant="inline" />}
            {onClear && (
              <Button variant="ghost" size="sm" onClick={onClear}>
                <span>Clear</span>
              </Button>
            )}
            {offerSelectAll && selectAllMatching ? (
              <div className="flex min-w-0 shrink-0 items-center gap-1 text-sm">
                <span className="hidden text-muted-foreground xl:inline">
                  {count} {pluralize(count)} on this page selected.
                </span>
                <Button
                  variant="link"
                  size="sm"
                  className="h-auto min-w-0 p-0 text-sm"
                  disabled={busy}
                  onClick={selectAllMatching.onSelectAll}
                >
                  Select all {selectAllMatching.total}{" "}
                  {pluralize(selectAllMatching.total)} that{" "}
                  {selectAllMatching.matchDescription ??
                    "match the current filters"}
                  .
                </Button>
              </div>
            ) : null}
            <div
              className={cn(
                "ml-auto flex flex-wrap items-center gap-2",
                compact && "shrink-0 flex-nowrap gap-1.5",
              )}
            >
              {children}
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
