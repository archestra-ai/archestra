"use client";

import type { ColumnDef, RowSelectionState } from "@tanstack/react-table";
import {
  ArrowLeft,
  FlaskConical,
  GitCompareArrows,
  Pencil,
  Play,
  Plus,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import Link from "next/link";
import {
  useParams,
  usePathname,
  useRouter,
  useSearchParams,
} from "next/navigation";
import { useEffect, useState } from "react";
import { ErrorBoundary } from "@/app/_parts/error-boundary";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { EmptyState } from "@/components/empty-state";
import {
  FilterBar,
  FilterSelect,
  filterSearchClass,
} from "@/components/filter-bar";
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
import { DEFAULT_TABLE_LIMIT } from "@/consts";
import { useHasPermissions } from "@/lib/auth/auth.query";
import {
  type EvalCase,
  type EvalRun,
  useBulkDeleteEvalCases,
  useDeleteEvalCase,
  useEvalRun,
  useEvalRuns,
  useEvalSuite,
  useEvalSuiteCases,
} from "@/lib/evals/eval.query";
import { formatDate } from "@/lib/utils";
import { summarizeAssertion } from "../_parts/assertion-summary";
import {
  EvalCaseDialog,
  type EvalCaseTemplate,
} from "../_parts/eval-case-dialog";
import { EvalRunDialog } from "../_parts/eval-run-dialog";
import { EvalRunStatusBadge } from "../_parts/eval-run-status-badge";
import { EvalSuiteDialog } from "../_parts/eval-suite-dialog";

const RUNS_POLL_INTERVAL_MS = 5000;
const MAX_ASSERTION_CHIPS = 2;

const RUN_STATUS_FILTERS = [
  "pending",
  "running",
  "completed",
  "failed",
  "canceled",
] as const;

/** Prefilled first case, so an empty suite explains itself by example. */
const EXAMPLE_CASE: EvalCaseTemplate = {
  name: "Greeting sanity check",
  messages: ["Introduce yourself in one sentence and say hello."],
  assertions: [
    { type: "contains", values: ["hello"], mode: "all", caseSensitive: false },
  ],
};

export default function EvalSuitePage() {
  return (
    <ErrorBoundary>
      <EvalSuiteDetail />
    </ErrorBoundary>
  );
}

function EvalSuiteDetail() {
  const params = useParams<{ id: string }>();
  const suiteId = params.id;
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const isRunsTab = searchParams.get("tab") === "runs";
  const focusedGroupId = searchParams.get("group");

  const [caseDialogOpen, setCaseDialogOpen] = useState(false);
  const [caseToEdit, setCaseToEdit] = useState<EvalCase | null>(null);
  const [caseTemplate, setCaseTemplate] = useState<EvalCaseTemplate | null>(
    null,
  );
  const [caseToDelete, setCaseToDelete] = useState<EvalCase | null>(null);
  const [editSuiteOpen, setEditSuiteOpen] = useState(false);
  const [runDialogOpen, setRunDialogOpen] = useState(false);

  const { data: canUpdate } = useHasPermissions({ eval: ["update"] });
  const { data: canExecute } = useHasPermissions({ eval: ["execute"] });

  const suiteQuery = useEvalSuite(suiteId);
  const casesQuery = useEvalSuiteCases(suiteId);
  const deleteCase = useDeleteEvalCase();

  const suite = suiteQuery.data;
  const cases = casesQuery.data ?? [];

  if (suiteQuery.isLoadingError) {
    return (
      <QueryLoadError
        title="Couldn't load this eval suite"
        onRetry={() => suiteQuery.refetch()}
      />
    );
  }
  if (!suiteQuery.isLoading && !suite) {
    return (
      <EmptyState
        title="Eval suite not found"
        description="It may have been deleted."
        action={
          <Button asChild variant="outline">
            <Link href="/evals">
              <ArrowLeft className="mr-2 h-4 w-4" />
              <span>Back to Evals</span>
            </Link>
          </Button>
        }
      />
    );
  }

  const openNewCaseDialog = (template: EvalCaseTemplate | null) => {
    setCaseToEdit(null);
    setCaseTemplate(template);
    setCaseDialogOpen(true);
  };

  return (
    <PageLayout
      title={suite?.name ?? "Eval suite"}
      documentTitle={suite?.name ?? "Eval suite"}
      status={
        <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">
          Beta
        </Badge>
      }
      description={suite?.description ?? undefined}
      backLink={
        <Link
          href="/evals"
          className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-sm"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          <span>Back to Evals</span>
        </Link>
      }
      tabs={[
        { label: "Cases", href: pathname, selected: !isRunsTab },
        { label: "Runs", href: `${pathname}?tab=runs`, selected: isRunsTab },
      ]}
      actionButton={
        <div className="flex gap-2">
          {!isRunsTab && canUpdate && (
            <Button variant="outline" onClick={() => openNewCaseDialog(null)}>
              <Plus className="mr-2 h-4 w-4" />
              <span>Add case</span>
            </Button>
          )}
          {canUpdate && (
            <Button variant="outline" onClick={() => setEditSuiteOpen(true)}>
              <Pencil className="mr-2 h-4 w-4" />
              <span>Edit</span>
            </Button>
          )}
          {canExecute && (
            <Button
              onClick={() => setRunDialogOpen(true)}
              disabled={cases.length === 0}
            >
              <Play className="mr-2 h-4 w-4" />
              <span>Run</span>
            </Button>
          )}
        </div>
      }
    >
      {isRunsTab ? (
        <SuiteRunHistory suiteId={suiteId} focusedGroupId={focusedGroupId} />
      ) : (
        <SuiteCases
          suiteId={suiteId}
          cases={cases}
          isLoading={casesQuery.isLoading}
          isLoadingError={casesQuery.isLoadingError}
          onRetry={() => casesQuery.refetch()}
          canUpdate={!!canUpdate}
          onAddExample={() => openNewCaseDialog(EXAMPLE_CASE)}
          onEdit={(evalCase) => {
            setCaseTemplate(null);
            setCaseToEdit(evalCase);
            setCaseDialogOpen(true);
          }}
          onDelete={setCaseToDelete}
        />
      )}

      <EvalCaseDialog
        open={caseDialogOpen}
        onOpenChange={(open) => {
          setCaseDialogOpen(open);
          if (!open) {
            setCaseToEdit(null);
            setCaseTemplate(null);
          }
        }}
        suiteId={suiteId}
        evalCase={caseToEdit}
        template={caseTemplate}
      />
      <EvalSuiteDialog
        open={editSuiteOpen}
        onOpenChange={setEditSuiteOpen}
        suite={suite ?? null}
      />
      <EvalRunDialog
        open={runDialogOpen}
        onOpenChange={setRunDialogOpen}
        suiteId={suiteId}
      />
      <DeleteConfirmDialog
        open={!!caseToDelete}
        onOpenChange={(open) => {
          if (!open) setCaseToDelete(null);
        }}
        title="Delete case?"
        description={`"${caseToDelete?.name ?? ""}" will be removed from this suite. Past run results keep their snapshot of it.`}
        isPending={deleteCase.isPending}
        onConfirm={async () => {
          if (!caseToDelete) return;
          await deleteCase.mutateAsync(caseToDelete.id);
          setCaseToDelete(null);
        }}
      />
    </PageLayout>
  );
}

// === Cases tab ===

function SuiteCases({
  suiteId,
  cases,
  isLoading,
  isLoadingError,
  onRetry,
  canUpdate,
  onAddExample,
  onEdit,
  onDelete,
}: {
  suiteId: string;
  cases: EvalCase[];
  isLoading: boolean;
  isLoadingError: boolean;
  onRetry: () => void;
  canUpdate: boolean;
  onAddExample: () => void;
  onEdit: (evalCase: EvalCase) => void;
  onDelete: (evalCase: EvalCase) => void;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const search = searchParams.get("search") ?? "";
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const bulkDelete = useBulkDeleteEvalCases();

  const filtered = search
    ? cases.filter((evalCase) =>
        [evalCase.name, ...evalCase.messages]
          .join("\n")
          .toLowerCase()
          .includes(search.toLowerCase()),
      )
    : cases;
  const selected = filtered.filter((evalCase) => rowSelection[evalCase.id]);

  const rowActions = (evalCase: EvalCase): TableRowAction[] => [
    {
      label: "Edit",
      icon: <Pencil className="h-4 w-4" />,
      onClick: () => onEdit(evalCase),
    },
    {
      label: "Delete",
      icon: <Trash2 className="h-4 w-4" />,
      className: "text-destructive",
      onClick: () => onDelete(evalCase),
    },
  ];

  const columns: ColumnDef<EvalCase>[] = [
    ...(canUpdate
      ? [
          {
            id: "select",
            size: DATA_TABLE_SELECT_COLUMN_SIZE,
            header: ({ table }) => (
              <Checkbox
                checked={
                  table.getIsAllPageRowsSelected() ||
                  (table.getIsSomePageRowsSelected() && "indeterminate")
                }
                onCheckedChange={(value) =>
                  table.toggleAllPageRowsSelected(!!value)
                }
                aria-label="Select all cases"
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
          } satisfies ColumnDef<EvalCase>,
        ]
      : []),
    {
      accessorKey: "name",
      header: "Name",
      cell: ({ row }) => (
        <span className="font-medium">{row.original.name}</span>
      ),
    },
    {
      id: "message",
      header: "Message",
      cell: ({ row }) => (
        <div className="flex max-w-sm items-center gap-2">
          <span className="text-muted-foreground line-clamp-1">
            {row.original.messages[0]}
          </span>
          {row.original.messages.length > 1 && (
            <Badge variant="secondary" className="shrink-0 text-xs">
              {row.original.messages.length} turns
            </Badge>
          )}
        </div>
      ),
    },
    {
      id: "assertions",
      header: "Assertions",
      cell: ({ row }) => (
        <AssertionChips assertions={row.original.assertions} />
      ),
    },
    {
      id: "actions",
      size: 110,
      header: () => <div className="pr-2 text-right">Actions</div>,
      cell: ({ row }) => {
        if (!canUpdate) return null;
        return (
          <div className="flex justify-end">
            <TableRowActions actions={rowActions(row.original)} />
          </div>
        );
      },
    },
  ];

  const hasActiveFilters = search.length > 0;
  if (!isLoadingError && !isLoading && cases.length === 0) {
    return (
      <EmptyState
        icon={FlaskConical}
        title="No cases yet"
        description='A case is one test: a message you would send the agent, plus assertions its answer must pass. Add one with "Add case", or start from a working example.'
        action={
          canUpdate ? (
            <Button variant="outline" onClick={onAddExample}>
              <Sparkles className="mr-2 h-4 w-4" />
              <span>Start from an example</span>
            </Button>
          ) : undefined
        }
      />
    );
  }

  return (
    <TableCardView storageKey="archestra-eval-cases-view" defaultMode="table">
      <div className="space-y-4">
        <FilterBar
          onClearFilters={
            hasActiveFilters ? () => router.replace(pathname) : undefined
          }
          actions={<TableCardViewToggle order={["table", "cards"]} />}
        >
          <SearchInput
            paramName="search"
            placeholder="Search cases…"
            className={filterSearchClass}
          />
        </FilterBar>

        {selected.length > 0 && (
          <BulkActionsBar
            count={selected.length}
            noun="case"
            onClear={() => setRowSelection({})}
          >
            <Button
              variant="destructive"
              size="sm"
              onClick={() => setBulkDeleteOpen(true)}
            >
              <Trash2 className="mr-1.5 h-3.5 w-3.5" />
              <span>Delete</span>
            </Button>
          </BulkActionsBar>
        )}

        {isLoadingError ? (
          <QueryLoadError title="Couldn't load cases" onRetry={onRetry} />
        ) : (
          <TableCardViewContent
            cards={
              <TableCardList
                itemCount={filtered.length}
                isLoading={isLoading}
                emptyIcon={FlaskConical}
                emptyMessage="No cases yet"
                hasActiveFilters={hasActiveFilters}
                filteredEmptyMessage="No cases match this search."
                onClearFilters={() => router.replace(pathname)}
              >
                {filtered.map((evalCase) => (
                  <TableCard
                    key={evalCase.id}
                    title={evalCase.name}
                    description={evalCase.messages[0]}
                    icon={<FlaskConical className="h-4 w-4" />}
                    selected={!!rowSelection[evalCase.id]}
                    onSelectedChange={
                      canUpdate
                        ? (value) =>
                            setRowSelection((current) => ({
                              ...current,
                              [evalCase.id]: value,
                            }))
                        : undefined
                    }
                    selectionLabel={`Select ${evalCase.name}`}
                    actions={
                      canUpdate ? (
                        <TableRowActions actions={rowActions(evalCase)} />
                      ) : undefined
                    }
                    footer={
                      <span>
                        {evalCase.assertions.length}{" "}
                        {evalCase.assertions.length === 1
                          ? "assertion"
                          : "assertions"}
                        {evalCase.messages.length > 1
                          ? ` · ${evalCase.messages.length} turns`
                          : ""}
                      </span>
                    }
                  >
                    <AssertionChips assertions={evalCase.assertions} />
                  </TableCard>
                ))}
              </TableCardList>
            }
            table={
              <DataTable
                columns={columns}
                data={filtered}
                isLoading={isLoading}
                getRowId={(row) => row.id}
                rowSelection={rowSelection}
                onRowSelectionChange={setRowSelection}
                hideSelectedCount
                emptyMessage={
                  hasActiveFilters
                    ? "No cases match this search."
                    : "No cases yet"
                }
              />
            }
          />
        )}
      </div>

      <DeleteConfirmDialog
        open={bulkDeleteOpen}
        onOpenChange={setBulkDeleteOpen}
        title={`Delete ${selected.length} ${selected.length === 1 ? "case" : "cases"}?`}
        description="Past run results keep their snapshots."
        isPending={bulkDelete.isPending}
        onConfirm={async () => {
          const outcome = await bulkDelete.mutateAsync({
            suiteId,
            ids: selected.map((evalCase) => evalCase.id),
          });
          setBulkDeleteOpen(false);
          // Rows that failed to delete stay selected for a retry.
          const failedIds = outcome?.failed.map((f) => f.id) ?? [];
          setRowSelection(
            Object.fromEntries(failedIds.map((id) => [id, true])),
          );
        }}
      />
    </TableCardView>
  );
}

function AssertionChips({
  assertions,
}: {
  assertions: EvalCase["assertions"];
}) {
  const shown = assertions.slice(0, MAX_ASSERTION_CHIPS);
  return (
    <div className="flex max-w-md flex-wrap gap-1">
      {shown.map((assertion, index) => (
        <Badge
          // biome-ignore lint/suspicious/noArrayIndexKey: assertions have no id
          key={index}
          variant="outline"
          className="max-w-56 text-xs"
        >
          <span className="truncate">{summarizeAssertion(assertion)}</span>
        </Badge>
      ))}
      {assertions.length > MAX_ASSERTION_CHIPS && (
        <Badge variant="outline" className="text-xs">
          +{assertions.length - MAX_ASSERTION_CHIPS} more
        </Badge>
      )}
    </div>
  );
}

// === Runs tab ===

function SuiteRunHistory({
  suiteId,
  focusedGroupId,
}: {
  suiteId: string;
  focusedGroupId: string | null;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const runSearch = searchParams.get("runSearch") ?? "";
  const [status, setStatus] = useState<string>("all");
  const [pagination, setPagination] = useState({
    pageIndex: 0,
    pageSize: DEFAULT_TABLE_LIMIT,
  });

  // A changed filter starts back at the first page of the filtered list.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on filter change
  useEffect(() => {
    setPagination((current) => ({ ...current, pageIndex: 0 }));
  }, [runSearch, status]);

  const runsQuery = useEvalRuns({
    suiteId,
    search: runSearch || undefined,
    status:
      status === "all"
        ? undefined
        : (status as (typeof RUN_STATUS_FILTERS)[number]),
    limit: pagination.pageSize,
    offset: pagination.pageIndex * pagination.pageSize,
    pollWhileActiveMs: RUNS_POLL_INTERVAL_MS,
  });
  const runs = runsQuery.data?.data ?? [];
  const total = runsQuery.data?.pagination.total ?? 0;
  const hasActiveFilters = runSearch.length > 0 || status !== "all";
  const clearFilters = () => {
    setStatus("all");
    router.replace(`${pathname}?tab=runs`);
  };

  // Batches visible on this page: a group id shared by 2+ fetched runs gets a
  // Compare action on its rows. (Page-scoped; a group split across pages is
  // still reachable through the comparison view a batch redirects to.)
  const groupSizes = new Map<string, number>();
  for (const run of runs) {
    groupSizes.set(run.groupId, (groupSizes.get(run.groupId) ?? 0) + 1);
  }

  const rowActions = (run: EvalRun): TableRowAction[] => {
    if ((groupSizes.get(run.groupId) ?? 0) < 2) return [];
    return [
      {
        label: "Compare agents in this batch",
        icon: <GitCompareArrows className="h-4 w-4" />,
        onClick: () => router.push(`${pathname}?tab=runs&group=${run.groupId}`),
      },
    ];
  };

  const columns: ColumnDef<EvalRun>[] = [
    {
      accessorKey: "createdAt",
      header: "Started",
      cell: ({ row }) => (
        <Link
          href={`/evals/runs/${row.original.id}`}
          className="hover:underline"
        >
          {formatDate({ date: row.original.createdAt })}
        </Link>
      ),
    },
    {
      accessorKey: "name",
      header: "Label",
      cell: ({ row }) => (
        <span className="text-muted-foreground">{row.original.name ?? ""}</span>
      ),
    },
    {
      accessorKey: "agentNameSnapshot",
      header: "Agent",
    },
    {
      accessorKey: "status",
      header: "Status",
      cell: ({ row }) => <EvalRunStatusBadge status={row.original.status} />,
    },
    {
      id: "passRate",
      header: "Passed",
      cell: ({ row }) => <PassCell run={row.original} />,
    },
    {
      id: "actions",
      size: 90,
      header: () => <div className="pr-2 text-right">Actions</div>,
      cell: ({ row }) => {
        const actions = rowActions(row.original);
        if (actions.length === 0) return null;
        return (
          <div className="flex justify-end">
            {/* TableRowActions stops propagation itself, keeping row-click nav intact. */}
            <TableRowActions actions={actions} />
          </div>
        );
      },
    },
  ];

  return (
    <TableCardView storageKey="archestra-eval-runs-view" defaultMode="table">
      <div className="space-y-4">
        {focusedGroupId && (
          <RunGroupComparison suiteId={suiteId} groupId={focusedGroupId} />
        )}

        <FilterBar
          onClearFilters={hasActiveFilters ? clearFilters : undefined}
          actions={<TableCardViewToggle order={["table", "cards"]} />}
        >
          <SearchInput
            paramName="runSearch"
            placeholder="Search label or agent…"
            className={filterSearchClass}
          />
          <FilterSelect
            value={status}
            onValueChange={setStatus}
            placeholder="Filter by status"
            items={[
              { value: "all", label: "All statuses" },
              ...RUN_STATUS_FILTERS.map((value) => ({
                value,
                label: value[0].toUpperCase() + value.slice(1),
              })),
            ]}
          />
        </FilterBar>

        {runsQuery.isLoadingError ? (
          <QueryLoadError
            title="Couldn't load runs"
            onRetry={() => runsQuery.refetch()}
          />
        ) : (
          <TableCardViewContent
            cards={
              <TableCardList
                itemCount={runs.length}
                isLoading={runsQuery.isLoading}
                emptyIcon={Play}
                emptyMessage="No runs yet"
                emptyDescription="Run this suite against one or more agents to see graded results here."
                hasActiveFilters={hasActiveFilters}
                filteredEmptyMessage="No runs match these filters."
                onClearFilters={clearFilters}
                pagination={{ ...pagination, total }}
                onPaginationChange={(value) =>
                  setPagination((current) => ({ ...current, ...value }))
                }
              >
                {runs.map((run) => (
                  <TableCard
                    key={run.id}
                    title={
                      <Link
                        href={`/evals/runs/${run.id}`}
                        className="hover:underline"
                      >
                        {run.name ?? formatDate({ date: run.createdAt })}
                      </Link>
                    }
                    description={run.agentNameSnapshot}
                    icon={<Play className="h-4 w-4" />}
                    actions={
                      rowActions(run).length > 0 ? (
                        <TableRowActions actions={rowActions(run)} />
                      ) : undefined
                    }
                    footer={<span>{formatDate({ date: run.createdAt })}</span>}
                  >
                    <div className="flex items-center gap-3">
                      <EvalRunStatusBadge status={run.status} />
                      <PassCell run={run} />
                    </div>
                  </TableCard>
                ))}
              </TableCardList>
            }
            table={
              <DataTable
                columns={columns}
                data={runs}
                isLoading={runsQuery.isLoading}
                manualPagination
                pagination={{ ...pagination, total }}
                onPaginationChange={setPagination}
                onRowClick={(row) => router.push(`/evals/runs/${row.id}`)}
                emptyMessage={
                  hasActiveFilters
                    ? "No runs match these filters."
                    : "No runs yet"
                }
              />
            }
          />
        )}
      </div>
    </TableCardView>
  );
}

/**
 * Side-by-side outcome of the runs started together against several agents:
 * one row per agent with pass rate and cost, the shape a model-comparison
 * report is read in.
 */
function RunGroupComparison({
  suiteId,
  groupId,
}: {
  suiteId: string;
  groupId: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const groupQuery = useEvalRuns({
    suiteId,
    groupId,
    limit: 20,
    offset: 0,
    pollWhileActiveMs: RUNS_POLL_INTERVAL_MS,
  });
  const runs = groupQuery.data?.data ?? [];
  if (runs.length === 0) return null;

  const ranked = [...runs].sort((a, b) => b.passedCases - a.passedCases);
  const label = runs.find((run) => run.name)?.name;

  return (
    <section className="rounded-lg border p-4">
      <div className="mb-3 flex items-center justify-between">
        <div>
          <h2 className="font-semibold">
            Comparison{label ? ` · ${label}` : ""}
          </h2>
          <p className="text-muted-foreground text-xs">
            {runs.length} agents · started{" "}
            {formatDate({ date: runs[runs.length - 1].createdAt })}
          </p>
        </div>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Close comparison"
          onClick={() => router.replace(`${pathname}?tab=runs`)}
        >
          <X className="h-4 w-4" />
        </Button>
      </div>
      <div className="divide-y">
        {ranked.map((run) => (
          <button
            key={run.id}
            type="button"
            className="hover:bg-muted/40 flex w-full items-center gap-3 px-2 py-2 text-left text-sm"
            onClick={() => router.push(`/evals/runs/${run.id}`)}
          >
            <span className="min-w-0 flex-1 truncate font-medium">
              {run.agentNameSnapshot}
            </span>
            {run.modelSnapshot && (
              <span className="text-muted-foreground hidden max-w-48 truncate text-xs md:inline">
                {run.modelSnapshot}
              </span>
            )}
            <EvalRunStatusBadge status={run.status} />
            <PassCell run={run} />
            <RunCostCell runId={run.id} finished={isTerminal(run.status)} />
          </button>
        ))}
      </div>
    </section>
  );
}

function PassCell({ run }: { run: EvalRun }) {
  const finished =
    run.passedCases + run.failedCases + run.erroredCases + run.canceledCases;
  if (finished === 0) {
    return <span className="text-muted-foreground w-20 tabular-nums">—</span>;
  }
  const percent =
    run.totalCases > 0
      ? Math.round((run.passedCases / run.totalCases) * 100)
      : 0;
  return (
    <span className="w-20 tabular-nums">
      {run.passedCases}/{run.totalCases}
      <span className="text-muted-foreground ml-1 text-xs">{percent}%</span>
    </span>
  );
}

/** Read-time cost of one run (settles shortly after the run completes). */
function RunCostCell({
  runId,
  finished,
}: {
  runId: string;
  finished: boolean;
}) {
  const detail = useEvalRun(runId, {
    refetchInterval: finished ? false : RUNS_POLL_INTERVAL_MS,
  });
  if (!detail.data) {
    return <span className="text-muted-foreground w-16 text-xs">…</span>;
  }
  const cost = detail.data.billedCost + detail.data.subscriptionCost;
  return (
    <span className="text-muted-foreground w-16 text-right text-xs tabular-nums">
      ${cost.toFixed(2)}
    </span>
  );
}

function isTerminal(status: EvalRun["status"]): boolean {
  return status === "completed" || status === "failed" || status === "canceled";
}
