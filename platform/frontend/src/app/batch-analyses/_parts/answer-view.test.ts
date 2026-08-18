import { describe, expect, it } from "vitest";
import {
  compareAnswers,
  computeVisibleRows,
  EMPTY_ANSWER_FILTER,
} from "./answer-view";

type Params = Parameters<typeof computeVisibleRows>[0];

const columns = [
  { key: "amount", name: "Amount", format: "number", prompt: "…" },
  { key: "signed", name: "Signed", format: "date", prompt: "…" },
  { key: "renews", name: "Renews", format: "boolean", prompt: "…", flag: true },
] as Params["columns"];

function makeRow(id: string, sortIndex: number) {
  return { id, sortIndex, label: `Row ${id}` } as Params["rows"][number];
}

function makeCells(
  entries: [
    rowId: string,
    columnKey: string,
    content: string | null,
    extra?: Partial<
      Params["cellsByRowAndColumn"] extends Map<string, infer C> ? C : never
    >,
  ][],
) {
  return new Map(
    entries.map(([rowId, columnKey, content, extra]) => [
      `${rowId}:${columnKey}`,
      {
        rowId,
        columnKey,
        content,
        status: "done",
        flag: null,
        verifiedAt: null,
        ...extra,
      },
    ]),
  ) as Params["cellsByRowAndColumn"];
}

describe("compareAnswers", () => {
  it("compares numbers through currency noise", () => {
    expect(compareAnswers("number", "$1,200", "USD 900")).toBeGreaterThan(0);
    expect(compareAnswers("number", "50", "900")).toBeLessThan(0);
  });

  it("compares dates chronologically", () => {
    expect(compareAnswers("date", "2024-01-01", "2025-06-30")).toBeLessThan(0);
  });

  it("orders yes after no for boolean columns", () => {
    expect(compareAnswers("boolean", "Yes", "No")).toBeGreaterThan(0);
  });

  it("always sorts N/A and empty answers last", () => {
    expect(compareAnswers("number", "N/A", "5")).toBeGreaterThan(0);
    expect(compareAnswers("text", null, "anything")).toBeGreaterThan(0);
  });
});

describe("computeVisibleRows", () => {
  const rows = [makeRow("a", 0), makeRow("b", 1), makeRow("c", 2)];
  const cells = makeCells([
    ["a", "amount", "300"],
    ["b", "amount", "100"],
    ["c", "amount", "N/A"],
    ["a", "renews", "yes", { flag: "red" }],
    ["b", "renews", "no", { verifiedAt: "2026-01-01T00:00:00Z" }],
  ]);

  it("sorts by an answer column with missing values last", () => {
    const visible = computeVisibleRows({
      rows,
      columns,
      cellsByRowAndColumn: cells,
      filter: EMPTY_ANSWER_FILTER,
      sortColumns: [{ columnKey: "amount", direction: "ASC" }],
    });
    expect(visible.map((row) => row.id)).toEqual(["b", "a", "c"]);
  });

  it("keeps missing values last even when descending", () => {
    const visible = computeVisibleRows({
      rows,
      columns,
      cellsByRowAndColumn: cells,
      filter: EMPTY_ANSWER_FILTER,
      sortColumns: [{ columnKey: "amount", direction: "DESC" }],
    });
    expect(visible.map((row) => row.id)).toEqual(["a", "b", "c"]);
  });

  it("filters by substring across label and answers", () => {
    const visible = computeVisibleRows({
      rows,
      columns,
      cellsByRowAndColumn: cells,
      filter: { ...EMPTY_ANSWER_FILTER, query: "300" },
      sortColumns: [],
    });
    expect(visible.map((row) => row.id)).toEqual(["a"]);
  });

  it("filters by flag", () => {
    const visible = computeVisibleRows({
      rows,
      columns,
      cellsByRowAndColumn: cells,
      filter: { ...EMPTY_ANSWER_FILTER, flag: "red" },
      sortColumns: [],
    });
    expect(visible.map((row) => row.id)).toEqual(["a"]);
  });

  it("verified-only keeps rows whose completed cells are all verified", () => {
    const visible = computeVisibleRows({
      rows,
      columns,
      cellsByRowAndColumn: makeCells([
        ["a", "amount", "300", { verifiedAt: "2026-01-01T00:00:00Z" }],
        ["b", "amount", "100"],
      ]),
      filter: { ...EMPTY_ANSWER_FILTER, verifiedOnly: true },
      sortColumns: [],
    });
    expect(visible.map((row) => row.id)).toEqual(["a"]);
  });
});
