"use client";

import { LayoutGrid, List, type LucideIcon, Search } from "lucide-react";
import {
  createContext,
  type MouseEvent,
  type MouseEventHandler,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { EmptyState } from "@/components/empty-state";
import { BulkActionsScope } from "@/components/ui/bulk-actions-context";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { TablePagination } from "@/components/ui/table-pagination";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { BulkRangeSelectionScope } from "@/lib/bulk-range-selection-context";
import { useIsMobile } from "@/lib/hooks/use-mobile";
import { cn } from "@/lib/utils";

export type TableCardViewMode = "cards" | "table";
export const COLLECTION_CARD_HOVER_CLASSNAME = "hover:bg-muted/50";

type TableCardViewContextValue = {
  mode: TableCardViewMode;
  selectMode: (mode: TableCardViewMode) => void;
};

const TableCardViewContext = createContext<TableCardViewContextValue | null>(
  null,
);

/**
 * Owns a collection page's table/card preference. The preference is persisted
 * per page; cards remain the only rendered collection layout below the `md`
 * breakpoint because they adapt to narrow screens without horizontal scroll.
 */
export function TableCardView({
  storageKey,
  defaultMode = "cards",
  children,
}: {
  storageKey: string;
  defaultMode?: TableCardViewMode;
  children: ReactNode;
}) {
  const [mode, setMode] = useState<TableCardViewMode>(defaultMode);

  useEffect(() => {
    const stored = window.localStorage.getItem(storageKey);
    if (stored === "cards" || stored === "table") setMode(stored);
  }, [storageKey]);

  const selectMode = useCallback(
    (value: TableCardViewMode) => {
      setMode(value);
      window.localStorage.setItem(storageKey, value);
    },
    [storageKey],
  );

  return (
    <TableCardViewContext.Provider value={{ mode, selectMode }}>
      <BulkActionsScope>
        <BulkRangeSelectionScope>{children}</BulkRangeSelectionScope>
      </BulkActionsScope>
    </TableCardViewContext.Provider>
  );
}

export function TableCardViewToggle({
  order = ["cards", "table"],
  className,
}: {
  /** The page's default view goes first. */
  order?: readonly [TableCardViewMode, TableCardViewMode];
  className?: string;
}) {
  const { mode: selectedMode, selectMode } = useTableCardView();

  return (
    <div
      className={cn(
        "hidden items-center gap-0.5 rounded-md border p-0.5 md:inline-flex",
        className,
      )}
    >
      {order.map((mode) => (
        <Tooltip key={mode}>
          <TooltipTrigger asChild>
            <Button
              variant={selectedMode === mode ? "secondary" : "ghost"}
              size="icon-sm"
              aria-label={VIEW_LABELS[mode]}
              aria-pressed={selectedMode === mode}
              className={cn(selectedMode !== mode && "text-muted-foreground")}
              onClick={() => selectMode(mode)}
            >
              {mode === "cards" ? (
                <LayoutGrid className="h-4 w-4" />
              ) : (
                <List className="h-4 w-4" />
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent>{VIEW_LABELS[mode]}</TooltipContent>
        </Tooltip>
      ))}
    </div>
  );
}

export function TableCardViewContent({
  table,
  cards,
  forceTable = false,
  keepMounted = false,
  onModeChange,
}: {
  table: ReactNode;
  cards: ReactNode;
  /** For dense lifecycle/history views that intentionally have no card form. */
  forceTable?: boolean;
  /** Keep both expensive layouts warm and switch them with CSS. */
  keepMounted?: boolean;
  /** Reports the effective layout, including the mobile cards override. */
  onModeChange?: (mode: TableCardViewMode) => void;
}) {
  // Nested list components can still render independently in tests and
  // stories; without a page-level provider they retain their table default.
  const mode = useContext(TableCardViewContext)?.mode ?? "table";
  const isMobile = useIsMobile();
  const effectiveMode = mode === "cards" || isMobile ? "cards" : "table";
  const warmTable = useRef(table);
  const warmCards = useRef(cards);
  if (effectiveMode === "table") warmTable.current = table;
  else warmCards.current = cards;

  useEffect(() => {
    onModeChange?.(effectiveMode);
  }, [effectiveMode, onModeChange]);

  if (forceTable) return table;
  if (keepMounted) {
    return (
      <>
        <div
          data-active={effectiveMode === "table"}
          className={effectiveMode === "table" ? "hidden md:block" : "hidden"}
        >
          {warmTable.current}
        </div>
        <div
          data-active={effectiveMode === "cards"}
          className={effectiveMode === "cards" ? undefined : "hidden"}
        >
          {warmCards.current}
        </div>
      </>
    );
  }
  if (effectiveMode === "cards") return cards;

  // Hidden until `useIsMobile` resolves, preventing a wide table from
  // flashing during hydration on a narrow screen.
  return <div className="hidden md:block">{table}</div>;
}

/** Keeps card-mode selection escalation scoped to the cards on screen. */
export function TableCardSelectionScope({
  rowIds,
  onVisibleRowIdsChange,
  children,
}: {
  rowIds: string[];
  onVisibleRowIdsChange: (ids: string[]) => void;
  children: ReactNode;
}) {
  useEffect(() => {
    onVisibleRowIdsChange(rowIds);
  }, [onVisibleRowIdsChange, rowIds]);

  return children;
}

/** Knowledge-Base-style responsive grid shared by collection pages. */
export function TableCardGrid({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "grid grid-cols-1 gap-4 lg:grid-cols-2 2xl:grid-cols-3",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function TableCardList({
  children,
  itemCount,
  isLoading = false,
  emptyMessage = "No results",
  emptyDescription,
  emptyIcon,
  hasActiveFilters = false,
  filteredEmptyMessage = "No results match your filters",
  filteredEmptyDescription = "Try adjusting your search or filters.",
  onClearFilters,
  pagination,
  onPaginationChange,
  gridClassName,
}: {
  children: ReactNode;
  itemCount: number;
  isLoading?: boolean;
  emptyMessage?: string;
  emptyDescription?: string;
  /** The page's own icon — pass the one its sidebar entry uses. */
  emptyIcon?: LucideIcon;
  hasActiveFilters?: boolean;
  filteredEmptyMessage?: string;
  filteredEmptyDescription?: string;
  onClearFilters?: () => void;
  pagination?: { pageIndex: number; pageSize: number; total: number };
  onPaginationChange?: (pagination: {
    pageIndex: number;
    pageSize: number;
  }) => void;
  gridClassName?: string;
}) {
  if (itemCount === 0) {
    // Same reasoning as the table view: while a fetch is still out this is an
    // area with nothing in it yet, not an empty result, so it holds its height
    // and says nothing rather than flashing an empty state before the cards
    // land.
    if (isLoading) {
      return <div className="min-h-[164px] py-12" />;
    }
    return (
      <EmptyState
        icon={emptyIcon ?? (hasActiveFilters ? Search : undefined)}
        title={hasActiveFilters ? filteredEmptyMessage : emptyMessage}
        description={
          hasActiveFilters ? filteredEmptyDescription : emptyDescription
        }
        onClearFilters={hasActiveFilters ? onClearFilters : undefined}
      />
    );
  }

  return (
    <div className="space-y-4">
      <TableCardGrid className={gridClassName}>{children}</TableCardGrid>
      {pagination && onPaginationChange ? (
        <TablePagination
          {...pagination}
          onPaginationChange={onPaginationChange}
        />
      ) : null}
    </div>
  );
}

/**
 * Shared Knowledge-Base-style card shell for pages that previously exposed
 * only table rows. Rich page-specific content stays in `children` and
 * `footer`; selection and the outer surface remain consistent.
 */
export function TableCard({
  title,
  description,
  icon,
  actions,
  selected,
  selectionDisabled,
  selectionDisabledTooltip,
  onSelectedChange,
  onSelectionClick,
  selectionLabel,
  children,
  footer,
  className,
  onNavigate,
  testId,
  density = "default",
}: {
  title: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  actions?: ReactNode;
  selected?: boolean;
  selectionDisabled?: boolean;
  selectionDisabledTooltip?: ReactNode;
  onSelectedChange?: (selected: boolean) => void;
  onSelectionClick?: MouseEventHandler<HTMLButtonElement>;
  selectionLabel?: string;
  children?: ReactNode;
  footer?: ReactNode;
  className?: string;
  onNavigate?: () => void;
  testId?: string;
  density?: "default" | "compact";
}) {
  const selectable =
    onSelectedChange !== undefined || onSelectionClick !== undefined;
  const navigation = useNavigableCard({ onNavigate, selected });
  const compact = density === "compact";
  const selectionControl = selectable ? (
    <Checkbox
      className="mt-1"
      checked={selected}
      disabled={selectionDisabled}
      onCheckedChange={
        onSelectedChange ? (value) => onSelectedChange(!!value) : undefined
      }
      onClick={(event) => {
        event.stopPropagation();
        onSelectionClick?.(event);
      }}
      aria-label={selectionLabel}
    />
  ) : null;
  const renderedSelectionControl =
    selectionDisabled && selectionDisabledTooltip && selectionControl ? (
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex cursor-not-allowed">
            {selectionControl}
          </span>
        </TooltipTrigger>
        <TooltipContent>{selectionDisabledTooltip}</TooltipContent>
      </Tooltip>
    ) : (
      selectionControl
    );

  return (
    <div
      {...navigation.props}
      data-testid={testId}
      className={cn(
        "flex h-full min-w-80 flex-col rounded-lg border p-4 transition-colors",
        compact ? "gap-2" : "gap-3",
        selected
          ? cn("border-primary bg-primary/5", navigation.className)
          : onNavigate
            ? navigation.className
            : COLLECTION_CARD_HOVER_CLASSNAME,
        className,
      )}
    >
      <div className="flex items-start gap-3">
        {renderedSelectionControl}
        {icon ? (
          <span className="mt-0.5 shrink-0 text-muted-foreground">{icon}</span>
        ) : null}
        <div className="min-w-0 flex-1">
          <h3 className="truncate font-medium">{title}</h3>
          {description ? (
            <div className="mt-1 line-clamp-2 text-xs text-muted-foreground">
              {description}
            </div>
          ) : null}
        </div>
        {actions}
      </div>
      {children ? <div className="text-sm">{children}</div> : null}
      {footer ? (
        <div
          className={cn(
            "mt-auto border-t text-xs text-muted-foreground",
            compact ? "pt-2 [&_button]:h-7 [&_button]:text-xs" : "pt-3",
          )}
        >
          {footer}
        </div>
      ) : null}
    </div>
  );
}

export function useNavigableCard({
  onNavigate,
  selected,
}: {
  onNavigate?: () => void;
  selected?: boolean;
}) {
  const navigateFromPointer = (event: MouseEvent<HTMLElement>) => {
    if (
      !onNavigate ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey ||
      isCardInteractiveTarget(event.target, event.currentTarget)
    ) {
      return;
    }
    onNavigate();
  };
  return {
    className: onNavigate
      ? cn(
          "cursor-pointer",
          selected ? "hover:bg-primary/10" : COLLECTION_CARD_HOVER_CLASSNAME,
        )
      : undefined,
    props: onNavigate
      ? {
          onClick: navigateFromPointer,
        }
      : {},
  };
}

const VIEW_LABELS: Record<TableCardViewMode, string> = {
  cards: "View as cards",
  table: "View as table",
};

// === Internal helpers ===

function useTableCardView(): TableCardViewContextValue {
  const context = useContext(TableCardViewContext);
  if (!context) {
    throw new Error("TableCardView components must be inside TableCardView");
  }
  return context;
}

const CARD_INTERACTIVE_SELECTOR =
  'a, button, input, select, textarea, summary, [contenteditable="true"], [role="button"], [role="checkbox"], [role="link"], [role="menuitem"], [data-card-interactive]';

function isCardInteractiveTarget(
  target: EventTarget,
  currentTarget: EventTarget,
): boolean {
  if (!(target instanceof Element)) return false;
  const interactiveTarget = target.closest(CARD_INTERACTIVE_SELECTOR);
  return interactiveTarget !== null && interactiveTarget !== currentTarget;
}
