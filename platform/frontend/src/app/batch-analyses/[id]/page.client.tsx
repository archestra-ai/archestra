"use client";

import { ArrowLeft, Loader2, Pencil, Play, Plus } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useMemo, useRef, useState } from "react";
import type { DataGridHandle } from "react-data-grid";
import { AddRowsDialog } from "@/app/batch-analyses/_parts/add-rows-dialog";
import { AnalysisGrid } from "@/app/batch-analyses/_parts/analysis-grid";
import { CellDetailSheet } from "@/app/batch-analyses/_parts/cell-detail-sheet";
import { EditAnalysisDialog } from "@/app/batch-analyses/_parts/edit-analysis-dialog";
import {
  FilePreviewDialog,
  type PreviewableDocument,
} from "@/components/files/file-preview-dialog";
import { PageLayout } from "@/components/page-layout";
import { QueryLoadError } from "@/components/query-load-error";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { PermissionButton } from "@/components/ui/permission-button";
import {
  type BatchAnalysisDetail,
  useBatchAnalysis,
  useDeleteBatchAnalysisRow,
  useStartBatchAnalysisRun,
} from "@/lib/batch-analysis/batch-analysis.query";

type Cell = BatchAnalysisDetail["cells"][number];
type Row = BatchAnalysisDetail["rows"][number];

const RUN_STATUS_LABELS: Record<string, string> = {
  running: "Running",
  success: "Completed",
  completed_with_errors: "Completed with errors",
  failed: "Failed",
  cancelled: "Cancelled",
};

function runStatusVariant(
  status: string | undefined,
): "default" | "secondary" | "destructive" | "outline" {
  if (status === "failed") return "destructive";
  if (status === "completed_with_errors") return "outline";
  if (status === "success") return "secondary";
  return "default";
}

function BackToAnalysesLink() {
  return (
    <Button
      variant="ghost"
      size="sm"
      className="-ml-2 text-muted-foreground"
      asChild
    >
      <Link href="/batch-analyses">
        <ArrowLeft className="h-4 w-4" />
        Batch Analyses
      </Link>
    </Button>
  );
}

