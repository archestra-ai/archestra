// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
// SPDX-FileCopyrightText: 2026 Archestra Inc.

"use client";

import { useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  Download,
  ExternalLink,
  Loader2,
  Play,
  RefreshCw,
  Search,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export type DocReviewCitation = {
  quote: string;
  ref?: string;
  documentId?: string;
  title?: string;
  sourceUrl?: string | null;
};

export type DocReviewGridCell = {
  id: string;
  rowId: string;
  columnId: string;
  documentId: string;
  status: "pending" | "generating" | "completed" | "error";
  value: unknown;
  citations: DocReviewCitation[];
  error?: string | null;
  tokensUsed?: number | null;
};

export type DocReviewGridRow = {
  id: string;
  documentId: string;
  documentTitle: string;
  documentSourceUrl?: string | null;
  status: "pending" | "processing" | "completed" | "failed";
  cells: Record<string, DocReviewGridCell>;
};

export type DocReviewColumn = {
  id: string;
  title: string;
  prompt: string;
  outputFormat: "text" | "yes_no" | "date" | "number" | "list" | "json";
};

export type DocReviewGridData = {
  review: {
    id: string;
    name: string;
    description?: string | null;
    status: "pending" | "running" | "completed" | "failed" | "cancelled";
    totalRows: number;
    completedRows: number;
    totalCells: number;
    completedCells: number;
    failedCells: number;
  };
  columns: DocReviewColumn[];
  rows: DocReviewGridRow[];
};

export function DocReviewGrid({
  data,
  onRefresh,
  onResume,
  onRetryCell,
}: {
  data: DocReviewGridData;
  onRefresh: () => void;
  onResume: () => void;
  onRetryCell: (cellId: string) => void;
}) {
  const { review, columns, rows } = data;
  const [search, setSearch] = useState("");
  const [selectedCell, setSelectedCell] = useState<{
    cell: DocReviewGridCell;
    column: DocReviewColumn;
    row: DocReviewGridRow;
  } | null>(null);

  const filteredRows = rows.filter((r) =>
    r.documentTitle.toLowerCase().includes(search.toLowerCase()),
  );

  const progressPercent = review.totalCells > 0
    ? Math.round((review.completedCells / review.totalCells) * 100)
    : 0;

  const handleExport = (format: "csv" | "json") => {
    window.open(`/api/doc-reviews/${review.id}/export?format=${format}`, "_blank");
  };

  return (
    <div className="space-y-4">
      {/* Header & Controls */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-card p-4 border rounded-lg">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">{review.name}</h2>
          {review.description && (
            <p className="text-sm text-muted-foreground">{review.description}</p>
          )}
          <div className="flex items-center gap-3 mt-2 text-xs text-muted-foreground">
            <span>Progress: {review.completedCells} / {review.totalCells} cells ({progressPercent}%)</span>
            <Badge
              variant={
                review.status === "completed"
                  ? "default"
                  : review.status === "running"
                  ? "secondary"
                  : "outline"
              }
            >
              {review.status}
            </Badge>
          </div>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <Button variant="outline" size="sm" onClick={onRefresh}>
            <RefreshCw className="h-4 w-4 mr-1" />
            Refresh
          </Button>
          {(review.status === "failed" || review.status === "pending" || review.failedCells > 0) && (
            <Button variant="default" size="sm" onClick={onResume}>
              <Play className="h-4 w-4 mr-1" />
              Resume Run
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={() => handleExport("csv")}>
            <Download className="h-4 w-4 mr-1" />
            Export CSV
          </Button>
        </div>
      </div>

      <Progress value={progressPercent} className="h-2" />

      {/* Filter Bar */}
      <div className="flex items-center gap-2 max-w-sm">
        <Search className="h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="Filter by document title..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="h-8 text-sm"
        />
      </div>

      {/* Matrix Table */}
      <div className="border rounded-md overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[280px] min-w-[240px] font-semibold">Document</TableHead>
              {columns.map((col) => (
                <TableHead key={col.id} className="min-w-[200px] font-semibold">
                  <div>
                    {col.title}
                    <span className="block text-[10px] text-muted-foreground font-normal uppercase">
                      {col.outputFormat}
                    </span>
                  </div>
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {filteredRows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={columns.length + 1} className="text-center py-8 text-muted-foreground">
                  No documents in this review run matching filter.
                </TableCell>
              </TableRow>
            ) : (
              filteredRows.map((row) => (
                <TableRow key={row.id}>
                  <TableCell className="font-medium truncate max-w-[280px]">
                    <div className="flex items-center gap-2">
                      <span className="truncate">{row.documentTitle}</span>
                      {row.documentSourceUrl && (
                        <a
                          href={row.documentSourceUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="text-muted-foreground hover:text-foreground shrink-0"
                        >
                          <ExternalLink className="h-3.5 w-3.5" />
                        </a>
                      )}
                    </div>
                  </TableCell>

                  {columns.map((col) => {
                    const cell = row.cells[col.id];
                    return (
                      <TableCell
                        key={col.id}
                        className="cursor-pointer hover:bg-muted/50 transition-colors p-3"
                        onClick={() =>
                          cell && setSelectedCell({ cell, column: col, row })
                        }
                      >
                        {!cell || cell.status === "pending" ? (
                          <span className="text-xs text-muted-foreground flex items-center gap-1">
                            <span className="h-2 w-2 rounded-full bg-slate-300 dark:bg-slate-700" />
                            Pending
                          </span>
                        ) : cell.status === "generating" ? (
                          <span className="text-xs text-blue-600 dark:text-blue-400 flex items-center gap-1">
                            <Loader2 className="h-3 w-3 animate-spin" />
                            Generating
                          </span>
                        ) : cell.status === "error" ? (
                          <span className="text-xs text-destructive flex items-center gap-1">
                            <AlertCircle className="h-3.5 w-3.5" />
                            Error
                          </span>
                        ) : (
                          <div className="space-y-1">
                            <div className="text-sm font-medium text-foreground truncate max-w-[240px]">
                              {typeof cell.value === "boolean"
                                ? cell.value ? "Yes" : "No"
                                : Array.isArray(cell.value)
                                ? cell.value.join(", ")
                                : String(cell.value ?? "")}
                            </div>
                            {cell.citations.length > 0 && (
                              <span className="inline-flex items-center text-[10px] text-emerald-600 dark:text-emerald-400 gap-0.5">
                                <CheckCircle2 className="h-3 w-3" />
                                {cell.citations.length} quote{cell.citations.length > 1 ? "s" : ""}
                              </span>
                            )}
                          </div>
                        )}
                      </TableCell>
                    );
                  })}
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {/* Cell Detail Inspection Drawer */}
      <Sheet open={!!selectedCell} onOpenChange={() => setSelectedCell(null)}>
        {selectedCell && (
          <SheetContent className="sm:max-w-lg overflow-y-auto space-y-6">
            <SheetHeader>
              <SheetTitle>{selectedCell.column.title}</SheetTitle>
              <SheetDescription>
                Document: {selectedCell.row.documentTitle}
              </SheetDescription>
            </SheetHeader>

            <div className="space-y-4">
              <div>
                <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider block mb-1">
                  Question / Prompt
                </label>
                <p className="text-sm text-foreground bg-muted p-2.5 rounded-md">
                  {selectedCell.column.prompt}
                </p>
              </div>

              <div>
                <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider block mb-1">
                  Status
                </label>
                <div className="flex items-center gap-2">
                  <Badge variant={selectedCell.cell.status === "completed" ? "default" : "destructive"}>
                    {selectedCell.cell.status}
                  </Badge>
                  {selectedCell.cell.status === "error" && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        onRetryCell(selectedCell.cell.id);
                        setSelectedCell(null);
                      }}
                    >
                      <RefreshCw className="h-3.5 w-3.5 mr-1" />
                      Retry Cell
                    </Button>
                  )}
                </div>
              </div>

              {selectedCell.cell.error && (
                <div>
                  <label className="text-xs font-semibold text-destructive uppercase tracking-wider block mb-1">
                    Error Log
                  </label>
                  <p className="text-xs text-destructive bg-destructive/10 p-2.5 rounded-md font-mono">
                    {selectedCell.cell.error}
                  </p>
                </div>
              )}

              {selectedCell.cell.status === "completed" && (
                <div>
                  <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider block mb-1">
                    Extracted Answer ({selectedCell.column.outputFormat})
                  </label>
                  <div className="text-sm bg-card border p-3 rounded-md font-medium text-foreground whitespace-pre-wrap">
                    {typeof selectedCell.cell.value === "object"
                      ? JSON.stringify(selectedCell.cell.value, null, 2)
                      : String(selectedCell.cell.value ?? "")}
                  </div>
                </div>
              )}

              {selectedCell.cell.citations.length > 0 && (
                <div>
                  <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider block mb-2">
                    Source Citations & Quotes
                  </label>
                  <div className="space-y-2">
                    {selectedCell.cell.citations.map((cit, idx) => (
                      <div key={idx} className="bg-emerald-500/5 border border-emerald-500/20 p-2.5 rounded-md text-xs space-y-1">
                        <p className="italic text-foreground">"{cit.quote}"</p>
                        {cit.sourceUrl && (
                          <a
                            href={cit.sourceUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="text-[11px] text-emerald-600 hover:underline flex items-center gap-1"
                          >
                            Source link <ExternalLink className="h-3 w-3" />
                          </a>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </SheetContent>
        )}
      </Sheet>
    </div>
  );
}
