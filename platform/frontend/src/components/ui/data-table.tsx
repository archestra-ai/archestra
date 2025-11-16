"use client";

import {
  type ColumnDef,
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  type RowSelectionState,
  type SortingState,
  useReactTable,
  type VisibilityState,
} from "@tanstack/react-table";
import { useState } from "react";

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { DataTablePagination } from "./data-table-pagination";

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
}: DataTableProps<TData, TValue>) {
  const [internalSorting, setInternalSorting] = useState<SortingState>([]);
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>({});

  // Use controlled sorting if provided, otherwise use internal state
  const sorting = controlledSorting ?? internalSorting;

  const table = useReactTable({
    data,
    columns,
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
    onColumnVisibilityChange: setColumnVisibility,
    manualPagination,
    manualSorting,
    pageCount: pagination
      ? Math.ceil(pagination.total / pagination.pageSize)
      : undefined,
    state: {
      sorting,
      columnVisibility,
      rowSelection: rowSelection || {},
      ...(pagination && {
        pagination: {
          pageIndex: pagination.pageIndex,
          pageSize: pagination.pageSize,
        },
      }),
    },
    onPaginationChange: (updater) => {
      if (!onPaginationChange) return;

      const currentPagination = table.getState().pagination;
      const newPagination =
        typeof updater === "function" ? updater(currentPagination) : updater;

      // Auto-reset to first page when page size changes
      if (newPagination.pageSize !== currentPagination.pageSize) {
        newPagination.pageIndex = 0;
      }

      onPaginationChange(newPagination);
    },
  });

  return (
    <div className="w-full space-y-4">
      <div className="overflow-hidden rounded-md border">
        <Table>
          <TableHeader>
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id}>
                {headerGroup.headers.map((header) => {
                  return (
                    <TableHead
                      key={header.id}
                      style={{
                        width: header.getSize(),
                      }}
                      className="px-2"
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
          <TableBody>
            {table.getRowModel().rows?.length ? (
              table.getRowModel().rows.map((row) => (
                <TableRow
                  key={row.id}
                  data-state={row.getIsSelected() && "selected"}
                  className={
                    onRowClick ? "cursor-pointer hover:bg-muted/50" : ""
                  }
                  onClick={(e) => onRowClick?.(row.original, e)}
                >
                  {row.getVisibleCells().map((cell) => (
                    <TableCell
                      key={cell.id}
                      data-column-id={cell.column.id}
                      style={{
                        width: cell.column.getSize(),
                      }}
                      className="px-2"
                    >
                      {flexRender(
                        cell.column.columnDef.cell,
                        cell.getContext(),
                      )}
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell
                  colSpan={columns.length}
                  className="h-24 text-center"
                >
                  No results.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
      {(pagination || !manualPagination) && (
        <DataTablePagination table={table} totalRows={pagination?.total} />
      )}
    </div>
  );
}
