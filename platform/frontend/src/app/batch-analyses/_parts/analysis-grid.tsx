"use client";

// The grid's stylesheet is imported by the route (`[id]/page.tsx`), not here:
// the tailwind postcss config cannot process CSS imports under vitest.
import {
  AlertCircle,
  AlignLeft,
  BookOpen,
  FileText,
  Loader2,
  Plus,
  Quote,
  Trash2,
} from "lucide-react";
import { useMemo } from "react";
import {
  type CellKeyboardEvent,
  type CellKeyDownArgs,
  type CellMouseArgs,
  type Column,
  DataGrid,
  type DataGridHandle,
} from "react-data-grid";
import type { PreviewableSourceText } from "@/app/batch-analyses/_parts/source-text-dialog";
import type { PreviewableDocument } from "@/components/files/file-preview-dialog";
import { PermissionButton } from "@/components/ui/permission-button";
import type { BatchAnalysisDetail } from "@/lib/batch-analysis/batch-analysis.query";
import { cn } from "@/lib/utils";

type Cell = BatchAnalysisDetail["cells"][number];
type Row = BatchAnalysisDetail["rows"][number];
type AnalysisColumn = BatchAnalysisDetail["analysis"]["columns"][number];

/**
 * The cell sheet, rendered as a real data grid (react-data-grid) rather than a
 * plain table: rows are virtualized so hundreds of sources stay smooth, the
 * source column stays frozen under horizontal scroll, columns are resizable,
 * and the grid is arrow-key navigable like a spreadsheet — Enter (or click)
 * opens the answer's detail sheet.
 */
export function AnalysisGrid({
  gridRef,
  columns: analysisColumns,
  rows,
  cellsByRowAndColumn,
  onSelectCell,
  onPreviewFile,
  onPreviewText,
  onDeleteRow,
  deleteRowDisabled,
  onAddRow,
  onAddColumn,
}: {
  /** Exposes the grid element so the page can hand focus back after dialogs. */
  gridRef?: React.Ref<DataGridHandle>;
  columns: AnalysisColumn[];
  rows: Row[];
  cellsByRowAndColumn: Map<string, Cell>;
  onSelectCell: (row: Row, columnKey: string) => void;
  onPreviewFile: (file: PreviewableDocument) => void;
  onPreviewText: (source: PreviewableSourceText) => void;
  onDeleteRow: (row: Row) => void;
  deleteRowDisabled: boolean;
  onAddRow: () => void;
  onAddColumn: () => void;
}) {
  const gridColumns = useMemo<readonly Column<Row, SummaryRow>[]>(
    () => [
      {
        key: SOURCE_COLUMN_KEY,
        name: "Source",
        frozen: true,
        resizable: true,
        width: 240,
        minWidth: 180,
        cellClass: CELL_CLASS,
        headerCellClass: HEADER_CLASS,
        renderCell: ({ row }) => (
          <SourceCell
            row={row}
            onPreviewFile={onPreviewFile}
            onPreviewText={onPreviewText}
            onDeleteRow={onDeleteRow}
            deleteRowDisabled={deleteRowDisabled}
          />
        ),
        // The pinned bottom row's only content: a quiet in-grid way to grow
        // the sheet, spreadsheet-style, without reaching for the toolbar.
        renderSummaryCell: () => (
          <PermissionButton
            permissions={{ batchAnalysis: ["update"] }}
            variant="ghost"
            size="sm"
            className="h-7 justify-start px-1 text-muted-foreground"
            onClick={onAddRow}
          >
            <Plus className="h-3.5 w-3.5" />
            <span>Add row</span>
          </PermissionButton>
        ),
      },
      ...analysisColumns.map(
        (column): Column<Row, SummaryRow> => ({
          key: column.key,
          name: column.name,
          resizable: true,
          minWidth: 220,
          cellClass: (row) =>
            cn(
              CELL_CLASS,
              "cursor-pointer hover:bg-accent",
              cellFor(cellsByRowAndColumn, row, column.key)?.status ===
                "error" && "bg-destructive/5",
            ),
          headerCellClass: HEADER_CLASS,
          renderHeaderCell: () => (
            <span className="block leading-snug">
              <span className="block font-medium">{column.name}</span>
              <span className="block font-normal text-muted-foreground text-xs">
                {column.format === "exact_quote"
                  ? "exact quote"
                  : column.format}
              </span>
            </span>
          ),
          renderCell: ({ row }) => (
            <CellContent cell={cellFor(cellsByRowAndColumn, row, column.key)} />
          ),
        }),
      ),
      {
        key: ADD_COLUMN_KEY,
        name: "",
        width: 56,
        minWidth: 56,
        cellClass: CELL_CLASS,
        // text-clip: the cell inherits the grid's nowrap+ellipsis text
        // handling, and a content overflow of even 1px paints a literal
        // "…" next to the button.
        headerCellClass: cn(HEADER_CLASS, "p-0 text-center text-clip"),
        renderHeaderCell: () => (
          <PermissionButton
            permissions={{ batchAnalysis: ["update"] }}
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-muted-foreground"
            aria-label="Add column"
            tooltip="Add column"
            onClick={onAddColumn}
          >
            <Plus className="h-4 w-4" />
          </PermissionButton>
        ),
        renderCell: () => null,
      },
    ],
    [
      analysisColumns,
      cellsByRowAndColumn,
      onPreviewFile,
      onPreviewText,
      onDeleteRow,
      deleteRowDisabled,
      onAddRow,
      onAddColumn,
    ],
  );

  function openCell(args: { row: Row; column: { key: string } }) {
    if (args.column.key === SOURCE_COLUMN_KEY) return;
    if (args.column.key === ADD_COLUMN_KEY) return;
    onSelectCell(args.row, args.column.key);
  }

  function handleCellKeyDown(
    args: CellKeyDownArgs<Row, SummaryRow>,
    event: CellKeyboardEvent,
  ) {
    if (
      args.mode === "ACTIVE" &&
      event.key === "Enter" &&
      args.row &&
      args.column
    ) {
      // Without preventDefault the browser's default Enter activation fires a
      // click on whatever is focused once the event settles — by then that is
      // the sheet's close button, so the sheet would close the instant it
      // opens.
      event.preventDefault();
      event.preventGridDefault();
      openCell({ row: args.row, column: args.column });
    }
  }

  return (
    <DataGrid
      ref={gridRef}
      columns={gridColumns}
      rows={rows}
      rowKeyGetter={(row) => row.id}
      rowHeight={84}
      headerRowHeight={52}
      bottomSummaryRows={SUMMARY_ROWS}
      summaryRowHeight={40}
      onCellClick={(args: CellMouseArgs<Row, SummaryRow>) => openCell(args)}
      onCellKeyDown={handleCellKeyDown}
      className="rounded-md border"
      style={GRID_STYLE}
      aria-label="Analysis results"
    />
  );
}

