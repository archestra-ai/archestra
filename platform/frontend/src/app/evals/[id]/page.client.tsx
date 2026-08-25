"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { ArrowLeft, Pencil, Play, Plus, Trash2 } from "lucide-react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
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
  useDeleteEvalCase,
  useEvalRuns,
  useEvalSuite,
  useEvalSuiteCases,
} from "@/lib/evals/eval.query";
import { formatDate } from "@/lib/utils";
import { EvalCaseDialog } from "../_parts/eval-case-dialog";
import { EvalRunDialog } from "../_parts/eval-run-dialog";
import { EvalRunStatusBadge } from "../_parts/eval-run-status-badge";
import { EvalSuiteDialog } from "../_parts/eval-suite-dialog";

const RUNS_POLL_INTERVAL_MS = 5000;

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

  const [caseDialogOpen, setCaseDialogOpen] = useState(false);
  const [caseToEdit, setCaseToEdit] = useState<EvalCase | null>(null);
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
      accessorKey: "input",
      header: "Input",
      cell: ({ row }) => (
        <span className="text-muted-foreground line-clamp-1 max-w-md">
          {row.original.input}
        </span>
      ),
    },
    {
      id: "assertions",
      header: "Assertions",
      cell: ({ row }) => (
        <div className="flex flex-wrap gap-1">
          {row.original.assertions.map((assertion, index) => (
            <Badge
              // biome-ignore lint/suspicious/noArrayIndexKey: assertions have no id
              key={index}
              variant="outline"
              className="text-xs"
            >
              {assertion.type}
            </Badge>
          ))}
        </div>
      ),
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
      <div className="space-y-8">
        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold">Cases</h2>
            {canUpdate && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setCaseToEdit(null);
                  setCaseDialogOpen(true);
                }}
              >
                <Plus className="mr-1 h-3.5 w-3.5" />
                <span>Add case</span>
              </Button>
            )}
          </div>
          {casesQuery.isLoadingError ? (
            <QueryLoadError
              title="Couldn't load cases"
              onRetry={() => casesQuery.refetch()}
            />
          ) : cases.length === 0 && !casesQuery.isLoading ? (
            <EmptyState
              title="No cases yet"
              description="Add a case: an input for the agent plus assertions its answer must satisfy."
            />
          ) : (
            <DataTable columns={caseColumns} data={cases} />
          )}
        </section>

        <SuiteRunHistory suiteId={suiteId} />
      </div>

      <EvalCaseDialog
        open={caseDialogOpen}
        onOpenChange={(open) => {
          setCaseDialogOpen(open);
          if (!open) setCaseToEdit(null);
        }}
        suiteId={suiteId}
        evalCase={caseToEdit}
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

function SuiteRunHistory({ suiteId }: { suiteId: string }) {
  const router = useRouter();
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

  type Run = (typeof runs)[number];
  const columns: ColumnDef<Run>[] = [
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
      cell: ({ row }) => {
        const run = row.original;
        const finished =
          run.passedCases +
          run.failedCases +
          run.erroredCases +
          run.canceledCases;
        return (
          <span className="tabular-nums">
            {finished === 0 ? "—" : `${run.passedCases}/${run.totalCases}`}
          </span>
        );
      },
    },
  ];

  return (
    <section className="space-y-3">
      <h2 className="text-lg font-semibold">Runs</h2>
      {runsQuery.isLoadingError ? (
        <QueryLoadError
          title="Couldn't load runs"
          onRetry={() => runsQuery.refetch()}
        />
      ) : total === 0 && !runsQuery.isLoading ? (
        <EmptyState
          title="No runs yet"
          description="Run this suite against an agent to see graded results here."
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
  );
}
