"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { FlaskConical, Plus, Trash2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
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
  type EvalSuite,
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

function EvalSuitesList() {
  const router = useRouter();
  const [pagination, setPagination] = useState({
    pageIndex: 0,
    pageSize: DEFAULT_TABLE_LIMIT,
  });
  const [createOpen, setCreateOpen] = useState(false);
  const [suiteToDelete, setSuiteToDelete] = useState<EvalSuite | null>(null);

  const { data: canCreate } = useHasPermissions({ eval: ["create"] });
  const { data: canDelete } = useHasPermissions({ eval: ["delete"] });

  const suitesQuery = useEvalSuites({
    limit: pagination.pageSize,
    offset: pagination.pageIndex * pagination.pageSize,
  });
  const deleteSuite = useDeleteEvalSuite();

  const suites = suitesQuery.data?.data ?? [];
  const total = suitesQuery.data?.pagination.total ?? 0;

  const columns: ColumnDef<EvalSuite>[] = [
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
      cell: ({ row }) => {
        const actions: TableRowAction[] = [
          ...(canDelete
            ? [
                {
                  label: "Delete",
                  icon: <Trash2 className="h-4 w-4" />,
                  className: "text-destructive",
                  onClick: () => setSuiteToDelete(row.original),
                },
              ]
            : []),
        ];
        return actions.length > 0 ? (
          <TableRowActions actions={actions} />
        ) : null;
      },
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
      {suitesQuery.isLoadingError ? (
        <QueryLoadError
          title="Couldn't load eval suites"
          onRetry={() => suitesQuery.refetch()}
        />
      ) : total === 0 && !suitesQuery.isLoading ? (
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
        <DataTable
          columns={columns}
          data={suites}
          manualPagination
          pagination={{
            pageIndex: pagination.pageIndex,
            pageSize: pagination.pageSize,
            total,
          }}
          onPaginationChange={setPagination}
          onRowClick={(row) => router.push(`/evals/${row.id}`)}
        />
      )}

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
    </PageLayout>
  );
}
