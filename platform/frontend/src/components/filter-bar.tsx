"use client";

import { ChevronDown, SlidersHorizontal, X } from "lucide-react";
import { type ComponentProps, Fragment, type ReactNode } from "react";
import {
  ContextualActionsPortal,
  useBulkActionsScope,
} from "@/components/ui/bulk-actions-context";
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
 * Owns the 12px gap between a collection's filters and the table or cards
 * below. Agents and Skills are the reference: wrap the {@link FilterBar} plus
 * any badges, chips, or hints, then render the collection as the next sibling.
 *
 * `[&+*]:!mt-0` cancels a parent `space-y-*` margin on the collection so the
 * gap stays 12px even when the page still uses a vertical stack. Bordered
 * tables read as 13px because of the table's top border.
 */
export function CollectionFilters({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      data-slot="collection-filters"
      className={cn("mb-3 flex flex-col gap-2 [&+*]:!mt-0", className)}
    >
      {children}
    </div>
  );
}

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
 * @param contextualActions - Selection actions rendered in the same grid cell
 * as the filters. Presenting them swaps the bar in place instead of reserving
 * an empty slot or moving the collection once rows are ticked.
 * @param contextualActionsClassName - Classes for the selection action rail.
 * @param contextualActionsTargetId - A stable target for selection controls
 * owned by the collection below. Use this when lifting selection into the page
 * would make each checkbox rerender expensive queries and filters.
 * @param leading - Pulls the first control strip below a page header into the
 * surrounding vertical rhythm. Nested bars leave this disabled.
 *
 * The bar carries no outer margin. Wrap it — and any badges or chips that
 * belong with the filters — in {@link CollectionFilters}, which owns the 12px
 * gap to the table or cards. Putting `mb-*` on the bar itself fights parent
 * `space-y-*` stacks (those space via margin-top on the next sibling) and is
 * how collection pages ended up with collapsed or doubled gaps.
 */
export function FilterBar({
  children,
  className,
  contextualActions,
  contextualActionsClassName,
  contextualActionsTargetId,
  onClearFilters,
  moreFilters,
  actions,
  leading = false,
}: {
  children?: ReactNode;
  className?: string;
  contextualActions?: ReactNode;
  contextualActionsClassName?: string;
  contextualActionsTargetId?: string;
  onClearFilters?: () => void;
  moreFilters?: OverflowFilter[];
  actions?: ReactNode;
  leading?: boolean;
}) {
  const bulkActionsScope = useBulkActionsScope();
  const actionsTargetId =
    contextualActionsTargetId ?? bulkActionsScope?.targetId;
  const appliedOverflow = moreFilters?.filter((filter) => filter.active) ?? [];
  const tuckedAway = moreFilters?.filter((filter) => !filter.active) ?? [];

  return (
    <div
      className={cn(
        "grid",
        actionsTargetId && "min-h-[42px]",
        leading && "-mt-2",
      )}
    >
      <div
        data-slot="filter-controls"
        inert={contextualActions ? true : undefined}
        className={cn(
          "col-start-1 row-start-1 flex min-w-0 flex-wrap items-center gap-1.5 self-center transition-opacity duration-150 ease-out",
          // Search boxes are the one control whose height isn't set by
          // `filterControlClass` (callers render an <Input>, not a trigger
          // button), so the bar pulls them down to the compact height itself
          // rather than making every call site repeat `inputClassName="h-8"`.
          "[&_[data-slot=input]]:h-8",
          contextualActions && "pointer-events-none opacity-0",
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
          <div className="flex basis-full items-center justify-start gap-1.5 md:ml-auto md:basis-auto">
            {actions}
          </div>
        )}
      </div>
      {contextualActions ? (
        <div
          className={cn(
            "col-start-1 row-start-1 flex min-w-0 items-center transition-opacity duration-150 ease-out",
            contextualActionsClassName,
          )}
        >
          {contextualActions}
        </div>
      ) : null}
      {actionsTargetId ? (
        <div
          id={actionsTargetId}
          data-slot="contextual-actions"
          className={cn(
            "pointer-events-none col-start-1 row-start-1 flex min-w-0 items-center self-center opacity-0 transition-opacity duration-150 ease-out",
            contextualActionsClassName,
          )}
        />
      ) : null}
    </div>
  );
}

/**
 * Projects collection-owned controls into a FilterBar without lifting their
 * fast-changing state into the page that computes the collection.
 */
export function FilterBarContextualActions({
  targetId,
  active,
  children,
}: {
  targetId: string;
  active: boolean;
  children: ReactNode;
}) {
  return (
    <ContextualActionsPortal targetId={targetId} active={active}>
      {children}
    </ContextualActionsPortal>
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
  "relative w-full min-w-[12rem] basis-full md:w-auto md:max-w-[20rem] md:basis-auto md:flex-1";

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
