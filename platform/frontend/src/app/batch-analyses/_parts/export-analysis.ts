import type { BatchAnalysisDetail } from "@/lib/batch-analysis/batch-analysis.query";
import { CELL_FLAG_META } from "./cell-flag";

type Row = BatchAnalysisDetail["rows"][number];
type Cell = BatchAnalysisDetail["cells"][number];
type Column = BatchAnalysisDetail["analysis"]["columns"][number];

export interface ExportInput {
  analysisName: string;
  columns: Column[];
  /** In the order the user sees them — export ships the current view. */
  rows: Row[];
  cellsByRowAndColumn: Map<string, Cell>;
}

/**
 * Export the grid as CSV, citations included: every answer column is followed
 * by a supporting-text column so provenance survives the file leaving the app.
 * Flagged columns also carry their triage rating, and verified answers name
 * the state.
 *
 * @public — exported for tests
 */
export function buildAnalysisCsv(input: ExportInput): string {
  const table = buildExportTable(input);
  return table.map((row) => row.map(csvField).join(",")).join("\r\n");
}

export async function downloadAnalysisCsv(input: ExportInput): Promise<void> {
  downloadBlob(
    new Blob([buildAnalysisCsv(input)], { type: "text/csv;charset=utf-8" }),
    `${exportBaseName(input.analysisName)}.csv`,
  );
}

/**
 * Excel export: a Review sheet mirroring the CSV layout plus a Citations sheet
 * (source × column × quote) so quotes stay attached in the shared artifact.
 * ExcelJS is imported on demand — it never loads with the page.
 */
export async function downloadAnalysisXlsx(input: ExportInput): Promise<void> {
  const { Workbook } = await import("exceljs");
  const workbook = new Workbook();

  const review = workbook.addWorksheet("Review");
  for (const row of buildExportTable(input)) {
    // Neutralized text (never formulas): the same injection-safety as CSV.
    review.addRow(row.map(neutralizeFormula));
  }
  review.getRow(1).font = { bold: true };

  const citations = workbook.addWorksheet("Citations");
  citations.addRow(["Source", "Column", "Supporting text"]);
  citations.getRow(1).font = { bold: true };
  for (const row of input.rows) {
    for (const column of input.columns) {
      const cell = input.cellsByRowAndColumn.get(`${row.id}:${column.key}`);
      for (const citation of cell?.citations ?? []) {
        citations.addRow(
          [row.label, column.name, citation.quote].map(neutralizeFormula),
        );
      }
    }
  }

  const buffer = await workbook.xlsx.writeBuffer();
  downloadBlob(
    new Blob([buffer], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    }),
    `${exportBaseName(input.analysisName)}.xlsx`,
  );
}

// ===== Internal =====

function buildExportTable(input: ExportInput): string[][] {
  const { columns, rows, cellsByRowAndColumn } = input;
  const anyVerified = rows.some((row) =>
    columns.some(
      (column) =>
        cellsByRowAndColumn.get(`${row.id}:${column.key}`)?.verifiedAt,
    ),
  );

  const header = ["Source"];
  for (const column of columns) {
    header.push(column.name, `${column.name} — supporting text`);
    if (column.flag) header.push(`${column.name} — flag`);
    if (anyVerified) header.push(`${column.name} — verified`);
  }

  const body = rows.map((row) => {
    const line = [row.label];
    for (const column of columns) {
      const cell = cellsByRowAndColumn.get(`${row.id}:${column.key}`);
      line.push(
        cell?.status === "error" ? "(failed)" : (cell?.content ?? ""),
        (cell?.citations ?? []).map((citation) => citation.quote).join("\n"),
      );
      if (column.flag) {
        line.push(cell?.flag ? CELL_FLAG_META[cell.flag].label : "");
      }
      if (anyVerified) {
        line.push(
          cell?.verifiedAt
            ? `Verified${cell.verifiedByName ? ` by ${cell.verifiedByName}` : ""}`
            : "",
        );
      }
    }
    return line;
  });

  return [header, ...body];
}

/**
 * RFC 4180 quoting plus spreadsheet-formula neutralization: a cell beginning
 * with = + - or @ would execute as a formula when the CSV is opened, and the
 * cell contents here are model output over user documents — exactly the kind
 * of text that must never run.
 *
 * @public — exported for tests
 */
export function csvField(value: string): string {
  const neutralized = neutralizeFormula(value);
  if (/[",\r\n]/.test(neutralized)) {
    return `"${neutralized.replaceAll('"', '""')}"`;
  }
  return neutralized;
}

function neutralizeFormula(value: string): string {
  // Spreadsheets skip leading whitespace and control characters before
  // deciding a cell is a formula, so the guard must too.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the control-character prefix is exactly what the injection guard must match
  return /^[\s\u0000-\u001f]*[=+\-@\t]/.test(value) ? `'${value}` : value;
}

function exportBaseName(name: string): string {
  return name.replace(/[^\p{L}\p{N} _-]+/gu, "").trim() || "batch-analysis";
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
