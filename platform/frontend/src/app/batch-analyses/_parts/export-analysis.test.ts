import { describe, expect, it } from "vitest";
import {
  buildAnalysisCsv,
  csvField,
  type ExportInput,
} from "./export-analysis";

const columns = [
  { key: "amount", name: "Amount", format: "number", prompt: "…" },
  { key: "risk", name: "Risk", format: "text", prompt: "…", flag: true },
] as ExportInput["columns"];

function makeInput(
  cells: [string, string, Partial<Record<string, unknown>>][],
): ExportInput {
  return {
    analysisName: "Vendor review",
    columns,
    rows: [
      { id: "a", label: "Doc A", sortIndex: 0 },
      { id: "b", label: "Doc B", sortIndex: 1 },
    ] as ExportInput["rows"],
    cellsByRowAndColumn: new Map(
      cells.map(([rowId, columnKey, extra]) => [
        `${rowId}:${columnKey}`,
        {
          rowId,
          columnKey,
          status: "done",
          content: "",
          citations: null,
          flag: null,
          verifiedAt: null,
          verifiedByName: null,
          ...extra,
        },
      ]),
    ) as unknown as ExportInput["cellsByRowAndColumn"],
  };
}

describe("csvField", () => {
  it("quotes separators and doubles embedded quotes", () => {
    expect(csvField('a,"b"\nc')).toBe('"a,""b""\nc"');
  });

  it("neutralizes leading formula characters", () => {
    expect(csvField("=SUM(A1)")).toBe("'=SUM(A1)");
    expect(csvField("+1")).toBe("'+1");
    expect(csvField("@cmd")).toBe("'@cmd");
    expect(csvField("-2")).toBe("'-2");
  });
});

describe("buildAnalysisCsv", () => {
  it("pairs every answer with its supporting text and keeps flags for opted-in columns", () => {
    const csv = buildAnalysisCsv(
      makeInput([
        [
          "a",
          "amount",
          { content: "1200", citations: [{ quote: "the fee is 1200" }] },
        ],
        ["a", "risk", { content: "high", flag: "red" }],
      ]),
    );
    const [header, first] = csv.split("\r\n");
    expect(header).toBe(
      "Source,Amount,Amount — supporting text,Risk,Risk — supporting text,Risk — flag",
    );
    expect(first).toBe("Doc A,1200,the fee is 1200,high,,Problematic");
  });

  it("adds verified columns only when a verification exists, and names the reviewer", () => {
    const csv = buildAnalysisCsv(
      makeInput([
        [
          "a",
          "amount",
          {
            content: "900",
            verifiedAt: "2026-01-01T00:00:00Z",
            verifiedByName: "Sam Lee",
          },
        ],
      ]),
    );
    const [header, first] = csv.split("\r\n");
    expect(header).toContain("Amount — verified");
    expect(first).toContain("Verified by Sam Lee");
  });

  it("marks failed cells rather than exporting them blank", () => {
    const csv = buildAnalysisCsv(
      makeInput([["a", "amount", { status: "error", content: null }]]),
    );
    expect(csv.split("\r\n")[1]).toContain("(failed)");
  });
});