// ===== Internal =====

const SOURCE_COLUMN_KEY = "__source";
const ADD_COLUMN_KEY = "__add_column";

/** The single pinned bottom row that carries the "Add row" affordance. */
type SummaryRow = { kind: "add-row" };
const SUMMARY_ROWS: readonly SummaryRow[] = [{ kind: "add-row" }];

// rdg cells default to single-line vertically-centered text; answers are
// multi-line clamped blocks aligned to the top, like a spreadsheet with
// wrapped text.
const CELL_CLASS = "whitespace-normal! py-2 content-start leading-snug";
const HEADER_CLASS = "bg-muted content-center";

// Map the grid's theme variables onto the app palette so it follows the
// shadcn tokens (and dark mode) instead of shipping its own colors. Height is
// content-sized but capped so the header stays visible while rows scroll.
const GRID_STYLE = {
  blockSize: "auto",
  maxBlockSize: "calc(100vh - 16rem)",
  "--rdg-color": "var(--foreground)",
  "--rdg-background-color": "var(--background)",
  "--rdg-header-background-color": "var(--muted)",
  "--rdg-border-color": "var(--border)",
  "--rdg-row-hover-background-color": "var(--accent)",
  "--rdg-selection-color": "var(--ring)",
  "--rdg-font-size": "0.875rem",
} as React.CSSProperties;

function cellFor(
  cells: Map<string, Cell>,
  row: Row,
  columnKey: string,
): Cell | undefined {
  return cells.get(`${row.id}:${columnKey}`);
}

/**
 * A row label alone does not say what "Acme MSA" is — a file, pasted text, or
 * a knowledge document — nor what its answers were generated from. Every
 * source gets a type icon, and file and pasted-text sources open their actual
 * content.
 */
function SourceCell({
  row,
  onPreviewFile,
  onPreviewText,
  onDeleteRow,
  deleteRowDisabled,
}: {
  row: Row;
  onPreviewFile: (file: PreviewableDocument) => void;
  onPreviewText: (source: PreviewableSourceText) => void;
  onDeleteRow: (row: Row) => void;
  deleteRowDisabled: boolean;
}) {
  const label = (
    <span className="line-clamp-2 min-w-0 break-words font-medium text-sm underline-offset-4 hover:underline">
      {row.label}
    </span>
  );

  return (
    <div className="group/row flex items-start gap-1">
      <div className="min-w-0 flex-1">
        {row.sourceFile ? (
          <button
            type="button"
            title="Uploaded document — click to open"
            className="flex w-full items-start gap-1.5 text-left"
            onClick={() =>
              row.sourceFile &&
              onPreviewFile({
                name: row.sourceFile.filename,
                mimeType: row.sourceFile.mimeType,
                contentUrl: `/api/knowledge-files/${row.sourceFile.id}/content`,
              })
            }
          >
            <FileText className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            {label}
          </button>
        ) : row.source.type === "inline_text" ? (
          <button
            type="button"
            title="Pasted text — click to read"
            className="flex w-full items-start gap-1.5 text-left"
            onClick={() => {
              if (row.source.type === "inline_text") {
                onPreviewText({ label: row.label, text: row.source.text });
              }
            }}
          >
            <AlignLeft className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            {label}
          </button>
        ) : (
          <span
            title="Knowledge base document"
            className="flex w-full items-start gap-1.5 text-left"
          >
            <BookOpen className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span className="line-clamp-2 min-w-0 break-words font-medium text-sm">
              {row.label}
            </span>
          </span>
        )}
      </div>
      {/* Revealed on cell hover so 200 rows of trash cans don't compete with
          the data. Removing a row removes its answers with it. */}
      <PermissionButton
        permissions={{ batchAnalysis: ["update"] }}
        variant="ghost"
        size="icon"
        className="h-6 w-6 shrink-0 text-muted-foreground opacity-0 transition-opacity hover:text-destructive focus-visible:opacity-100 group-hover/row:opacity-100"
        aria-label={`Remove ${row.label}`}
        tooltip="Remove row"
        disabled={deleteRowDisabled}
        onClick={() => onDeleteRow(row)}
      >
        <Trash2 className="h-3.5 w-3.5" />
      </PermissionButton>
    </div>
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
