"use client";

import { Inbox, LayoutGrid, List, Search } from "lucide-react";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";
import { LoadingState } from "@/components/loading";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { TablePagination } from "@/components/ui/table-pagination";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useIsMobile } from "@/lib/hooks/use-mobile";
import { cn } from "@/lib/utils";

export type TableCardViewMode = "cards" | "table";

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
      {children}
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
}: {
  table: ReactNode;
  cards: ReactNode;
  /** For dense lifecycle/history views that intentionally have no card form. */
  forceTable?: boolean;
}) {
  // Nested list components can still render independently in tests and
  // stories; without a page-level provider they retain their table default.
  const mode = useContext(TableCardViewContext)?.mode ?? "table";
  const isMobile = useIsMobile();

  if (forceTable) return table;
  if (mode === "cards" || isMobile) return cards;

  // Hidden until `useIsMobile` resolves, preventing a wide table from
  // flashing during hydration on a narrow screen.
  return <div className="hidden md:block">{table}</div>;
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
  emptyIcon,
  hasActiveFilters = false,
  filteredEmptyMessage = "No results match your filters. Try adjusting your search.",
  onClearFilters,
  pagination,
  onPaginationChange,
  gridClassName,
}: {
  children: ReactNode;
  itemCount: number;
  isLoading?: boolean;
  emptyMessage?: string;
  emptyIcon?: ReactNode;
  hasActiveFilters?: boolean;
  filteredEmptyMessage?: string;
  onClearFilters?: () => void;
  pagination?: { pageIndex: number; pageSize: number; total: number };
  onPaginationChange?: (pagination: {
    pageIndex: number;
    pageSize: number;
  }) => void;
  gridClassName?: string;
}) {
  if (isLoading && itemCount === 0) {
    return <LoadingState label="Loading results…" variant="page" />;
  }

  if (itemCount === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center">
        <div className="mb-3 text-muted-foreground">
          {hasActiveFilters ? (
            <Search className="h-10 w-10" />
          ) : (
            (emptyIcon ?? <Inbox className="h-10 w-10" />)
          )}
        </div>
        <p className="text-sm text-muted-foreground">
          {hasActiveFilters ? filteredEmptyMessage : emptyMessage}
        </p>
        {hasActiveFilters && onClearFilters ? (
          <Button
            variant="outline"
            size="sm"
            className="mt-4"
            onClick={onClearFilters}
          >
            <span>Clear filters</span>
          </Button>
        ) : null}
      </div>
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
  onSelectedChange,
  selectionLabel,
  children,
  footer,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  actions?: ReactNode;
  selected?: boolean;
  onSelectedChange?: (selected: boolean) => void;
  selectionLabel?: string;
  children?: ReactNode;
  footer?: ReactNode;
  className?: string;
}) {
  const selectable = onSelectedChange !== undefined;

  return (
    <div
      className={cn(
        "flex h-full flex-col gap-3 rounded-lg border p-4 transition-colors",
        selected ? "border-primary bg-primary/5" : "hover:bg-muted/30",
        className,
      )}
    >
      <div className="flex items-start gap-3">
        {selectable ? (
          <Checkbox
            className="mt-1"
            checked={selected}
            onCheckedChange={(value) => onSelectedChange(!!value)}
            aria-label={selectionLabel}
          />
        ) : null}
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
        <div className="mt-auto border-t pt-3 text-xs text-muted-foreground">
          {footer}
        </div>
      ) : null}
    </div>
  );
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
