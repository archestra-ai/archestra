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

export const PAGE_SIZE_OPTIONS = [10, 20, 30, 40, 50, 100];

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
  /** Hide rows-per-page selector and page counter, show only nav arrows. */
  compact?: boolean;
}

interface CursorTablePaginationProps {
  pageIndex: number;
  pageSize: number;
  rowCount: number;
  hasNext: boolean;
  canGoNewer: boolean;
  onPageSizeChange: (pageSize: number) => void;
  onNewer: () => void;
  onOlder: () => void;
  /** Content to render on the left side (e.g., row selection count) */
  leftContent?: React.ReactNode;
}

// --- Shared sub-components ---

/**
 * Rows-per-page selector, used by both layouts. Below `md` the label turns
 * small and muted and the trigger narrows, so the whole footer fits one row.
 */
function RowsPerPageSelect({
  pageSize,
  onPageSizeChange,
}: {
  pageSize: number;
  onPageSizeChange: (size: number) => void;
}) {
  return (
    <div className="flex shrink-0 items-center gap-2">
      <p className="text-xs font-medium whitespace-nowrap text-muted-foreground md:text-sm md:text-foreground">
        Rows per page
      </p>
      <Select
        value={`${pageSize}`}
        onValueChange={(value) => onPageSizeChange(Number(value))}
      >
        <SelectTrigger
          aria-label="Rows per page"
          size="sm"
          className="w-[68px] max-md:text-xs md:w-[90px]"
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
  children,
}: {
  canGoPrevious: boolean;
  canGoNext: boolean;
  onPrevious: () => void;
  onNext: () => void;
  className?: string;
  children?: React.ReactNode;
}) {
  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="icon-sm"
        className={className}
        onClick={onPrevious}
        disabled={!canGoPrevious}
      >
        <span className="sr-only">Go to previous page</span>
        <ChevronLeft className="h-4 w-4" />
      </Button>
      {children}
      <Button
        type="button"
        variant="outline"
        size="icon-sm"
        className={className}
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
  compact = false,
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
          {!compact && (
            <RowsPerPageSelect
              pageSize={pageSize}
              onPageSizeChange={handlePageSizeChange}
            />
          )}
          {!compact && (
            <div className="flex w-[100px] items-center justify-center text-sm font-medium">
              Page {currentPage} of {totalPages}
            </div>
          )}
          <div className="flex items-center gap-2">
            {compact && (
              <span className="text-sm font-medium">
                Page {currentPage} of {totalPages}
              </span>
            )}
            <Button
              type="button"
              variant="outline"
              size="icon-sm"
              className="hidden lg:flex"
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
              type="button"
              variant="outline"
              size="icon-sm"
              className="hidden lg:flex"
              onClick={goLast}
              disabled={!canGoNext}
            >
              <span className="sr-only">Go to last page</span>
              <ChevronsRight />
            </Button>
          </div>
        </div>
      </div>

      {/* Mobile layout: one row — rows per page on the left, the page and
          its arrows on the right. */}
      <div className="flex flex-col gap-1.5 md:hidden">
        {leftContent && (
          <div className="text-xs text-muted-foreground">{leftContent}</div>
        )}
        <div className="flex items-center justify-between gap-3">
          <RowsPerPageSelect
            pageSize={pageSize}
            onPageSizeChange={handlePageSizeChange}
          />
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-muted-foreground tabular-nums">
              {currentPage} / {totalPages}
            </span>
            <PaginationNavButtons
              canGoPrevious={canGoPrevious}
              canGoNext={canGoNext}
              onPrevious={goPrevious}
              onNext={goNext}
            />
          </div>
        </div>
      </div>
    </>
  );
}

export function CursorTablePagination({
  pageIndex,
  pageSize,
  rowCount,
  hasNext,
  canGoNewer,
  onPageSizeChange,
  onNewer,
  onOlder,
  leftContent,
}: CursorTablePaginationProps) {
  const firstRow = rowCount === 0 ? 0 : pageIndex * pageSize + 1;
  const lastRow = rowCount === 0 ? 0 : firstRow + rowCount - 1;

  return (
    <div className="flex flex-col gap-1.5 md:flex-row md:items-center md:justify-between md:gap-3">
      {leftContent ? (
        <div className="text-xs text-muted-foreground md:flex-1 md:text-sm">
          {leftContent}
        </div>
      ) : null}
      {/* One row on a phone: rows per page on the left, the range and
          icon-only arrows on the right. */}
      <div className="flex items-center justify-between gap-3 md:ml-auto md:justify-end md:gap-6">
        <RowsPerPageSelect
          pageSize={pageSize}
          onPageSizeChange={onPageSizeChange}
        />
        <div className="flex items-center gap-2 md:gap-6">
          <span className="text-xs font-medium whitespace-nowrap text-muted-foreground tabular-nums md:min-w-[112px] md:text-center md:text-sm md:text-foreground">
            <span className="max-md:sr-only">Showing </span>
            {firstRow}&ndash;{lastRow}
          </span>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="max-md:size-8 max-md:px-0"
              onClick={onNewer}
              disabled={!canGoNewer}
            >
              <ChevronLeft className="size-4" />
              <span className="max-md:sr-only">Newer</span>
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="max-md:size-8 max-md:px-0"
              onClick={onOlder}
              disabled={!hasNext}
            >
              <span className="max-md:sr-only">Older</span>
              <ChevronRight className="size-4" />
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
