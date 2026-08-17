"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { Pencil, Table2, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { EditAnalysisDialog } from "@/app/batch-analyses/_parts/edit-analysis-dialog";
import { PageLayout } from "@/components/page-layout";
import { QueryLoadError } from "@/components/query-load-error";
import { ResourceVisibilityBadge } from "@/components/resource-visibility-badge";
import { SearchInput } from "@/components/search-input";
import { TableRowActions } from "@/components/table-row-actions";
import { Badge } from "@/components/ui/badge";
import { DataTable } from "@/components/ui/data-table";
import { PermissionButton } from "@/components/ui/permission-button";
import { useSession } from "@/lib/auth/auth.query";
import {
  type BatchAnalysisSummary,
  useBatchAnalyses,
  useDeleteBatchAnalysis,
} from "@/lib/batch-analysis/batch-analysis.query";
import { useDataTableQueryParams } from "@/lib/hooks/use-data-table-query-params";
import { useTeams } from "@/lib/teams/team.query";
import { formatRelativeTimeFromNow } from "@/lib/utils/date-time";

const PAGE_DESCRIPTION =
  "Ask the same set of questions of every source in a set and get a table back — one row per source, one column per question, each answer traceable to the text it came from.";

/** The same labelled badge the rest of the app uses for who-can-see-this. */
function VisibilityCell({ analysis }: { analysis: BatchAnalysisSummary }) {
  const { data: teams } = useTeams();
  const { data: session } = useSession();

  return (
    <ResourceVisibilityBadge
      scope={analysis.scope}
      teams={(teams ?? []).filter((team) => analysis.teamIds.includes(team.id))}
      authorId={analysis.createdBy}
      authorName={undefined}
      currentUserId={session?.user?.id}
      // A personal analysis is only ever listed to its creator, so "Me" is
      // always accurate — and without it their row is a blank cell beside
      // labelled Organization and Team ones.
      showSelfAsMe
    />
  );
}

export default function BatchAnalysesPage() {
  const router = useRouter();
  const { pageIndex, pageSize, offset, setPagination, updateQueryParams } =
    useDataTableQueryParams();
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<BatchAnalysisSummary>();

  const { data, isLoading, isLoadingError, refetch } = useBatchAnalyses({
    limit: pageSize,
    offset,
    search: search || undefined,
  });
  const deleteAnalysis = useDeleteBatchAnalysis();

  const analyses = useMemo(() => data?.data ?? [], [data?.data]);

  const columns: ColumnDef<BatchAnalysisSummary>[] = useMemo(
    () => [
      {
        accessorKey: "name",
        header: "Name",
        size: 34,
        minSize: 200,
        cell: ({ row }) => (
          <span className="font-medium">{row.original.name}</span>
        ),
      },
      {
        id: "columns",
        header: "Columns",
        size: 14,
        minSize: 110,
        cell: ({ row }) => {
          const count = row.original.columns.length;
          return (
            <span className="text-muted-foreground">
              {count} {count === 1 ? "question" : "questions"}
            </span>
          );
        },
      },
      {
        id: "visibility",
        header: "Visibility",
        size: 16,
        minSize: 130,
        cell: ({ row }) => <VisibilityCell analysis={row.original} />,
      },
      {
        accessorKey: "updatedAt",
        header: "Last updated",
        size: 16,
        minSize: 120,
        cell: ({ row }) => (
          <span className="whitespace-nowrap text-muted-foreground">
            {formatRelativeTimeFromNow(row.original.updatedAt)}
          </span>
        ),
      },
      {
        id: "actions",
        header: "Actions",
        // Pixel-sized like every other table's actions column, so the icon
        // buttons never clip while the sized columns scale.
        size: 110,
        enableHiding: false,
        cell: ({ row }) => (
          <TableRowActions
            itemName={row.original.name}
            actions={[
              {
                icon: <Pencil className="h-4 w-4" />,
                label: "Edit",
                permissions: { batchAnalysis: ["update"] },
                onClick: () => setEditing(row.original),
              },
              {
                icon: <Trash2 className="h-4 w-4" />,
                label: "Delete",
                variant: "destructive",
                permissions: { batchAnalysis: ["delete"] },
                onClick: () => deleteAnalysis.mutate(row.original.id),
              },
            ]}
          />
        ),
      },
    ],
    [deleteAnalysis],
  );

  const header = (
    <span className="flex items-center gap-2">
      Batch Analyses
      <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">
        Beta
      </Badge>
    </span>
  );

  return (
    <PageLayout
      title={header}
      documentTitle="Batch Analyses"
      description={PAGE_DESCRIPTION}
      actionButton={
        <PermissionButton
          permissions={{ batchAnalysis: ["create"] }}
          onClick={() => router.push("/batch-analyses/new")}
        >
          <span>New Analysis</span>
        </PermissionButton>
      }
    >
      <div className="space-y-3">
        <SearchInput
          value={search}
          onSearchChange={(value) => {
            setSearch(value);
            updateQueryParams({ page: "1" });
          }}
          // The term lives in local state and the page reset is handled here,
          // so the component's own query-param sync would only add a second
          // router push per keystroke.
          syncQueryParams={false}
          placeholder="Search analyses…"
          className="w-full max-w-sm"
        />

        {isLoadingError ? (
          <QueryLoadError
            title="Could not load analyses"
            onRetry={() => refetch()}
          />
        ) : (
          <DataTable
            columns={columns}
            data={analyses}
            isLoading={isLoading}
            emptyIcon={<Table2 className="h-10 w-10" />}
            emptyMessage="No analyses yet. Create one to ask a fixed set of questions of every source you add."
            getRowId={(analysis) => analysis.id}
            onRowClick={(analysis) =>
              router.push(`/batch-analyses/${analysis.id}`)
            }
            manualPagination
            pagination={{
              pageIndex,
              pageSize,
              total: data?.pagination?.total ?? 0,
            }}
            onPaginationChange={setPagination}
          />
        )}
      </div>

      <EditAnalysisDialog
        open={!!editing}
        onOpenChange={(next) => !next && setEditing(undefined)}
        analysis={editing}
      />
    </PageLayout>
  );
}
