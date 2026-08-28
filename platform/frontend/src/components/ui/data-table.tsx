"use client";

import {
  type ColumnDef,
  type ExpandedState,
  flexRender,
  getCoreRowModel,
  getExpandedRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  type Row,
  type RowSelectionState,
  type SortingState,
  useReactTable,
  type VisibilityState,
} from "@tanstack/react-table";
import { type LucideIcon, Search } from "lucide-react";
import React, { useState } from "react";

import { EmptyState } from "@/components/empty-state";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { BulkRangeSelectionController } from "@/lib/bulk-range-selection";
import {
  registerTableRangeSelection,
  useBulkRangeSelectionController,
} from "@/lib/bulk-range-selection-context";
import { cn } from "@/lib/utils";
import { DATA_TABLE_SELECT_COLUMN_SIZE } from "./data-table.constants";
import { DataTablePagination } from "./data-table-pagination";

const COMPACT_ICON_COLUMN_IDS = new Set(["icon", "avatar", "select"]);
const ACTIONS_COLUMN_ID = "actions";
const SELECT_COLUMN_ID = "select";

interface DataTableProps<TData, TValue> {
  columns: ColumnDef<TData, TValue>[];
  data: TData[];
  pagination?: {
    pageIndex: number;
    pageSize: number;
    total: number;
  };
  onPaginationChange?: (pagination: {
    pageIndex: number;
    pageSize: number;
  }) => void;
  manualPagination?: boolean;
  onSortingChange?: (sorting: SortingState) => void;
  manualSorting?: boolean;
  sorting?: SortingState;
  onRowClick?: (row: TData, event: React.MouseEvent) => void;
  rowSelection?: RowSelectionState;
  onRowSelectionChange?: (rowSelection: RowSelectionState) => void;
  /** Shared with card mode so Shift ranges keep one anchor across layouts. */
  rangeSelection?: BulkRangeSelectionController;
  /**
   * The ids of the rows currently on screen, whenever they change.
   *
   * A bulk bar sits outside the table, so it cannot otherwise tell when the
   * visible page is fully ticked — which is what gates its "select everything
   * that matches" offer. Pass a stable callback (`useCallback`); an inline one
   * re-subscribes every render.
   */
  onPageRowIdsChange?: (ids: string[]) => void;
  /** Hide the "X of Y row(s) selected" text. Defaults to true when rowSelection is not provided. */
  hideSelectedCount?: boolean;
  /** Function to get a stable unique ID for each row. When provided, row selection will use these IDs instead of indices. */
  getRowId?: (row: TData, index: number) => string;
  /** Render a sub-component below a row when it is expanded. */
  renderSubComponent?: (props: { row: Row<TData> }) => React.ReactNode;
  /** Return an optional class name for each rendered row. */
  getRowClassName?: (row: TData) => string | undefined;
  /** Show a loading spinner instead of "No results" when data is being fetched */
  isLoading?: boolean;
  /** Headline for the empty state (defaults to "No results") */
  emptyMessage?: string;
  /** Muted line under `emptyMessage`. */
  emptyDescription?: string;
  /** Call to action shown only for the unfiltered empty state. */
  emptyAction?: React.ReactNode;
  /**
   * The page's own icon — pass the one its sidebar entry uses, so the panel
   * reads as part of the page. Defaults to a magnifying glass while filters
   * are applied and a neutral tray otherwise.
   */
  emptyIcon?: LucideIcon;
  /** Whether filters/search are currently active */
  hasActiveFilters?: boolean;
  /** Headline when filters/search produce no results */
  filteredEmptyMessage?: string;
  /** Muted line under `filteredEmptyMessage`. */
  filteredEmptyDescription?: string;
  /** Called when the user clears active filters from the empty state */
  onClearFilters?: () => void;
  /** Hide pagination controls when all rows fit on a single page. */
  hidePaginationWhenSinglePage?: boolean;
  /** Hide the table header row. */
  hideHeader?: boolean;
  /** Hide the rows-per-page selector and page counter in the pagination bar. */
  compactPagination?: boolean;
  /**
   * Class applied to the inner `<table>` — e.g. a `min-w-[...]` so a table
   * whose cell contents cannot shrink (badges, toggle groups) scrolls
   * horizontally on narrow screens instead of squishing its columns until
   * the contents overlap.
   */
  tableClassName?: string;
  /** Column ids whose configured sizes must remain fixed pixels. */
  fixedWidthColumnIds?: string[];
  /** Column ids that absorb remaining table width. */
  flexibleColumnIds?: string[];
}

