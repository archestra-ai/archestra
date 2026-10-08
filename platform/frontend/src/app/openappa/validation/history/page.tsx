"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { History, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { PageBackLink } from "@/components/page-back-link";
import { QueryLoadError } from "@/components/query-load-error";
import { StandardDialog } from "@/components/standard-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/ui/data-table";
import { InlineNotice, InlineNoticeText } from "@/components/ui/inline-notice";
import type { PolicyTestRun } from "@/lib/openappa-policy-tests.query";
import { formatDate } from "@/lib/utils/date-time";
import { useValidation } from "../_parts/validation-context";
import {
  StepResults,
  statusLabel,
  ValidationRunDiagnostics,
  ValidationRunOutcome,
  ValidationStatusBadge,
} from "../_parts/validation-parts";

export default function ValidationHistoryPage() {
  const { history } = useValidation();
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
      <PageBackLink href="/openappa/validation">
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

function RunDetailsDialog({
  run,
  onClose,
}: {
  run: PolicyTestRun | null;
  onClose: () => void;
}) {
  return (
    <StandardDialog
      open={run !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title="Validation run details"
      description={
        run
          ? `${formatDate({ date: run.createdAt })} · Policy revision ${run.policyRevision}`
          : undefined
      }
      size="large"
      footer={
        <Button variant="outline" onClick={onClose}>
          Close
        </Button>
      }
    >
      {run && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <ValidationRunOutcome run={run} />
            {run.draft && <Badge variant="secondary">Draft run</Badge>}
            {run.stale && <Badge variant="outline">Stale inputs</Badge>}
          </div>
          <ValidationRunDiagnostics run={run} />
          {run.files.map((file) => (
            <section
              key={file.path}
              aria-label={file.path}
              className="space-y-2 rounded-md border p-4"
            >
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="break-all font-mono text-sm font-medium">
                  {file.path}
                </h3>
                <ValidationStatusBadge status={file.status} />
              </div>
              <p className="text-xs text-muted-foreground">{`${file.steps.length} of ${file.assertionCount} assertions evaluated`}</p>
              {file.status === "passed" && (
                <p className="text-sm">
                  All evaluated assertions matched their expected decisions.
                </p>
              )}
              {file.status === "failed" && (
                <p className="text-sm">
                  An actual decision differed from its expectation.
                </p>
              )}
              {file.error && (
                <InlineNotice
                  variant={file.status === "cannot_run" ? "warning" : "error"}
                >
                  <TriangleAlert />
                  <span className="font-medium">
                    {statusLabel(file.status)}
                  </span>
                  <InlineNoticeText>{file.error}</InlineNoticeText>
                </InlineNotice>
              )}
              {file.steps.length > 0 ? (
                <StepResults steps={file.steps} />
              ) : (
                !file.error && (
                  <p className="text-sm">No assertion details were recorded.</p>
                )
              )}
            </section>
          ))}
        </div>
      )}
    </StandardDialog>
  );
}
