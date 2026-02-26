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

const PAGE_SIZE_OPTIONS = [10, 20, 30, 40, 50, 100];

interface TablePaginationProps {
  pageIndex: number;
  pageSize: number;
  total: number;
  onPaginationChange: (pagination: {
    pageIndex: number;
    pageSize: number;
  }) => void;
  /** Content to render on the left side (e.g., row selection count) */
  leftContent?: React.ReactNode;
}

// --- Shared sub-components ---

/** Rows-per-page selector, used by both desktop and mobile layouts */
function RowsPerPageSelect({
  pageSize,
  onPageSizeChange,
  compact = false,
}: {
  pageSize: number;
  onPageSizeChange: (size: number) => void;
  /** Use smaller sizing for mobile */
  compact?: boolean;
}) {
  return (
    <div className="flex items-center gap-2">
      <p
        className={
          compact
            ? "text-xs font-medium text-muted-foreground"
            : "text-sm font-medium"
        }
      >
        Rows per page
      </p>
      <Select
        value={`${pageSize}`}
        onValueChange={(value) => onPageSizeChange(Number(value))}
      >
        <SelectTrigger
          className={compact ? "h-7 w-[68px] text-xs" : "h-8 w-[90px]"}
        >
          <SelectValue placeholder={pageSize} />
        </SelectTrigger>
        <SelectContent side="top">
          {PAGE_SIZE_OPTIONS.map((size) => (
            <SelectItem key={size} value={`${size}`}>
              {size}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

/** Previous / Next navigation buttons with sr-only labels */
function PaginationNavButtons({
  canGoPrevious,
  canGoNext,
  onPrevious,
  onNext,
  className,
}: {
  canGoPrevious: boolean;
  canGoNext: boolean;
  onPrevious: () => void;
  onNext: () => void;
  className?: string;
}) {
  return (
    <>
      <Button
        variant="outline"
        size="icon"
        className={className ?? "size-8"}
        onClick={onPrevious}
        disabled={!canGoPrevious}
      >
        <span className="sr-only">Go to previous page</span>
        <ChevronLeft className="h-4 w-4" />
      </Button>
      <Button
        variant="outline"
        size="icon"
        className={className ?? "size-8"}
        onClick={onNext}
        disabled={!canGoNext}
      >
        <span className="sr-only">Go to next page</span>
        <ChevronRight className="h-4 w-4" />
      </Button>
    </>
  );
}

// --- Main component ---

export function TablePagination({
  pageIndex,
  pageSize,
  total,
  onPaginationChange,
  leftContent,
}: TablePaginationProps) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const currentPage = pageIndex + 1;
  const canGoPrevious = pageIndex > 0;
  const canGoNext = currentPage < totalPages;

  const handlePageSizeChange = (size: number) =>
    onPaginationChange({ pageIndex: 0, pageSize: size });
  const goPrevious = () =>
    onPaginationChange({ pageIndex: pageIndex - 1, pageSize });
  const goNext = () =>
    onPaginationChange({ pageIndex: pageIndex + 1, pageSize });
  const goFirst = () => onPaginationChange({ pageIndex: 0, pageSize });
  const goLast = () =>
    onPaginationChange({ pageIndex: totalPages - 1, pageSize });

  return (
    <>
      {/* Desktop layout */}
      <div className="hidden md:flex items-center justify-between">
        <div className="flex-1 text-sm text-muted-foreground">
          {leftContent}
        </div>
        <div className="flex items-center gap-6 lg:gap-8">
          <RowsPerPageSelect
            pageSize={pageSize}
            onPageSizeChange={handlePageSizeChange}
          />
          <div className="flex w-[100px] items-center justify-center text-sm font-medium">
            Page {currentPage} of {totalPages}
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="icon"
              className="hidden size-8 lg:flex"
              onClick={goFirst}
              disabled={!canGoPrevious}
            >
              <span className="sr-only">Go to first page</span>
              <ChevronsLeft />
            </Button>
            <PaginationNavButtons
              canGoPrevious={canGoPrevious}
              canGoNext={canGoNext}
              onPrevious={goPrevious}
              onNext={goNext}
            />
            <Button
              variant="outline"
              size="icon"
              className="hidden size-8 lg:flex"
              onClick={goLast}
              disabled={!canGoNext}
            >
              <span className="sr-only">Go to last page</span>
              <ChevronsRight />
            </Button>
          </div>
        </div>
      </div>

      {/* Mobile layout */}
      <div className="flex flex-col items-center gap-0 md:hidden">
        {/* Selection info */}
        {leftContent && (
          <div className="text-[11px] text-muted-foreground/70 mb-1.5">
            {leftContent}
          </div>
        )}

        {/* Pagination container */}
        <div className="w-full rounded-lg border bg-muted/30 px-4 py-2.5 flex flex-col items-center gap-2.5">
          <RowsPerPageSelect
            pageSize={pageSize}
            onPageSizeChange={handlePageSizeChange}
            compact
          />

          {/* Pagination controls */}
          <div className="flex items-center gap-3">
            <Button
              variant="outline"
              size="icon"
              className="size-8 disabled:opacity-25"
              onClick={goPrevious}
              disabled={!canGoPrevious}
            >
              <span className="sr-only">Go to previous page</span>
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <span className="text-sm font-semibold tabular-nums min-w-[44px] text-center">
              {currentPage} / {totalPages}
            </span>
            <Button
              variant="outline"
              size="icon"
              className="size-8 disabled:opacity-25"
              onClick={goNext}
              disabled={!canGoNext}
            >
              <span className="sr-only">Go to next page</span>
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </div>
    </>
  );
}
