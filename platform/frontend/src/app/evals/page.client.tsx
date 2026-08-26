"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { FlaskConical, Plus, Trash2 } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { ErrorBoundary } from "@/app/_parts/error-boundary";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { EmptyState } from "@/components/empty-state";
import { FilterBar, filterSearchClass } from "@/components/filter-bar";
import { PageLayout } from "@/components/page-layout";
import { QueryLoadError } from "@/components/query-load-error";
import { SearchInput } from "@/components/search-input";
import {
  TableCard,
  TableCardList,
  TableCardView,
  TableCardViewContent,
  TableCardViewToggle,
} from "@/components/table-card-view";
import {
  type TableRowAction,
  TableRowActions,
} from "@/components/table-row-actions";
import { Badge } from "@/components/ui/badge";
import { BulkActionsBar } from "@/components/ui/bulk-actions-bar";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { DataTable } from "@/components/ui/data-table";
import { DATA_TABLE_SELECT_COLUMN_SIZE } from "@/components/ui/data-table.constants";
import { PermissionButton } from "@/components/ui/permission-button";
import { DEFAULT_TABLE_LIMIT } from "@/consts";
import { useHasPermissions } from "@/lib/auth/auth.query";
import {
  type EvalSuite,
  useBulkDeleteEvalSuites,
  useDeleteEvalSuite,
  useEvalSuites,
} from "@/lib/evals/eval.query";
import { formatDate } from "@/lib/utils";
import { EvalSuiteDialog } from "./_parts/eval-suite-dialog";

export default function EvalsPage() {
  return (
    <ErrorBoundary>
      <EvalSuitesList />
    </ErrorBoundary>
  );
}

const selectColumn: ColumnDef<EvalSuite> = {
  id: "select",
  size: DATA_TABLE_SELECT_COLUMN_SIZE,
  minSize: DATA_TABLE_SELECT_COLUMN_SIZE,
  maxSize: DATA_TABLE_SELECT_COLUMN_SIZE,
  header: ({ table }) => (
    <Checkbox
      checked={
        table.getIsAllPageRowsSelected() ||
        (table.getIsSomePageRowsSelected() && "indeterminate")
      }
      onCheckedChange={(value) => table.toggleAllPageRowsSelected(!!value)}
      onClick={(event) => event.stopPropagation()}
      aria-label="Select all eval suites on this page"
    />
  ),
  cell: ({ row }) => (
    <Checkbox
      checked={row.getIsSelected()}
      onCheckedChange={(value) => row.toggleSelected(!!value)}
      onClick={(event) => event.stopPropagation()}
      aria-label={`Select ${row.original.name}`}
    />
  ),
};

