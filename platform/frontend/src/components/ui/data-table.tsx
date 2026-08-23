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
import { Inbox, Search } from "lucide-react";
import React, { useState } from "react";

import { LoadingState } from "@/components/loading";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
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
  /** Custom empty state message (defaults to "No results") */
  emptyMessage?: string;
  /** Icon to show in the empty state (defaults to Inbox) */
  emptyIcon?: React.ReactNode;
  /** Whether filters/search are currently active */
  hasActiveFilters?: boolean;
  /** Message to show when filters/search produce no results */
  filteredEmptyMessage?: string;
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
  onPageRowIdsChange,
  hideSelectedCount,
  getRowId,
  renderSubComponent,
  getRowClassName,
  isLoading = false,
  emptyMessage = "No results",
  emptyIcon,
  hasActiveFilters = false,
  filteredEmptyMessage = "No results match your filters. Try adjusting your search.",
  onClearFilters,
  hidePaginationWhenSinglePage = false,
  hideHeader = false,
  compactPagination = false,
  tableClassName,
  fixedWidthColumnIds = [],
  flexibleColumnIds = [],
}: DataTableProps<TData, TValue>) {
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

  if (isLoading && data.length === 0) {
    return <LoadingState label="Loading results…" />;
  }

  return (
    <div className="w-full space-y-4">
      <div className="overflow-x-auto rounded-md border">
        {/* The table never shrinks below the columns' summed configured sizes
            (tanstack defaults unsized columns to 150px) — on narrow screens
            the wrapper scrolls horizontally instead of crushing columns until
            headers stack letter-by-letter and cell contents overlap. */}
        <Table
          className={tableClassName}
          style={{ minWidth: configuredTableSize }}
        >
          {!hideHeader && (
            <TableHeader>
              {table.getHeaderGroups().map((headerGroup) => (
                <TableRow key={headerGroup.id} className="hover:bg-transparent">
                  {headerGroup.headers.map((header) => {
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
                        className={getColumnClassName(header.column.id)}
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
          <TableBody>
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
                    {row.getVisibleCells().map((cell) => (
                      <TableCell
                        key={cell.id}
                        data-column-id={cell.column.id}
                        onClick={
                          cell.column.id === SELECT_COLUMN_ID
                            ? handleSelectCellClick
                            : undefined
                        }
                        className={getColumnClassName(cell.column.id)}
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
              <TableRow>
                <TableCell colSpan={columns.length} className="py-0">
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
                    {hasActiveFilters && onClearFilters && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="mt-4"
                        onClick={onClearFilters}
                      >
                        Clear filters
                      </Button>
                    )}
                  </div>
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
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

function getColumnClassName(columnId: string) {
  if (columnId === SELECT_COLUMN_ID) {
    return "!p-0 text-center [&>[role=checkbox]]:translate-y-0";
  }

  if (COMPACT_ICON_COLUMN_IDS.has(columnId)) {
    return "w-0 px-2 md:px-2";
  }

  if (columnId === ACTIONS_COLUMN_ID) {
    return "whitespace-nowrap";
  }

  return undefined;
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
