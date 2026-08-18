import type { SortColumn } from "react-data-grid";
import type { BatchAnalysisDetail } from "@/lib/batch-analysis/batch-analysis.query";

type Row = BatchAnalysisDetail["rows"][number];
type Cell = BatchAnalysisDetail["cells"][number];
type Column = BatchAnalysisDetail["analysis"]["columns"][number];
type CellFlag = NonNullable<Cell["flag"]>;

export interface AnswerViewFilter {
  /** Substring match over the row label and every answer, case-insensitive. */
  query: string;
  /** Keep only rows with at least one cell carrying this flag. */
  flag: CellFlag | null;
  /** Keep only rows where every completed cell is human-verified. */
  verifiedOnly: boolean;
}

export const EMPTY_ANSWER_FILTER: AnswerViewFilter = {
  query: "",
  flag: null,
  verifiedOnly: false,
};

export function isFilterActive(filter: AnswerViewFilter): boolean {
  return (
    filter.query.trim() !== "" || filter.flag !== null || filter.verifiedOnly
  );
}

/**
 * Compute the rows the grid should show: filter first, then sort by the
 * requested answer column with a format-aware comparator, keeping the
 * original `sortIndex` order as the tie-breaker so equal values do not
 * reshuffle under the 2s polling refetches.
 */
export function computeVisibleRows(params: {
  rows: Row[];
  columns: Column[];
  cellsByRowAndColumn: Map<string, Cell>;
  filter: AnswerViewFilter;
  sortColumns: readonly SortColumn[];
}): Row[] {
  const { rows, columns, cellsByRowAndColumn, filter, sortColumns } = params;

  const query = filter.query.trim().toLowerCase();
  const filtered = rows.filter((row) => {
    const cells = columns.map((column) =>
      cellsByRowAndColumn.get(`${row.id}:${column.key}`),
    );
    if (query) {
      const haystack = [row.label, ...cells.map((cell) => cell?.content ?? "")]
        .join("\n")
        .toLowerCase();
      if (!haystack.includes(query)) return false;
    }
    if (filter.flag && !cells.some((cell) => cell?.flag === filter.flag)) {
      return false;
    }
    if (filter.verifiedOnly) {
      const doneCells = cells.filter((cell) => cell?.status === "done");
      if (
        doneCells.length === 0 ||
        doneCells.some((cell) => !cell?.verifiedAt)
      ) {
        return false;
      }
    }
    return true;
  });

  const sort = sortColumns[0];
  if (!sort) return filtered;
  const column = columns.find((candidate) => candidate.key === sort.columnKey);
  if (!column) return filtered;

  const direction = sort.direction === "DESC" ? -1 : 1;
  return [...filtered].sort((a, b) => {
    const left =
      cellsByRowAndColumn.get(`${a.id}:${column.key}`)?.content ?? null;
    const right =
      cellsByRowAndColumn.get(`${b.id}:${column.key}`)?.content ?? null;
    // Missing-last is absolute — flipping the direction must not surface the
    // unknowns to the top.
    const leftMissing = isMissing(left);
    const rightMissing = isMissing(right);
    if (leftMissing !== rightMissing) return leftMissing ? 1 : -1;
    const compared = compareAnswers(column.format, left, right);
    if (compared !== 0) return compared * direction;
    return a.sortIndex - b.sortIndex;
  });
}

/**
 * Format-aware answer comparison. Missing answers and the not-found sentinel
 * sort last regardless of direction-relevant value order, because "we don't
 * know" is never the interesting end of a sorted column.
 *
 * @public — exported for tests
 */
export function compareAnswers(
  format: Column["format"],
  a: string | null,
  b: string | null,
): number {
  const aMissing = isMissing(a);
  const bMissing = isMissing(b);
  if (aMissing && bMissing) return 0;
  if (aMissing) return 1;
  if (bMissing) return -1;
  const left = a as string;
  const right = b as string;

  switch (format) {
    case "number": {
      return compareParsed(parseNumeric(left), parseNumeric(right), (x, y) =>
        Math.sign(x - y),
      );
    }
    case "date": {
      return compareParsed(Date.parse(left), Date.parse(right), (x, y) =>
        Math.sign(x - y),
      );
    }
    case "boolean": {
      return compareParsed(parseYesNo(left), parseYesNo(right), (x, y) =>
        Math.sign(x - y),
      );
    }
    default:
      return left.localeCompare(right, undefined, { sensitivity: "base" });
  }
}

// ===== Internal =====

function isMissing(value: string | null): boolean {
  return value === null || value.trim() === "" || value.trim() === "N/A";
}

/** NaN-aware comparison with a text fallback so unparseable answers still order. */
function compareParsed(
  a: number,
  b: number,
  compare: (a: number, b: number) => number,
): number {
  const aBad = Number.isNaN(a);
  const bBad = Number.isNaN(b);
  if (aBad && bBad) return 0;
  if (aBad) return 1;
  if (bBad) return -1;
  return compare(a, b);
}

/** Tolerates currency symbols, thousands separators, and units around a number. */
function parseNumeric(value: string): number {
  const match = value.replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
  return match ? Number.parseFloat(match[0]) : Number.NaN;
}

function parseYesNo(value: string): number {
  const normalized = value.trim().toLowerCase();
  if (normalized.startsWith("yes")) return 1;
  if (normalized.startsWith("no")) return 0;
  return Number.NaN;
}
