import type { Table } from "@tanstack/react-table";

import {
  CursorTablePagination,
  TablePagination,
} from "@/components/ui/table-pagination";

export interface CursorPaginationState {
  pageIndex: number;
  pageSize: number;
  hasNext: boolean;
  canGoNewer: boolean;
  onPageSizeChange: (pageSize: number) => void;
  onNewer: () => void;
  onOlder: () => void;
}

interface DataTablePaginationProps<TData> {
  table: Table<TData>;
  totalRows?: number;
  hideSelectedCount?: boolean;
  compactPagination?: boolean;
  cursorPagination?: CursorPaginationState;
  rowCount?: number;
}

export function DataTablePagination<TData>({
  table,
  totalRows,
  hideSelectedCount = false,
  compactPagination = false,
  cursorPagination,
  rowCount = 0,
}: DataTablePaginationProps<TData>) {
  const paginationState = table.getState().pagination;
  const pageIndex = paginationState?.pageIndex ?? 0;
  const pageSize = paginationState?.pageSize ?? 10;
  const total = totalRows ?? table.getFilteredRowModel().rows.length;
  const leftContent = hideSelectedCount ? null : (
    <>
      {table.getFilteredSelectedRowModel().rows.length} of{" "}
      {table.getFilteredRowModel().rows.length} row(s) selected.
    </>
  );

  if (cursorPagination) {
    return (
      <CursorTablePagination
        {...cursorPagination}
        rowCount={rowCount}
        leftContent={leftContent}
      />
    );
  }

  return (
    <TablePagination
      pageIndex={pageIndex}
      pageSize={pageSize}
      total={total}
      compact={compactPagination}
      onPaginationChange={(newPagination) => {
        if (newPagination.pageSize !== pageSize) {
          table.setPageSize(newPagination.pageSize);
        } else {
          table.setPageIndex(newPagination.pageIndex);
        }
      }}
      leftContent={leftContent}
    />
  );
}
