"use client";

import type { ColumnDef } from "@tanstack/react-table";
import {
  ArrowLeft,
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
import { useState } from "react";
import { ErrorBoundary } from "@/app/_parts/error-boundary";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { EmptyState } from "@/components/empty-state";
import { PageLayout } from "@/components/page-layout";
import { QueryLoadError } from "@/components/query-load-error";
import {
  type TableRowAction,
  TableRowActions,
} from "@/components/table-row-actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/ui/data-table";
import { DEFAULT_TABLE_LIMIT } from "@/consts";
import { useHasPermissions } from "@/lib/auth/auth.query";
import {
  type EvalCase,
  type EvalRun,
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
const MAX_ASSERTION_CHIPS = 3;

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

  const caseColumns: ColumnDef<EvalCase>[] = [
    {
      accessorKey: "position",
      header: "#",
      size: 40,
      cell: ({ row }) => (
        <span className="text-muted-foreground">{row.original.position}</span>
      ),
    },
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
        <div className="flex max-w-md items-center gap-2">
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
      cell: ({ row }) => {
        const assertions = row.original.assertions;
        const shown = assertions.slice(0, MAX_ASSERTION_CHIPS);
        return (
          <div className="flex flex-wrap gap-1">
            {shown.map((assertion, index) => (
              <Badge
                // biome-ignore lint/suspicious/noArrayIndexKey: assertions have no id
                key={index}
                variant="outline"
                className="max-w-72 text-xs"
              >
                <span className="truncate">
                  {summarizeAssertion(assertion)}
                </span>
              </Badge>
            ))}
            {assertions.length > MAX_ASSERTION_CHIPS && (
              <Badge variant="outline" className="text-xs">
                +{assertions.length - MAX_ASSERTION_CHIPS} more
              </Badge>
            )}
          </div>
        );
      },
    },
    {
      id: "actions",
      cell: ({ row }) => {
        if (!canUpdate) return null;
        const actions: TableRowAction[] = [
          {
            label: "Edit",
            icon: <Pencil className="h-4 w-4" />,
            onClick: () => {
              setCaseTemplate(null);
              setCaseToEdit(row.original);
              setCaseDialogOpen(true);
            },
          },
          {
            label: "Delete",
            icon: <Trash2 className="h-4 w-4" />,
            className: "text-destructive",
            onClick: () => setCaseToDelete(row.original),
          },
        ];
        return <TableRowActions actions={actions} />;
      },
    },
  ];

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
        {
          label: "Runs",
          href: `${pathname}?tab=runs`,
          selected: isRunsTab,
        },
      ]}
      actionButton={
        <div className="flex gap-2">
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
        <section className="space-y-3">
          {cases.length > 0 && canUpdate && (
            <div className="flex justify-end">
              <Button
                variant="outline"
                size="sm"
                onClick={() => openNewCaseDialog(null)}
              >
                <Plus className="mr-1 h-3.5 w-3.5" />
                <span>Add case</span>
              </Button>
            </div>
          )}
          {casesQuery.isLoadingError ? (
            <QueryLoadError
              title="Couldn't load cases"
              onRetry={() => casesQuery.refetch()}
            />
          ) : cases.length === 0 && !casesQuery.isLoading ? (
            <EmptyState
              title="No cases yet"
              description="A case is one test: a message you would send the agent, plus assertions its answer must pass. Runs execute every case and grade the answers."
              action={
                canUpdate ? (
                  <div className="flex gap-2">
                    <Button onClick={() => openNewCaseDialog(null)}>
                      <Plus className="mr-2 h-4 w-4" />
                      <span>Add case</span>
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() => openNewCaseDialog(EXAMPLE_CASE)}
                    >
                      <Sparkles className="mr-2 h-4 w-4" />
                      <span>Start from an example</span>
                    </Button>
                  </div>
                ) : undefined
              }
            />
          ) : (
            <DataTable columns={caseColumns} data={cases} />
          )}
        </section>
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

function SuiteRunHistory({
  suiteId,
  focusedGroupId,
}: {
  suiteId: string;
  focusedGroupId: string | null;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [pagination, setPagination] = useState({
    pageIndex: 0,
    pageSize: DEFAULT_TABLE_LIMIT,
  });

  const runsQuery = useEvalRuns({
    suiteId,
    limit: pagination.pageSize,
    offset: pagination.pageIndex * pagination.pageSize,
    pollWhileActiveMs: RUNS_POLL_INTERVAL_MS,
  });
  const runs = runsQuery.data?.data ?? [];
  const total = runsQuery.data?.pagination.total ?? 0;

  // Batches visible on this page: a group id shared by 2+ fetched runs gets a
  // Compare affordance on its rows.
  const groupSizes = new Map<string, number>();
  for (const run of runs) {
    groupSizes.set(run.groupId, (groupSizes.get(run.groupId) ?? 0) + 1);
  }

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
      id: "compare",
      header: "",
      size: 90,
      cell: ({ row }) => {
        if ((groupSizes.get(row.original.groupId) ?? 0) < 2) return null;
        return (
          <Button
            variant="ghost"
            size="sm"
            onClick={(event) => {
              event.stopPropagation();
              router.push(`${pathname}?tab=runs&group=${row.original.groupId}`);
            }}
          >
            Compare
          </Button>
        );
      },
    },
  ];

  return (
    <div className="space-y-6">
      {focusedGroupId && (
        <RunGroupComparison suiteId={suiteId} groupId={focusedGroupId} />
      )}
      <section className="space-y-3">
        {runsQuery.isLoadingError ? (
          <QueryLoadError
            title="Couldn't load runs"
            onRetry={() => runsQuery.refetch()}
          />
        ) : total === 0 && !runsQuery.isLoading ? (
          <EmptyState
            title="No runs yet"
            description="Run this suite against one or more agents to see graded results here. Runs against several agents are grouped for side-by-side comparison."
          />
        ) : (
          <DataTable
            columns={columns}
            data={runs}
            manualPagination
            pagination={{
              pageIndex: pagination.pageIndex,
              pageSize: pagination.pageSize,
              total,
            }}
            onPaginationChange={setPagination}
            onRowClick={(row) => router.push(`/evals/runs/${row.id}`)}
          />
        )}
      </section>
    </div>
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
