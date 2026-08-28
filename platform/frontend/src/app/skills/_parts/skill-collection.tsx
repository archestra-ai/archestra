"use client";

import type {
  ColumnDef,
  RowSelectionState,
  SortingState,
} from "@tanstack/react-table";
import { ChevronDown, ChevronUp, type LucideIcon } from "lucide-react";
import { type MouseEvent, type ReactNode, useEffect, useState } from "react";
import {
  TableCardList,
  TableCardSelectionScope,
  TableCardViewContent,
} from "@/components/table-card-view";
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/ui/data-table";
import type { BulkRangeSelectionController } from "@/lib/bulk-range-selection";

type Pagination = {
  pageIndex: number;
  pageSize: number;
  total: number;
};

export function SkillCollection<TData>({
  items,
  columns,
  getRowId,
  renderCard,
  isLoading = false,
  emptyIcon,
  emptyMessage,
  hasActiveFilters = false,
  filteredEmptyMessage,
  onClearFilters,
  pagination,
  onPaginationChange,
  manualPagination = false,
  sorting,
  onSortingChange,
  manualSorting = false,
  onRowClick,
  rowSelection,
  onRowSelectionChange,
  onPageRowIdsChange,
  rangeSelection,
  forceTable = false,
  fixedWidthColumnIds,
  flexibleColumnIds,
}: {
  items: TData[];
  columns: ColumnDef<TData>[];
  getRowId: (item: TData, index: number) => string;
  renderCard: (item: TData) => ReactNode;
  isLoading?: boolean;
  emptyIcon?: LucideIcon;
  emptyMessage: string;
  hasActiveFilters?: boolean;
  filteredEmptyMessage?: string;
  onClearFilters?: () => void;
  pagination?: Pagination;
  onPaginationChange?: (pagination: Omit<Pagination, "total">) => void;
  manualPagination?: boolean;
  sorting?: SortingState;
  onSortingChange?: (sorting: SortingState) => void;
  manualSorting?: boolean;
  onRowClick?: (item: TData, event: MouseEvent) => void;
  rowSelection?: RowSelectionState;
  onRowSelectionChange?: (selection: RowSelectionState) => void;
  onPageRowIdsChange?: (ids: string[]) => void;
  rangeSelection?: BulkRangeSelectionController;
  forceTable?: boolean;
  fixedWidthColumnIds?: string[];
  flexibleColumnIds?: string[];
}) {
  const [clientPagination, setClientPagination] = useState({
    pageIndex: 0,
    pageSize: 10,
  });
  const resolvedPagination = pagination ?? {
    ...clientPagination,
    total: items.length,
  };
  const handlePaginationChange = onPaginationChange ?? setClientPagination;

  useEffect(() => {
    if (
      isLoading ||
      manualPagination ||
      (pagination !== undefined && onPaginationChange === undefined)
    ) {
      return;
    }
    const maxPageIndex = Math.max(
      Math.ceil(items.length / resolvedPagination.pageSize) - 1,
      0,
    );
    if (resolvedPagination.pageIndex > maxPageIndex) {
      handlePaginationChange({
        pageIndex: maxPageIndex,
        pageSize: resolvedPagination.pageSize,
      });
    }
  }, [
    handlePaginationChange,
    isLoading,
    items.length,
    manualPagination,
    onPaginationChange,
    pagination,
    resolvedPagination.pageIndex,
    resolvedPagination.pageSize,
  ]);

  const cardPageStart =
    resolvedPagination.pageIndex * resolvedPagination.pageSize;
  const cardItems = manualPagination
    ? items
    : sortSkillItems(items, sorting).slice(
        cardPageStart,
        cardPageStart + resolvedPagination.pageSize,
      );

  return (
    <TableCardViewContent
      forceTable={forceTable}
      cards={
        <TableCardSelectionScope
          rowIds={cardItems.map((item, index) => getRowId(item, index))}
          onVisibleRowIdsChange={onPageRowIdsChange ?? noop}
        >
          <TableCardList
            itemCount={cardItems.length}
            isLoading={isLoading}
            emptyIcon={emptyIcon}
            emptyMessage={emptyMessage}
            hasActiveFilters={hasActiveFilters}
            filteredEmptyMessage={filteredEmptyMessage}
            onClearFilters={onClearFilters}
            pagination={resolvedPagination}
            onPaginationChange={handlePaginationChange}
          >
            {cardItems.map(renderCard)}
          </TableCardList>
        </TableCardSelectionScope>
      }
      table={
        <DataTable
          columns={columns}
          data={items}
          getRowId={getRowId}
          emptyIcon={emptyIcon}
          emptyMessage={emptyMessage}
          hasActiveFilters={hasActiveFilters}
          filteredEmptyMessage={filteredEmptyMessage}
          onClearFilters={onClearFilters}
          hideSelectedCount
          manualPagination={manualPagination}
          manualSorting={manualSorting}
          sorting={sorting}
          onSortingChange={onSortingChange}
          pagination={resolvedPagination}
          onPaginationChange={handlePaginationChange}
          onRowClick={onRowClick}
          rowSelection={rowSelection}
          onRowSelectionChange={onRowSelectionChange}
          onPageRowIdsChange={onPageRowIdsChange}
          rangeSelection={rangeSelection}
          isLoading={isLoading}
          tableClassName="[&_td]:py-1.5"
          fixedWidthColumnIds={fixedWidthColumnIds}
          flexibleColumnIds={flexibleColumnIds}
        />
      }
    />
  );
}

function noop() {}

export function SkillSortableHeader({
  label,
  isSorted,
  onToggle,
}: {
  label: string;
  isSorted: "asc" | "desc" | false;
  onToggle: () => void;
}) {
  return (
    <Button
      variant="ghost"
      className="h-auto !p-0 font-medium hover:bg-transparent"
      onClick={onToggle}
    >
      <span>{label}</span>
      <SkillSortIcon isSorted={isSorted} />
    </Button>
  );
}

function SkillSortIcon({ isSorted }: { isSorted: "asc" | "desc" | false }) {
  const upArrow = <ChevronUp className="h-3 w-3" />;
  const downArrow = <ChevronDown className="h-3 w-3" />;
  if (isSorted === "asc") return upArrow;
  if (isSorted === "desc") return downArrow;
  return (
    <span className="flex flex-col items-center text-muted-foreground">
      {upArrow}
      <span className="mt-[-4px]">{downArrow}</span>
    </span>
  );
}

function sortSkillItems<TData>(items: TData[], sorting?: SortingState) {
  if (!sorting?.length) return items;
  return [...items].sort((left, right) => {
    for (const sort of sorting) {
      const leftValue = (left as Record<string, unknown>)[sort.id];
      const rightValue = (right as Record<string, unknown>)[sort.id];
      const comparison = compareSortValues(leftValue, rightValue);
      if (comparison !== 0) return sort.desc ? -comparison : comparison;
    }
    return 0;
  });
}

function compareSortValues(left: unknown, right: unknown) {
  if (left == null) return right == null ? 0 : -1;
  if (right == null) return 1;
  if (typeof left === "number" && typeof right === "number") {
    return left - right;
  }
  return String(left).localeCompare(String(right));
}