function EvalSuitesList() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const search = searchParams.get("search") || "";

  const [pagination, setPagination] = useState({
    pageIndex: 0,
    pageSize: DEFAULT_TABLE_LIMIT,
  });
  const [rowSelection, setRowSelection] = useState<Record<string, boolean>>({});
  const [createOpen, setCreateOpen] = useState(false);
  const [suiteToDelete, setSuiteToDelete] = useState<EvalSuite | null>(null);
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);

  // A new search starts the reader back on page one of the new result set.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset is keyed to the search term
  useEffect(() => {
    setPagination((current) => ({ ...current, pageIndex: 0 }));
  }, [search]);

  const { data: canCreate } = useHasPermissions({ eval: ["create"] });
  const { data: canDelete } = useHasPermissions({ eval: ["delete"] });

  const suitesQuery = useEvalSuites({
    limit: pagination.pageSize,
    offset: pagination.pageIndex * pagination.pageSize,
    name: search || undefined,
  });
  const deleteSuite = useDeleteEvalSuite();
  const bulkDelete = useBulkDeleteEvalSuites();

  const suites = suitesQuery.data?.data ?? [];
  const total = suitesQuery.data?.pagination.total ?? 0;
  const hasActiveFilters = !!search;
  const showEmptyState =
    total === 0 && !hasActiveFilters && !suitesQuery.isLoading;

  // Server-paginated: a bulk action only ever touches rows on screen, so ids
  // ticked on another page drop out here.
  const pageSelection = suites.filter((suite) => rowSelection[suite.id]);
  const clearSelection = () => setRowSelection({});
  const clearFilters = () => router.replace(pathname);

  const renderRowActions = (suite: EvalSuite) => {
    if (!canDelete) return null;
    const actions: TableRowAction[] = [
      {
        label: "Delete",
        icon: <Trash2 className="h-4 w-4" />,
        className: "text-destructive",
        onClick: () => setSuiteToDelete(suite),
      },
    ];
    return <TableRowActions actions={actions} />;
  };

  const columns: ColumnDef<EvalSuite>[] = [
    ...(canDelete ? [selectColumn] : []),
    {
      accessorKey: "name",
      header: "Name",
      cell: ({ row }) => (
        <Link
          href={`/evals/${row.original.id}`}
          className="font-medium hover:underline"
        >
          {row.original.name}
        </Link>
      ),
    },
    {
      accessorKey: "description",
      header: "Description",
      cell: ({ row }) => (
        <span className="text-muted-foreground line-clamp-1">
          {row.original.description ?? ""}
        </span>
      ),
    },
    {
      accessorKey: "caseCount",
      header: "Cases",
      cell: ({ row }) => (
        <Badge variant="outline">{row.original.caseCount}</Badge>
      ),
    },
    {
      accessorKey: "createdAt",
      header: "Created",
      cell: ({ row }) => (
        <span className="text-muted-foreground">
          {formatDate({ date: row.original.createdAt })}
        </span>
      ),
    },
    {
      id: "actions",
      cell: ({ row }) => renderRowActions(row.original),
    },
  ];

  return (
    <PageLayout
      title="Evals"
      status={
        <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">
          Beta
        </Badge>
      }
      description="Grade your agents against repeatable test suites."
      actionButton={
        canCreate ? (
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="mr-2 h-4 w-4" />
            <span>New suite</span>
          </Button>
        ) : undefined
      }
    >
      <TableCardView storageKey="archestra-evals-view" defaultMode="table">
        {suitesQuery.isLoadingError ? (
          <QueryLoadError
            title="Couldn't load eval suites"
            onRetry={() => suitesQuery.refetch()}
          />
        ) : showEmptyState ? (
          <EmptyState
            icon={FlaskConical}
            title="No eval suites yet"
            description="Create a suite of test cases, then run it against an agent to grade its behavior."
            action={
              canCreate ? (
                <Button onClick={() => setCreateOpen(true)}>
                  <Plus className="mr-2 h-4 w-4" />
                  <span>New suite</span>
                </Button>
              ) : undefined
            }
          />
        ) : (
          <div className="space-y-4">
            <FilterBar
              onClearFilters={hasActiveFilters ? clearFilters : undefined}
              actions={<TableCardViewToggle />}
            >
              <SearchInput
                paramName="search"
                objectNamePlural="eval suites"
                className={filterSearchClass}
              />
            </FilterBar>

            <BulkActionsBar
              count={pageSelection.length}
              noun="suite"
              onClear={clearSelection}
            >
              <PermissionButton
                permissions={{ eval: ["delete"] }}
                variant="destructive"
                size="sm"
                onClick={() => setBulkDeleteOpen(true)}
              >
                <Trash2 className="h-4 w-4" />
                <span>Delete</span>
              </PermissionButton>
            </BulkActionsBar>

            <TableCardViewContent
              cards={
                <TableCardList
                  itemCount={suites.length}
                  isLoading={suitesQuery.isFetching}
                  emptyIcon={FlaskConical}
                  emptyMessage="No eval suites yet."
                  hasActiveFilters={hasActiveFilters}
                  filteredEmptyMessage="No eval suites match this search."
                  onClearFilters={clearFilters}
                  pagination={{ ...pagination, total }}
                  onPaginationChange={setPagination}
                >
                  {suites.map((suite) => (
                    <TableCard
                      key={suite.id}
                      icon={
                        <FlaskConical className="text-muted-foreground h-5 w-5" />
                      }
                      title={
                        <Link href={`/evals/${suite.id}`}>{suite.name}</Link>
                      }
                      description={suite.description}
                      actions={renderRowActions(suite)}
                      selected={
                        canDelete ? !!rowSelection[suite.id] : undefined
                      }
                      onSelectedChange={
                        canDelete
                          ? (selected) => {
                              const next = { ...rowSelection };
                              if (selected) next[suite.id] = true;
                              else delete next[suite.id];
                              setRowSelection(next);
                            }
                          : undefined
                      }
                      selectionLabel={`Select ${suite.name}`}
                      footer={
                        <div className="flex items-center justify-between gap-3">
                          <span>
                            {suite.caseCount}{" "}
                            {suite.caseCount === 1 ? "case" : "cases"}
                          </span>
                          <span>{formatDate({ date: suite.createdAt })}</span>
                        </div>
                      }
                    />
                  ))}
                </TableCardList>
              }
              table={
                <DataTable
                  columns={columns}
                  data={suites}
                  getRowId={(row) => row.id}
                  emptyIcon={FlaskConical}
                  emptyMessage="No eval suites yet."
                  hasActiveFilters={hasActiveFilters}
                  filteredEmptyMessage="No eval suites match this search."
                  onClearFilters={clearFilters}
                  hideSelectedCount
                  manualPagination
                  pagination={{ ...pagination, total }}
                  onPaginationChange={setPagination}
                  onRowClick={(row) => router.push(`/evals/${row.id}`)}
                  rowSelection={rowSelection}
                  onRowSelectionChange={setRowSelection}
                  isLoading={suitesQuery.isFetching}
                />
              }
            />
          </div>
        )}
      </TableCardView>

      <EvalSuiteDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={(suite) => router.push(`/evals/${suite.id}`)}
      />
      <DeleteConfirmDialog
        open={!!suiteToDelete}
        onOpenChange={(open) => {
          if (!open) setSuiteToDelete(null);
        }}
        title="Delete eval suite?"
        description={`"${suiteToDelete?.name ?? ""}" and its cases will be deleted. Past runs keep their results.`}
        isPending={deleteSuite.isPending}
        onConfirm={async () => {
          if (!suiteToDelete) return;
          await deleteSuite.mutateAsync(suiteToDelete.id);
          setSuiteToDelete(null);
        }}
      />
      <DeleteConfirmDialog
        open={bulkDeleteOpen}
        onOpenChange={setBulkDeleteOpen}
        title={`Delete ${pageSelection.length} ${pageSelection.length === 1 ? "suite" : "suites"}?`}
        description="Their cases will be deleted. Past runs keep their results."
        isPending={bulkDelete.isPending}
        onConfirm={async () => {
          const outcome = await bulkDelete.mutateAsync(
            pageSelection.map((s) => s.id),
          );
          setBulkDeleteOpen(false);
          // Rows that failed to delete stay selected for a retry; the rest
          // clear with their deleted suites.
          const failedIds = outcome?.failed.map((f) => f.id) ?? [];
          setRowSelection(
            Object.fromEntries(failedIds.map((id) => [id, true])),
          );
        }}
      />
    </PageLayout>
  );
}