export default function BatchAnalysisDetailPage() {
  const params = useParams<{ id: string }>();
  const analysisId = params.id;
  const [addRowsOpen, setAddRowsOpen] = useState(false);
  const [previewFile, setPreviewFile] = useState<PreviewableDocument>();
  const [editOpen, setEditOpen] = useState(false);
  const [selected, setSelected] = useState<{
    row: Row;
    columnKey: string;
  } | null>(null);
  const gridRef = useRef<DataGridHandle>(null);

  const { data, isLoading, isLoadingError, refetch } =
    useBatchAnalysis(analysisId);
  const startRun = useStartBatchAnalysisRun(analysisId);
  const deleteRow = useDeleteBatchAnalysisRow(analysisId);

  // Cells arrive as a flat list; the grid needs them addressable by
  // (row, column) so lookup stays O(1) as the set grows.
  const cellsByRowAndColumn = useMemo(() => {
    const map = new Map<string, Cell>();
    for (const cell of data?.cells ?? []) {
      map.set(`${cell.rowId}:${cell.columnKey}`, cell);
    }
    return map;
  }, [data?.cells]);

  const progress = useMemo(() => {
    const cells = data?.cells ?? [];
    const done = cells.filter((cell) => cell.status === "done").length;
    const errored = cells.filter((cell) => cell.status === "error").length;
    return { done, errored, total: cells.length };
  }, [data?.cells]);

  if (isLoadingError) {
    return (
      <PageLayout
        title="Analysis"
        description=""
        backLink={<BackToAnalysesLink />}
      >
        <QueryLoadError
          title="Could not load this analysis"
          onRetry={() => refetch()}
        />
      </PageLayout>
    );
  }
  if (isLoading) {
    return (
      <PageLayout
        title="Analysis"
        description=""
        backLink={<BackToAnalysesLink />}
      >
        <p className="text-muted-foreground text-sm">Loading…</p>
      </PageLayout>
    );
  }
  if (!data) {
    return (
      <PageLayout
        title="Analysis"
        description=""
        backLink={<BackToAnalysesLink />}
      >
        <p className="text-muted-foreground text-sm">Not found.</p>
      </PageLayout>
    );
  }

  const { analysis, rows, latestRun } = data;
  const isRunning = latestRun?.status === "running";
  const selectedCell = selected
    ? cellsByRowAndColumn.get(`${selected.row.id}:${selected.columnKey}`)
    : undefined;

  const description = (
    <span className="flex flex-wrap items-center gap-2">
      <span>
        {rows.length} {rows.length === 1 ? "row" : "rows"} ×{" "}
        {analysis.columns.length}{" "}
        {analysis.columns.length === 1 ? "column" : "columns"}
      </span>
      {latestRun && (
        <Badge variant={runStatusVariant(latestRun.status)}>
          {RUN_STATUS_LABELS[latestRun.status] ?? latestRun.status}
        </Badge>
      )}
      {progress.total > 0 && (
        <span>
          {progress.done}/{progress.total} cells
        </span>
      )}
      {/* Its own element, not a bare conditional text node: a text node
          created and destroyed on a condition flip is what crashes the
          page under machine translation. */}
      {progress.errored > 0 && <span>{`· ${progress.errored} failed`}</span>}
    </span>
  );

  return (
    <PageLayout
      title={analysis.name}
      description={description}
      backLink={<BackToAnalysesLink />}
      actionButton={
        <div className="flex shrink-0 gap-2">
          <PermissionButton
            permissions={{ batchAnalysis: ["update"] }}
            variant="outline"
            onClick={() => setEditOpen(true)}
          >
            <Pencil className="mr-1 h-4 w-4" />
            <span>Edit</span>
          </PermissionButton>
          <PermissionButton
            permissions={{ batchAnalysis: ["update"] }}
            variant="outline"
            onClick={() => setAddRowsOpen(true)}
          >
            <Plus className="mr-1 h-4 w-4" />
            <span>Add rows</span>
          </PermissionButton>
          <PermissionButton
            permissions={{ batchAnalysis: ["execute"] }}
            onClick={() => startRun.mutate()}
            disabled={isRunning || rows.length === 0 || startRun.isPending}
          >
            {isRunning ? (
              <Loader2 className="mr-1 h-4 w-4 animate-spin" />
            ) : (
              <Play className="mr-1 h-4 w-4" />
            )}
            <span>{isRunning ? "Running…" : "Run analysis"}</span>
          </PermissionButton>
        </div>
      }
    >
      {rows.length === 0 ? (
        <Card className="flex flex-col items-center gap-3 p-10 text-center">
          <p className="font-medium">No rows yet</p>
          <p className="max-w-md text-muted-foreground text-sm">
            Add the sources you want analysed. Each one becomes a row, and every
            column question is asked of it.
          </p>
          <PermissionButton
            permissions={{ batchAnalysis: ["update"] }}
            variant="outline"
            onClick={() => setAddRowsOpen(true)}
          >
            <span>Add rows</span>
          </PermissionButton>
        </Card>
      ) : (
        <AnalysisGrid
          gridRef={gridRef}
          columns={analysis.columns}
          rows={rows}
          cellsByRowAndColumn={cellsByRowAndColumn}
          onSelectCell={(row, columnKey) => setSelected({ row, columnKey })}
          onPreviewFile={setPreviewFile}
          onDeleteRow={(rowId) => deleteRow.mutate(rowId)}
          deleteRowDisabled={deleteRow.isPending}
        />
      )}

      <AddRowsDialog
        analysisId={analysisId}
        open={addRowsOpen}
        onOpenChange={setAddRowsOpen}
      />
      <CellDetailSheet
        analysisId={analysisId}
        open={!!selected}
        onOpenChange={(open) => !open && setSelected(null)}
        row={selected?.row}
        column={analysis.columns.find((c) => c.key === selected?.columnKey)}
        cell={selectedCell}
        onViewSource={(file) => setPreviewFile(file)}
        // A controlled sheet has no trigger to give focus back to, so Radix
        // would drop it on <body> and the grid's keyboard navigation would go
        // dead. Hand focus back to the active cell instead.
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          gridRef.current?.element
            ?.querySelector<HTMLElement>('[tabindex="0"]')
            ?.focus();
        }}
      />
      <FilePreviewDialog
        open={!!previewFile}
        onOpenChange={(open) => !open && setPreviewFile(undefined)}
        file={previewFile}
      />
      <EditAnalysisDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        analysis={analysis}
      />
    </PageLayout>
  );
}
