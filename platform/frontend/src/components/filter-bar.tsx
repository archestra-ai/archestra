"use client";

import { ChevronDown, SlidersHorizontal, X } from "lucide-react";
import { type ComponentProps, Fragment, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { DEFAULT_FILTER_ALL } from "@/consts";
import { cn } from "@/lib/utils";

/**
 * A filter a page is willing to tuck away behind "More filters" while nobody is
 * using it. See {@link FilterBar}'s `moreFilters`.
 */
export type OverflowFilter = {
  /** Stable identity for the entry. */
  key: string;
  /** Names the control inside the "More filters" popover. */
  label: string;
  /**
   * Whether the filter currently holds a value — derive it from the same state
   * `control` is bound to, so the two cannot disagree. The bar can't read this
   * off `control` itself: it is an opaque node, and these entries are not all
   * {@link FilterSelect}s. Getting it wrong is not cosmetic — a filter that
   * reports `false` while actually filtering stays hidden behind the popover.
   */
  active: boolean;
  control: ReactNode;
};

/**
 * One compact row of table filters: search, then the filter controls, then any
 * trailing view/sort actions. Every filtered list page uses this so the bars
 * read the same everywhere.
 *
 * The controls are deliberately sized to their content rather than to a fixed
 * width. Fixed-width triggers were what pushed these bars onto a second line
 * and truncated their labels ("All Agents & LLM Pr…") while leaving dead space
 * inside the shorter ones.
 *
 * @param onClearFilters - When provided, a "Clear" button is appended after the
 * filters. Pass it only while some filter is actually applied; the button is
 * the bar's only affordance for resetting them all at once.
 * @param moreFilters - Secondary filters, for pages with more of them than fit
 * a row. An entry is shown inline while it is `active` and tucked into a "More
 * filters" popover while it is not, so the bar always states every filter
 * currently narrowing the table — a hidden active filter reads as an empty
 * table with no explanation.
 * @param actions - Trailing controls (sort, view toggle) pinned to the right.
 * @param leading - Set when the bar is the first thing under the page header.
 * `PageLayout` insets its content 24px below the header rule, which is right
 * for content but wrong for a control strip: the bar ended up sitting further
 * from the header it belongs to than from the table it filters, which reads as
 * a misalignment rather than as rhythm. This pulls it back onto the 16px the
 * surrounding `space-y-4` stack already uses below it, so the bar is evenly
 * spaced on both sides. Bars nested inside a tab body or a card are already
 * spaced by their own container and must leave this alone.
 *
 * The bar carries no outer margin: the surrounding stack owns the gap between
 * it and the table. It used to default to `mb-4`, which made "let my parent
 * space this" and "have no spacing at all" the same string — callers wrote
 * `className="mb-0"` meaning the former and silently got the latter, because
 * tailwind's `space-y-*` spaces a stack via margin-bottom on every child but
 * the last, which `mb-0` then cancelled. Six pages had a collapsed gap this
 * way. Pass an explicit margin here only when there is no stack to own it.
 */
export function FilterBar({
  children,
  className,
  onClearFilters,
  moreFilters,
  actions,
  leading = false,
}: {
  children: ReactNode;
  className?: string;
  onClearFilters?: () => void;
  moreFilters?: OverflowFilter[];
  actions?: ReactNode;
  leading?: boolean;
}) {
  const appliedOverflow = moreFilters?.filter((filter) => filter.active) ?? [];
  const tuckedAway = moreFilters?.filter((filter) => !filter.active) ?? [];

  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-1.5",
        // Search boxes are the one control whose height isn't set by
        // `filterControlClass` (callers render an <Input>, not a trigger
        // button), so the bar pulls them down to the compact height itself
        // rather than making every call site repeat `inputClassName="h-8"`.
        "[&_[data-slot=input]]:h-8",
        leading && "-mt-2",
        className,
      )}
    >
      {children}
      {appliedOverflow.map((filter) => (
        // Fragment rather than a wrapper element: the control has to be the
        // bar's own flex item for its sizing to behave like the inline ones'.
        <Fragment key={filter.key}>{filter.control}</Fragment>
      ))}
      {tuckedAway.length > 0 && (
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="outline" className={filterControlClass()}>
              <SlidersHorizontal aria-hidden className="h-3.5 w-3.5" />
              <span>More filters</span>
              <ChevronDown
                aria-hidden
                className="h-4 w-4 text-muted-foreground"
              />
            </Button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-72 space-y-3">
            {tuckedAway.map((filter) => (
              <div
                key={filter.key}
                // The control is the same compact trigger used in the bar,
                // stretched to the popover width so this reads as a small form
                // rather than a second filter bar. Scoped to the row's direct
                // child so a control that renders buttons of its own inside
                // itself keeps their widths, and matched by element rather than
                // by `[data-slot=button]`: a trigger reaches its <button>
                // through a Radix `asChild` wrapper, which overwrites Button's
                // `data-slot` with its own (`popover-trigger`/`select-trigger`).
                className="space-y-1.5 [&>button]:w-full [&>button]:max-w-none"
              >
                <span className="block text-xs font-medium">
                  {filter.label}
                </span>
                {filter.control}
              </div>
            ))}
          </PopoverContent>
        </Popover>
      )}
      {onClearFilters && (
        <Button
          variant="ghost"
          size="sm"
          onClick={onClearFilters}
          className="h-8 gap-1.5 px-2"
        >
          <X className="h-3.5 w-3.5" />
          <span>Clear</span>
        </Button>
      )}
      {actions && (
        <div className="ml-auto flex items-center gap-1.5">{actions}</div>
      )}
    </div>
  );
}

