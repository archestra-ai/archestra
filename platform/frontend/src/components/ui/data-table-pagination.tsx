import type { Table } from "@tanstack/react-table";

import { TablePagination } from "@/components/ui/table-pagination";

interface DataTablePaginationProps<TData> {
  table: Table<TData>;
  totalRows?: number;
  hideSelectedCount?: boolean;
}

export function DataTablePagination<TData>({
  table,
  totalRows,
  hideSelectedCount = false,
}: DataTablePaginationProps<TData>) {
  const paginationState = table.getState().pagination;
  const pageIndex = paginationState?.pageIndex ?? 0;
  const pageSize = paginationState?.pageSize ?? 10;
  const total = totalRows ?? table.getFilteredRowModel().rows.length;

  return (
    <TablePagination
      pageIndex={pageIndex}
      pageSize={pageSize}
      total={total}
      onPaginationChange={(newPagination) => {
        if (newPagination.pageSize !== pageSize) {
          table.setPageSize(newPagination.pageSize);
        } else {
          table.setPageIndex(newPagination.pageIndex);
        }
      }}
      leftContent={
        hideSelectedCount ? null : (
          <>
            {table.getFilteredSelectedRowModel().rows.length} of{" "}
            {table.getFilteredRowModel().rows.length} row(s) selected.
          </>
        )
      }
    />
  );
}
