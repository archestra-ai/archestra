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
import { Inbox, Loader2, Search } from "lucide-react";
import React, { useState } from "react";

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
import { DataTablePagination } from "./data-table-pagination";

const COMPACT_ICON_COLUMN_IDS = new Set(["icon", "avatar"]);

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

  return (
    <div className="w-full space-y-4">
      <div className="overflow-hidden rounded-md border">
        <Table>
          {!hideHeader && (
            <TableHeader>
              {table.getHeaderGroups().map((headerGroup) => (
                <TableRow key={headerGroup.id} className="hover:bg-transparent">
                  {headerGroup.headers.map((header) => {
                    return (
                      <TableHead
                        key={header.id}
                        data-column-id={header.column.id}
                        className={
                          COMPACT_ICON_COLUMN_IDS.has(header.column.id)
                            ? "w-0 px-2 md:px-2"
                            : undefined
                        }
                        style={
                          header.column.columnDef.size
                            ? { width: header.getSize() }
                            : undefined
                        }
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
                        className={
                          COMPACT_ICON_COLUMN_IDS.has(cell.column.id)
                            ? "px-2 md:px-2"
                            : undefined
                        }
                        style={
                          cell.column.columnDef.size
                            ? { width: cell.column.getSize() }
                            : undefined
                        }
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
                    {isLoading ? (
                      <Loader2 className="mb-3 h-10 w-10 animate-spin text-muted-foreground" />
                    ) : (
                      <div className="mb-3 text-muted-foreground">
                        {hasActiveFilters ? (
                          <Search className="h-10 w-10" />
                        ) : (
                          (emptyIcon ?? <Inbox className="h-10 w-10" />)
                        )}
                      </div>
                    )}
                    <p className="text-sm text-muted-foreground">
                      {isLoading
                        ? "Loading..."
                        : hasActiveFilters
                          ? filteredEmptyMessage
                          : emptyMessage}
                    </p>
                    {!isLoading && hasActiveFilters && onClearFilters && (
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