/**
 * Trigger styling shared by every control in a {@link FilterBar} — the compact
 * height and content width, plus the accent an applied filter carries.
 *
 * Use it directly for controls that aren't a {@link FilterSelect} (a shadcn
 * `Select`, an `AgentSelector`, a bespoke popover); `FilterSelect` applies it
 * for you.
 *
 * `active` styling stays on the border and background: the label itself keeps
 * the foreground colour rather than dimming to `muted-foreground` when idle,
 * which dips under the 4.5:1 contrast minimum on some themes (WCAG 1.4.3).
 */
export function filterControlClass({
  active = false,
  className,
}: {
  active?: boolean;
  className?: string;
} = {}) {
  return cn(
    // `min-h-8` matters as much as `h-8`: AgentSelector's trigger sets
    // `h-auto min-h-9` for its two-line rows, and a bare `h-8` would lose to it.
    "h-8 min-h-8 w-auto min-w-0 max-w-[15rem] gap-1.5 px-2.5 text-sm font-normal",
    active && "border-primary/50 bg-primary/10 font-medium",
    className,
  );
}

/**
 * Sizing for a {@link FilterBar}'s search box: it takes the leftover width.
 *
 * Carries `relative` because callers apply it either to `SearchInput` itself or
 * to a wrapper around it — and `SearchInput` positions its magnifier, and the
 * LLM logs page its "not a session ID" hint, against that positioned ancestor.
 */
export const filterSearchClass =
  "relative w-full min-w-[12rem] flex-1 sm:w-auto sm:max-w-[20rem]";

/**
 * A {@link SearchableSelect} dressed as a filter-bar control: compact, sized to
 * its label, and accented once it holds something other than `inactiveValue`.
 *
 * The dropdown gets its own width because the trigger no longer has one to lend
 * it — a content-sized "Status" trigger would otherwise open an 80px list.
 */
export function FilterSelect({
  inactiveValue = DEFAULT_FILTER_ALL,
  className,
  contentClassName,
  ...props
}: ComponentProps<typeof SearchableSelect> & { inactiveValue?: string }) {
  return (
    <SearchableSelect
      {...props}
      // The trigger's `role="combobox"` takes its name from the author, so the
      // control is anonymous to a screen reader without one. Filter placeholders
      // already read as names ("Filter by action"), so they stand in unless the
      // caller supplies something better. Set after the spread: spreading an
      // absent `ariaLabel` would otherwise overwrite this with undefined.
      ariaLabel={props.ariaLabel ?? props.placeholder}
      className={filterControlClass({
        active: props.value !== inactiveValue,
        className,
      })}
      contentClassName={cn(
        "w-auto min-w-[14rem] max-w-[min(22rem,calc(100vw-2rem))]",
        contentClassName,
      )}
    />
  );
}
