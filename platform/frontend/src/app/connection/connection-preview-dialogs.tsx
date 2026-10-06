"use client";

import type { ColumnDef } from "@tanstack/react-table";
import type { LucideIcon } from "lucide-react";
import Link from "next/link";
import { type ReactNode, useMemo, useState } from "react";
import {
  CollectionFilters,
  FilterBar,
  filterSearchClass,
} from "@/components/filter-bar";
import { SearchInput } from "@/components/search-input";
import { StandardDialog } from "@/components/standard-dialog";
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/ui/data-table";
import { DialogCancelButton } from "@/components/unsaved-changes-guard";

const FIRST_PAGE = { pageIndex: 0, pageSize: 10 };

/**
 * One review-step link's data as a searchable table, already narrowed to what
 * the link counted (this gateway's tools, the plugins for this client). The
 * footer leads to the page that manages the whole set.
 */
export function PreviewTableDialog<T>({
  open,
  onClose,
  title,
  description,
  manage,
  searchPlaceholder,
  rows,
  columns,
  getRowId,
  matches,
  filters,
  onClearFilters,
  onRowClick,
  loading,
  emptyIcon,
  emptyMessage,
  emptyDescription,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description: ReactNode;
  manage?: { href: string; label: string };
  searchPlaceholder: string;
  rows: T[];
  columns: ColumnDef<T>[];
  getRowId: (row: T) => string;
  /** Whether a row matches the lowercased search text. */
  matches: (row: T, query: string) => boolean;
  /** Extra filter controls, already applied to `rows` by the caller. */
  filters?: ReactNode;
  onClearFilters?: () => void;
  onRowClick?: (row: T) => void;
  loading?: boolean;
  emptyIcon: LucideIcon;
  emptyMessage: string;
  emptyDescription?: string;
}) {
  const [search, setSearch] = useState("");
  const [pagination, setPagination] = useState(FIRST_PAGE);
  const query = search.trim().toLowerCase();
  const filtered = useMemo(
    () => (query ? rows.filter((row) => matches(row, query)) : rows),
    [rows, query, matches],
  );
  // A narrower filter from the caller can leave the page past the end.
  const pageIndex = Math.min(
    pagination.pageIndex,
    Math.max(0, Math.ceil(filtered.length / pagination.pageSize) - 1),
  );
  const page = filtered.slice(
    pageIndex * pagination.pageSize,
    (pageIndex + 1) * pagination.pageSize,
  );
  const clear = () => {
    setSearch("");
    setPagination(FIRST_PAGE);
    onClearFilters?.();
  };
  const filtering = Boolean(query) || Boolean(onClearFilters);

  return (
    <StandardDialog
      open={open}
      onOpenChange={(next) => {
        if (next) return;
        onClose();
        setSearch("");
        setPagination(FIRST_PAGE);
      }}
      size="medium"
      title={title}
      description={description}
      footerClassName="sm:justify-between"
      footer={
        <>
          {manage ? (
            <Button asChild variant="link" size="sm" className="h-auto px-0">
              <Link href={manage.href}>{manage.label}</Link>
            </Button>
          ) : (
            <span />
          )}
          <DialogCancelButton>Close</DialogCancelButton>
        </>
      }
    >
      <CollectionFilters>
        <FilterBar
          search={
            <SearchInput
              syncQueryParams={false}
              value={search}
              onSearchChange={(value) => {
                setSearch(value);
                setPagination((p) => ({ ...p, pageIndex: 0 }));
              }}
              placeholder={searchPlaceholder}
              className={filterSearchClass}
            />
          }
          onClearFilters={filtering ? clear : undefined}
        >
          {filters}
        </FilterBar>
      </CollectionFilters>
      <DataTable
        columns={columns}
        data={page}
        getRowId={getRowId}
        manualPagination
        pagination={{ ...pagination, pageIndex, total: filtered.length }}
        onPaginationChange={setPagination}
        hidePaginationWhenSinglePage
        onRowClick={onRowClick}
        isLoading={loading}
        emptyIcon={emptyIcon}
        emptyMessage={emptyMessage}
        emptyDescription={emptyDescription}
        hasActiveFilters={filtering}
        filteredEmptyMessage="Nothing matches these filters."
        onClearFilters={clear}
      />
    </StandardDialog>
  );
}
