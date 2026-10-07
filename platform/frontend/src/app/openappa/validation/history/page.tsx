"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { History } from "lucide-react";
import { useState } from "react";
import { PageBackLink } from "@/components/page-back-link";
import { QueryLoadError } from "@/components/query-load-error";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/ui/data-table";
import type { PolicyTestRun } from "@/lib/openappa-policy-tests.query";
import { formatDate } from "@/lib/utils/date-time";
import { RunDetailsDialog } from "../_parts/run-details-dialog";
import { useValidation } from "../_parts/validation-context";
import { ValidationRunOutcome } from "../_parts/validation-parts";

export default function ValidationHistoryPage() {
  const { history, listHref } = useValidation();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selectedRun =
    history.data?.find((run) => run.id === selectedId) ?? null;
  const columns: ColumnDef<PolicyTestRun>[] = [
    {
      accessorKey: "createdAt",
      header: "Run",
      cell: ({ row }) => (
        <Button
          variant="link"
          size="sm"
          className="-ml-3 text-foreground hover:no-underline"
          onClick={(event) => {
            event.stopPropagation();
            setSelectedId(row.original.id);
          }}
        >
          {formatDate({ date: row.original.createdAt })}
        </Button>
      ),
    },
    ...detailColumns,
  ];
  return (
    <div className="space-y-4">
      <PageBackLink href={listHref}>
        <span>Back to validation</span>
      </PageBackLink>
      {history.isError ? (
        <QueryLoadError
          title="Could not load run history"
          onRetry={() => history.refetch()}
        />
      ) : (
        <DataTable
          columns={columns}
          data={history.data ?? []}
          getRowId={(run) => run.id}
          onRowClick={(run) => setSelectedId(run.id)}
          isLoading={history.isLoading}
          emptyIcon={History}
          emptyMessage="No runs yet."
          hidePaginationWhenSinglePage
          tableClassName="min-w-[640px]"
        />
      )}
      <RunDetailsDialog run={selectedRun} onClose={() => setSelectedId(null)} />
    </div>
  );
}

const detailColumns: ColumnDef<PolicyTestRun>[] = [
  {
    accessorKey: "policyRevision",
    header: "Policy",
    cell: ({ row }) => <span>Revision {row.original.policyRevision}</span>,
  },
  {
    id: "results",
    header: "Results",
    cell: ({ row }) => <ValidationRunOutcome run={row.original} />,
  },
  {
    id: "inputs",
    header: "Inputs",
    cell: ({ row }) => (
      <div className="flex flex-wrap gap-2">
        <Badge variant="outline">
          {row.original.source === "github" ? "GitHub" : "Local"}
        </Badge>
        {row.original.trigger === "github_sync" && (
          <Badge variant="outline">Git sync run</Badge>
        )}
        {row.original.trigger === "policy_change" && (
          <Badge variant="outline">Policy change run</Badge>
        )}
        {row.original.draft && <Badge variant="secondary">Draft run</Badge>}
        {row.original.stale && <Badge variant="outline">Stale inputs</Badge>}
      </div>
    ),
  },
];
