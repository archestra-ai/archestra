"use client";

import {
  AlertCircle,
  ArrowLeft,
  FileText,
  Loader2,
  Pencil,
  Play,
  Plus,
  Quote,
  Trash2,
} from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useMemo, useState } from "react";
import { AddRowsDialog } from "@/app/batch-analyses/_parts/add-rows-dialog";
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
import { cn } from "@/lib/utils";

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

/**
 * One grid cell. The status carries as much meaning as the content here — a
 * blank cell that is queued and a blank cell that failed are different facts,
 * and the whole point of the table is being able to see which is which at a
 * glance across hundreds of rows.
 */
function CellContent({ cell }: { cell: Cell | undefined }) {
  if (!cell || cell.status === "pending") {
    return <span className="text-muted-foreground text-xs">—</span>;
  }
  if (cell.status === "generating") {
    return (
      <span className="inline-flex items-center gap-1 text-muted-foreground text-xs">
        <Loader2 className="h-3 w-3 animate-spin" />
        <span>Working…</span>
      </span>
    );
  }
  if (cell.status === "error") {
    return (
      <span className="inline-flex items-center gap-1 text-destructive text-xs">
        <AlertCircle className="h-3 w-3 shrink-0" />
        <span>Failed</span>
      </span>
    );
  }
  return (
    <span className="flex items-start gap-1">
      <span className="line-clamp-3 whitespace-pre-wrap text-sm">
        {cell.content}
      </span>
      {(cell.citations?.length ?? 0) > 0 && (
        <Quote className="mt-0.5 h-3 w-3 shrink-0 text-muted-foreground" />
      )}
    </span>
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
        <div className="max-h-[calc(100vh-16rem)] overflow-auto rounded-md border">
          <table className="w-full border-collapse text-left">
            <thead className="sticky top-0 z-10 bg-muted">
              <tr>
                <th className="min-w-[200px] max-w-[280px] border-r p-3 font-medium text-sm">
                  Source
                </th>
                {analysis.columns.map((column) => (
                  <th
                    key={column.key}
                    className="min-w-[220px] border-r p-3 font-medium text-sm last:border-r-0"
                  >
                    <span className="block">{column.name}</span>
                    <span className="block font-normal text-muted-foreground text-xs">
                      {column.format === "exact_quote"
                        ? "exact quote"
                        : column.format}
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className="group/row border-t align-top">
                  <td className="max-w-[280px] border-r p-3">
                    <div className="flex items-start gap-1">
                      <div className="min-w-0 flex-1">
                        {row.sourceFile ? (
                          // An uploaded source stays inspectable: the label opens
                          // the file itself, so an odd answer can be checked
                          // against the actual document without leaving the grid.
                          <button
                            type="button"
                            className="flex w-full items-start gap-1.5 text-left"
                            onClick={() =>
                              row.sourceFile &&
                              setPreviewFile({
                                name: row.sourceFile.filename,
                                mimeType: row.sourceFile.mimeType,
                                contentUrl: `/api/knowledge-files/${row.sourceFile.id}/content`,
                              })
                            }
                          >
                            <FileText className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                            <span className="line-clamp-2 min-w-0 break-words font-medium text-sm underline-offset-4 hover:underline">
                              {row.label}
                            </span>
                          </button>
                        ) : (
                          <span className="line-clamp-2 break-words font-medium text-sm">
                            {row.label}
                          </span>
                        )}
                      </div>
                      {/* Revealed on row hover so 200 rows of trash cans
                          don't compete with the data. Removing a row removes
                          its answers with it. */}
                      <PermissionButton
                        permissions={{ batchAnalysis: ["update"] }}
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6 shrink-0 text-muted-foreground opacity-0 transition-opacity hover:text-destructive focus-visible:opacity-100 group-hover/row:opacity-100"
                        aria-label={`Remove ${row.label}`}
                        tooltip="Remove row"
                        disabled={deleteRow.isPending}
                        onClick={() => deleteRow.mutate(row.id)}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </PermissionButton>
                    </div>
                  </td>
                  {analysis.columns.map((column) => {
                    const cell = cellsByRowAndColumn.get(
                      `${row.id}:${column.key}`,
                    );
                    return (
                      <td
                        key={column.key}
                        className={cn(
                          "border-r p-0 last:border-r-0",
                          cell?.status === "error" && "bg-destructive/5",
                        )}
                      >
                        {/* A button, not a click handler on the cell: opening
                            the detail sheet has to be reachable by keyboard. */}
                        <button
                          type="button"
                          className="h-full w-full cursor-pointer p-3 text-left transition-colors hover:bg-accent"
                          onClick={() =>
                            setSelected({ row, columnKey: column.key })
                          }
                        >
                          <CellContent cell={cell} />
                        </button>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
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
