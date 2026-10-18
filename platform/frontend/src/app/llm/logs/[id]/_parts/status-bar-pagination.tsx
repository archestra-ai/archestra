"use client";

import {
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/**
 * Paging for the requests card's status bar, in the bar's own small muted
 * type so it reads as one line with the totals beside it. Phones keep only
 * the steppers and "1 / 2"; the page size and the jumps to either end come in
 * from `lg`.
 */
export function StatusBarPagination({
  pageIndex,
  pageSize,
  total,
  onPaginationChange,
}: {
  pageIndex: number;
  pageSize: number;
  total: number;
  onPaginationChange: (pagination: {
    pageIndex: number;
    pageSize: number;
  }) => void;
}) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const canGoPrevious = pageIndex > 0;
  const canGoNext = pageIndex + 1 < totalPages;
  const goTo = (next: number) =>
    onPaginationChange({ pageIndex: next, pageSize });

  return (
    <nav
      aria-label="Pagination"
      className="flex shrink-0 items-center gap-1 text-xs whitespace-nowrap text-muted-foreground tabular-nums"
    >
      <span className="mr-3 hidden items-center gap-1.5 lg:inline-flex">
        <span>Rows</span>
        <Select
          value={`${pageSize}`}
          onValueChange={(value) =>
            onPaginationChange({ pageIndex: 0, pageSize: Number(value) })
          }
        >
          <SelectTrigger
            aria-label="Rows per page"
            size="sm"
            className="w-[64px] gap-1 bg-card px-2 text-xs data-[size=sm]:h-7"
          >
            <SelectValue placeholder={pageSize} />
          </SelectTrigger>
          <SelectContent side="top">
            {PAGE_SIZE_OPTIONS.map((size) => (
              <SelectItem key={size} value={`${size}`} className="text-xs">
                {size}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </span>
      <Button
        variant="ghost"
        size="icon-xs"
        className="hidden lg:inline-flex"
        onClick={() => goTo(0)}
        disabled={!canGoPrevious}
        aria-label="Go to first page"
      >
        <ChevronsLeft />
      </Button>
      <Button
        variant="ghost"
        size="icon-xs"
        onClick={() => goTo(pageIndex - 1)}
        disabled={!canGoPrevious}
        aria-label="Go to previous page"
      >
        <ChevronLeft />
      </Button>
      <span className="min-w-9 text-center lg:hidden">
        {pageIndex + 1} / {totalPages}
      </span>
      <span className="hidden px-1 lg:inline">
        Page {pageIndex + 1} of {totalPages}
      </span>
      <Button
        variant="ghost"
        size="icon-xs"
        onClick={() => goTo(pageIndex + 1)}
        disabled={!canGoNext}
        aria-label="Go to next page"
      >
        <ChevronRight />
      </Button>
      <Button
        variant="ghost"
        size="icon-xs"
        className="hidden lg:inline-flex"
        onClick={() => goTo(totalPages - 1)}
        disabled={!canGoNext}
        aria-label="Go to last page"
      >
        <ChevronsRight />
      </Button>
    </nav>
  );
}

// ============================================================================
// Internal helpers
// ============================================================================

const PAGE_SIZE_OPTIONS = [10, 20, 30, 40, 50, 100];