export function DataTable<TData, TValue>({
  columns,
  data,
  pagination,
  onPaginationChange,
  manualPagination = false,
  onSortingChange,
  manualSorting = false,
  sorting: controlledSorting,
  onRowClick,
  rowSelection,
  onRowSelectionChange,
  rangeSelection: controlledRangeSelection,
  onPageRowIdsChange,
  hideSelectedCount,
  getRowId,
  renderSubComponent,
  getRowClassName,
  isLoading = false,
  emptyMessage = "No results",
  emptyDescription,
  emptyAction,
  emptyIcon,
  hasActiveFilters = false,
  filteredEmptyMessage = "No results match your filters",
  filteredEmptyDescription = "Try adjusting your search or filters.",
  onClearFilters,
  hidePaginationWhenSinglePage = false,
  hideHeader = false,
  compactPagination = false,
  tableClassName,
  fixedWidthColumnIds = [],
  flexibleColumnIds = [],
}: DataTableProps<TData, TValue>) {
  const localRangeSelection = useBulkRangeSelectionController();
  const rangeSelection = controlledRangeSelection ?? localRangeSelection;
  const [internalSorting, setInternalSorting] = useState<SortingState>([]);
  const [expanded, setExpanded] = useState<ExpandedState>({});
  const [internalPagination, setInternalPagination] = useState({
    pageIndex: 0,
    pageSize: 10,
  });
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>({});

  // Use controlled sorting if provided, otherwise use internal state
  const sorting = controlledSorting ?? internalSorting;

  const table = useReactTable({
    data,
    columns,
    getRowId,
    onSortingChange: (updater) => {
      const newSorting =
        typeof updater === "function" ? updater(sorting) : updater;

      if (onSortingChange) {
        onSortingChange(newSorting);
      } else {
        setInternalSorting(newSorting);
      }
    },
    onRowSelectionChange: (updater) => {
      if (!onRowSelectionChange) return;

      const currentSelection = table.getState().rowSelection || {};
      const newSelection =
        typeof updater === "function" ? updater(currentSelection) : updater;

      onRowSelectionChange(newSelection);
    },
    getCoreRowModel: getCoreRowModel(),
    // Only use client-side pagination when not using manual pagination
    ...(manualPagination
      ? {}
      : { getPaginationRowModel: getPaginationRowModel() }),
    // Only use client-side sorting when not using manual sorting
    ...(manualSorting ? {} : { getSortedRowModel: getSortedRowModel() }),
    getFilteredRowModel: getFilteredRowModel(),
    ...(renderSubComponent
      ? {
          getExpandedRowModel: getExpandedRowModel(),
          onExpandedChange: setExpanded,
        }
      : {}),
    onColumnVisibilityChange: setColumnVisibility,
    manualPagination,
    manualSorting,
    autoResetPageIndex: false,
    pageCount: pagination
      ? Math.ceil(pagination.total / pagination.pageSize)
      : undefined,
    state: {
      sorting,
      columnVisibility,
      rowSelection: rowSelection || {},
      ...(renderSubComponent ? { expanded } : {}),
      pagination: pagination
        ? {
            pageIndex: pagination.pageIndex,
            pageSize: pagination.pageSize,
          }
        : internalPagination,
    },
    onPaginationChange: (updater) => {
      const currentPagination = table.getState().pagination;
      const newPagination =
        typeof updater === "function" ? updater(currentPagination) : updater;

      // Auto-reset to first page when page size changes
      if (newPagination.pageSize !== currentPagination.pageSize) {
        newPagination.pageIndex = 0;
      }

      if (onPaginationChange) {
        onPaginationChange(newPagination);
      } else {
        setInternalPagination(newPagination);
      }
    },
  });
  registerTableRangeSelection({ table, controller: rangeSelection });

  // With autoResetPageIndex disabled, a shrinking row count (e.g. a filter
  // applied while on a later page) strands the table on a nonexistent page.
  // Clamp to the last valid page; setPageIndex routes through
  // onPaginationChange, covering both controlled and internal pagination.
  // Joined rather than the array itself: a new array identity every render
  // would re-fire the effect forever.
  const pageRowIdsKey = table
    .getRowModel()
    .rows.map((row) => row.id)
    .join(",");
  React.useEffect(() => {
    onPageRowIdsChange?.(pageRowIdsKey ? pageRowIdsKey.split(",") : []);
  }, [pageRowIdsKey, onPageRowIdsChange]);

  const pageCount = table.getPageCount();
  const pageIndex = table.getState().pagination.pageIndex;
  React.useEffect(() => {
    // pageCount is -1 when manual pagination has no known page count
    if (isLoading || pageCount < 0) return;
    const maxPageIndex = Math.max(pageCount - 1, 0);
    if (pageIndex > maxPageIndex) {
      table.setPageIndex(maxPageIndex);
    }
  }, [isLoading, pageCount, pageIndex, table]);

  const visibleColumns = table.getVisibleLeafColumns();
  const selectColumn = visibleColumns.find(
    (column) => column.id === SELECT_COLUMN_ID,
  );
  const configuredTableSize =
    table.getTotalSize() +
    (selectColumn ? DATA_TABLE_SELECT_COLUMN_SIZE - selectColumn.getSize() : 0);
  const fixedColumnsSize = visibleColumns
    .filter(
      (column) =>
        column.id === SELECT_COLUMN_ID ||
        column.id === ACTIONS_COLUMN_ID ||
        fixedWidthColumnIds.includes(column.id),
    )
    .reduce(
      (total, column) =>
        total +
        (column.id === SELECT_COLUMN_ID
          ? DATA_TABLE_SELECT_COLUMN_SIZE
          : column.getSize()),
      0,
    );
  const flexibleColumnsSize = Math.max(
    configuredTableSize - fixedColumnsSize,
    1,
  );

  return (
    <div className="w-full space-y-4">
      {/* The bar is a sibling of the scrolling container, not a child: an
          absolutely positioned child of an `overflow-x-auto` element scrolls
          away with the content on a table wide enough to scroll. */}
      <div className="relative">
        {isLoading && <TableLoadingBar />}
        <div className="overflow-x-auto rounded-md border">
          {/* The table never shrinks below the columns' summed configured sizes
            (tanstack defaults unsized columns to 150px) — on narrow screens
            the wrapper scrolls horizontally instead of crushing columns until
            headers stack letter-by-letter and cell contents overlap. */}
          <Table
            aria-busy={isLoading}
            className={tableClassName}
            style={{ minWidth: configuredTableSize }}
          >
            {!hideHeader && (
              <TableHeader>
                {table.getHeaderGroups().map((headerGroup) => (
                  <TableRow
                    key={headerGroup.id}
                    className="hover:bg-transparent"
                  >
                    {headerGroup.headers.map((header, index) => {
                      const sorted = header.column.getIsSorted();
                      return (
                        <TableHead
                          key={header.id}
                          data-column-id={header.column.id}
                          aria-sort={
                            header.column.getCanSort()
                              ? sorted === "asc"
                                ? "ascending"
                                : sorted === "desc"
                                  ? "descending"
                                  : "none"
                              : undefined
                          }
                          className={getColumnClassName(
                            header.column.id,
                            headerGroup.headers[index - 1]?.column.id,
                          )}
                          style={getColumnStyle({
                            columnId: header.column.id,
                            configuredSize: header.column.columnDef.size,
                            minSize: header.column.columnDef.minSize,
                            renderedSize: header.getSize(),
                            fixedWidth: fixedWidthColumnIds.includes(
                              header.column.id,
                            ),
                            flexibleWidth: flexibleColumnIds.includes(
                              header.column.id,
                            ),
                            fixedColumnsSize,
                            flexibleColumnsSize,
                          })}
                        >
                          {header.isPlaceholder
                            ? null
                            : flexRender(
                                header.column.columnDef.header,
                                header.getContext(),
                              )}
                        </TableHead>
                      );
                    })}
                  </TableRow>
                ))}
              </TableHeader>
            )}
            {/* Rows already on screen are the previous query's answer, so they
              fade back while the next one is in flight rather than sitting
              there looking current. The delay keeps a refetch that resolves
              immediately from registering as a flicker; coming back is
              undelayed so results land at full strength. */}
            <TableBody
              className={cn(
                "transition-opacity duration-200 motion-reduce:transition-none",
                isLoading && "opacity-60 delay-150",
              )}
            >
              {table.getRowModel().rows?.length ? (
                table.getRowModel().rows.map((row) => (
                  <React.Fragment key={row.id}>
                    <TableRow
                      data-state={row.getIsSelected() && "selected"}
                      className={cn(
                        onRowClick ? "cursor-pointer hover:bg-muted/50" : "",
                        getRowClassName?.(row.original),
                      )}
                      onClick={(e) => onRowClick?.(row.original, e)}
                    >
                      {row.getVisibleCells().map((cell, index, cells) => (
                        <TableCell
                          key={cell.id}
                          data-column-id={cell.column.id}
                          onClick={
                            cell.column.id === SELECT_COLUMN_ID
                              ? handleSelectCellClick
                              : undefined
                          }
                          className={getColumnClassName(
                            cell.column.id,
                            cells[index - 1]?.column.id,
                          )}
                          style={getColumnStyle({
                            columnId: cell.column.id,
                            configuredSize: cell.column.columnDef.size,
                            minSize: cell.column.columnDef.minSize,
                            renderedSize: cell.column.getSize(),
                            fixedWidth: fixedWidthColumnIds.includes(
                              cell.column.id,
                            ),
                            flexibleWidth: flexibleColumnIds.includes(
                              cell.column.id,
                            ),
                            fixedColumnsSize,
                            flexibleColumnsSize,
                          })}
                        >
                          {flexRender(
                            cell.column.columnDef.cell,
                            cell.getContext(),
                          )}
                        </TableCell>
                      ))}
                    </TableRow>
                    {renderSubComponent && row.getIsExpanded() && (
                      <TableRow>
                        <TableCell
                          colSpan={row.getVisibleCells().length}
                          className="p-0"
                        >
                          {renderSubComponent({ row })}
                        </TableCell>
                      </TableRow>
                    )}
                  </React.Fragment>
                ))
              ) : (
                <TableRow className="hover:bg-transparent">
                  <TableCell colSpan={columns.length} className="py-0">
                    {/* An empty body while a fetch is still out is not an empty
                      result, so it says nothing: announcing "No Data" and then
                      replacing it with rows a moment later is the flash this
                      area used to produce. The row keeps its height either
                      way, so the rows arrive without shifting the pagination
                      controls underneath. */}
                    <div className="flex min-h-[164px] flex-col items-center justify-center text-center">
                      {!isLoading && (
                        <EmptyState
                          icon={
                            emptyIcon ?? (hasActiveFilters ? Search : undefined)
                          }
                          title={
                            hasActiveFilters
                              ? filteredEmptyMessage
                              : emptyMessage
                          }
                          description={
                            hasActiveFilters
                              ? filteredEmptyDescription
                              : emptyDescription
                          }
                          action={hasActiveFilters ? undefined : emptyAction}
                          onClearFilters={
                            hasActiveFilters ? onClearFilters : undefined
                          }
                        />
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </div>
      {(pagination || !manualPagination) &&
        (!hidePaginationWhenSinglePage ||
          (pagination?.total ?? data.length) >
            (pagination?.pageSize ?? table.getState().pagination.pageSize)) && (
          <DataTablePagination
            table={table}
            totalRows={pagination?.total}
            hideSelectedCount={hideSelectedCount ?? !rowSelection}
            compactPagination={compactPagination}
          />
        )}
    </div>
  );
}

/**
 * An indeterminate sweep pinned to the table's top edge while a request is out.
 *
 * Deliberately not a spinner in place of the rows: a search refetch keeps the
 * previous page on screen, so replacing it would collapse the table's height on
 * every keystroke. This states that what is on screen is about to be replaced
 * without moving any of it.
 */
function TableLoadingBar() {
  return (
    <div
      role="progressbar"
      aria-label="Loading results"
      // Inset by a pixel so it sits inside the container's border rather than
      // across it, and rounded to match the corner it tucks into.
      className="pointer-events-none absolute inset-x-px top-px z-10 h-[3px] overflow-hidden rounded-t-[5px] bg-primary/15 animate-in fade-in-0 duration-200 [animation-delay:150ms] [animation-fill-mode:backwards] motion-reduce:animate-none"
    >
      <div className="archestra-table-loading-sweep h-full rounded-full bg-primary" />
    </div>
  );
}

function getColumnClassName(columnId: string, previousColumnId?: string) {
  if (columnId === SELECT_COLUMN_ID) {
    return "!h-12 !p-0 cursor-pointer text-center [&>[role=checkbox]]:translate-y-0";
  }

  const adjacentToSelection =
    previousColumnId === SELECT_COLUMN_ID ? "!pl-0" : undefined;

  if (COMPACT_ICON_COLUMN_IDS.has(columnId)) {
    return cn(adjacentToSelection, "w-0 px-2 md:px-2");
  }

  if (columnId === ACTIONS_COLUMN_ID) {
    return cn(adjacentToSelection, "whitespace-nowrap");
  }

  return adjacentToSelection;
}

function handleSelectCellClick(
  event: React.MouseEvent<HTMLTableCellElement>,
): void {
  event.stopPropagation();
  const target = event.target as HTMLElement;
  if (target.closest('[role="checkbox"]')) return;
  event.currentTarget.querySelector<HTMLElement>('[role="checkbox"]')?.click();
}

function getColumnStyle(params: {
  columnId: string;
  configuredSize?: number;
  minSize?: number;
  renderedSize: number;
  fixedWidth?: boolean;
  flexibleWidth?: boolean;
  fixedColumnsSize: number;
  flexibleColumnsSize: number;
}): React.CSSProperties | undefined {
  if (params.columnId === SELECT_COLUMN_ID) {
    return {
      width: DATA_TABLE_SELECT_COLUMN_SIZE,
      minWidth: DATA_TABLE_SELECT_COLUMN_SIZE,
      maxWidth: DATA_TABLE_SELECT_COLUMN_SIZE,
    };
  }
  const style: React.CSSProperties = {};
  if (params.configuredSize && !params.flexibleWidth) {
    // On a fixed-layout table an absolute pixel width forces the table wider
    // than its container when the sizes don't fit, hiding trailing columns
    // behind the horizontal scroll. The actions column keeps its pixel width
    // because its icon buttons cannot shrink; the rest get their percentage
    // share of the summed sizes, which the browser scales down to fit the
    // container. Only px and % work here — fixed table layout ignores
    // min()/calc() widths and min-width on cells.
    if (
      params.columnId === ACTIONS_COLUMN_ID ||
      COMPACT_ICON_COLUMN_IDS.has(params.columnId) ||
      params.fixedWidth
    ) {
      style.width = params.renderedSize;
    } else {
      const share = params.renderedSize / params.flexibleColumnsSize;
      const percent = (share * 100).toFixed(4);
      const fixedOffset = (params.fixedColumnsSize * share).toFixed(2);
      style.width = `calc(${percent}% - ${fixedOffset}px)`;
    }
  }
  if (params.minSize) {
    style.minWidth = params.minSize;
  }
  return Object.keys(style).length > 0 ? style : undefined;
}
