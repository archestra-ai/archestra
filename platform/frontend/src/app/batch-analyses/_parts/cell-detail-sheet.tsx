"use client";

import { AlertCircle, FileText, Loader2, Quote, RefreshCw } from "lucide-react";
import type { PreviewableDocument } from "@/components/files/file-preview-dialog";
import { Badge } from "@/components/ui/badge";
import { PermissionButton } from "@/components/ui/permission-button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  type BatchAnalysisDetail,
  useRetryBatchAnalysisCell,
} from "@/lib/batch-analysis/batch-analysis.query";

type Cell = BatchAnalysisDetail["cells"][number];
type Row = BatchAnalysisDetail["rows"][number];
type Column = BatchAnalysisDetail["analysis"]["columns"][number];

const STATUS_LABELS: Record<string, string> = {
  pending: "Queued",
  generating: "Generating",
  done: "Done",
  error: "Failed",
};

/**
 * The inspect surface for one cell: the answer, the question that produced it,
 * and the verbatim quotes it was drawn from. The quotes are the point — an
 * answer you cannot trace back to source text is not reviewable — so they sit
 * directly under the answer, and the source document itself is one click away
 * when the row was an uploaded file.
 */
export function CellDetailSheet({
  analysisId,
  open,
  onOpenChange,
  row,
  column,
  cell,
  onViewSource,
}: {
  analysisId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  row: Row | undefined;
  column: Column | undefined;
  cell: Cell | undefined;
  /** Called with the row's source file; the parent owns the preview dialog. */
  onViewSource?: (file: PreviewableDocument) => void;
}) {
  const retryCell = useRetryBatchAnalysisCell(analysisId);

  if (!row || !column) return null;

  const citations = cell?.citations ?? [];
  const status = cell?.status ?? "pending";

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="flex w-full flex-col gap-0 overflow-y-auto p-0 sm:max-w-xl">
        <SheetHeader className="shrink-0 border-b px-6 py-4">
          <SheetTitle className="pr-8">{column.name}</SheetTitle>
          <SheetDescription className="flex items-center gap-1.5">
            {row.sourceFile && <FileText className="h-3.5 w-3.5 shrink-0" />}
            <span className="truncate">{row.label}</span>
          </SheetDescription>
          <div className="flex items-center gap-2 pt-1">
            <Badge
              variant={
                status === "error"
                  ? "destructive"
                  : status === "done"
                    ? "secondary"
                    : "outline"
              }
              className="gap-1"
            >
              {status === "generating" && (
                <Loader2 className="h-3 w-3 animate-spin" />
              )}
              {STATUS_LABELS[status] ?? status}
            </Badge>
            <Badge variant="outline">
              {column.format === "exact_quote" ? "exact quote" : column.format}
            </Badge>
          </div>
        </SheetHeader>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-6 py-5">
          {status === "error" ? (
            <section className="space-y-1.5">
              <SectionLabel>Error</SectionLabel>
              <div className="flex gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                <p className="whitespace-pre-wrap text-sm">
                  {cell?.error ?? "This cell failed without a reported reason."}
                </p>
              </div>
            </section>
          ) : (
            <section className="space-y-1.5">
              <SectionLabel>Answer</SectionLabel>
              {cell?.content ? (
                <p className="whitespace-pre-wrap text-sm leading-relaxed">
                  {cell.content}
                </p>
              ) : (
                <p className="text-muted-foreground text-sm">
                  Not generated yet. Run the analysis to fill this cell in.
                </p>
              )}
            </section>
          )}

          {citations.length > 0 && (
            <section className="space-y-2">
              <SectionLabel>Supporting text</SectionLabel>
              {citations.map((citation) => (
                <figure
                  key={citation.quote}
                  className="flex gap-2 rounded-md bg-muted/50 p-3"
                >
                  <Quote className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <blockquote className="text-sm leading-relaxed">
                    {citation.quote}
                  </blockquote>
                </figure>
              ))}
            </section>
          )}

          <section className="space-y-1.5">
            <SectionLabel>Question</SectionLabel>
            <p className="whitespace-pre-wrap rounded-md bg-muted/50 p-3 text-muted-foreground text-sm">
              {column.prompt}
            </p>
          </section>
        </div>

        <div className="flex shrink-0 items-center justify-between gap-2 border-t px-6 py-3">
          {row.sourceFile && onViewSource ? (
            <button
              type="button"
              className="flex min-w-0 items-center gap-1.5 text-muted-foreground text-sm underline-offset-4 hover:text-foreground hover:underline"
              onClick={() =>
                row.sourceFile &&
                onViewSource({
                  name: row.sourceFile.filename,
                  mimeType: row.sourceFile.mimeType,
                  contentUrl: `/api/knowledge-files/${row.sourceFile.id}/content`,
                })
              }
            >
              <FileText className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate">View source document</span>
            </button>
          ) : (
            <span />
          )}
          {cell && status !== "generating" && (
            <PermissionButton
              permissions={{ batchAnalysis: ["execute"] }}
              variant="outline"
              size="sm"
              disabled={retryCell.isPending}
              onClick={() =>
                retryCell.mutate({ rowId: row.id, columnKey: column.key })
              }
            >
              <RefreshCw className="mr-1 h-3 w-3" />
              <span>{retryCell.isPending ? "Queueing…" : "Regenerate"}</span>
            </PermissionButton>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
      {children}
    </p>
  );
}
