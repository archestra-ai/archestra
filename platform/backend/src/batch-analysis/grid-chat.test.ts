import { vi } from "vitest";

vi.mock("@/utils/generate-tagged-text", () => ({
  generateTaggedText: vi.fn(),
}));

import { describe, expect, test } from "@/test";
import type {
  BatchAnalysis,
  BatchAnalysisCell,
  BatchAnalysisRow,
} from "@/types";
import { generateTaggedText } from "@/utils/generate-tagged-text";
import { askGrid } from "./grid-chat";

const analysis = {
  id: "analysis-1",
  name: "Vendor review",
  columns: [
    { key: "amount", name: "Amount", format: "number", prompt: "…" },
    { key: "risk", name: "Risk", format: "text", prompt: "…", flag: true },
  ],
} as BatchAnalysis;

const rows = [
  { id: "row-1", analysisId: "analysis-1", label: "Doc A", sortIndex: 0 },
  { id: "row-2", analysisId: "analysis-1", label: "Doc B", sortIndex: 1 },
] as BatchAnalysisRow[];

const cells = [
  { rowId: "row-1", columnKey: "amount", status: "done", content: "1200" },
  {
    rowId: "row-1",
    columnKey: "risk",
    status: "done",
    content: "high",
    flag: "red",
  },
  { rowId: "row-2", columnKey: "amount", status: "pending", content: null },
] as BatchAnalysisCell[];

function ask(question = "which doc costs most?") {
  return askGrid({
    model: {} as Parameters<typeof askGrid>[0]["model"],
    temperature: 0,
    question,
    analysis,
    rows,
    cells,
  });
}

describe("askGrid", () => {
  test("returns the answer with validated references", async () => {
    vi.mocked(generateTaggedText).mockResolvedValueOnce(
      JSON.stringify({
        answer: "Doc A, at 1200.",
        references: [{ rowId: "row-1", columnKey: "amount" }],
      }),
    );
    const result = await ask();
    expect(result).toEqual({
      ok: true,
      answer: "Doc A, at 1200.",
      references: [{ rowId: "row-1", columnKey: "amount" }],
    });
  });

  test("drops references outside the serialized grid, including other analyses' rows", async () => {
    vi.mocked(generateTaggedText).mockResolvedValueOnce(
      JSON.stringify({
        answer: "Doc A.",
        references: [
          { rowId: "row-1", columnKey: "amount" },
          // A pending cell was never a valid target…
          { rowId: "row-2", columnKey: "amount" },
          // …nor is a fabricated or foreign coordinate.
          { rowId: "someone-elses-row", columnKey: "amount" },
          { rowId: "row-1", columnKey: "not_a_column" },
        ],
      }),
    );
    const result = await ask();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.references).toEqual([
      { rowId: "row-1", columnKey: "amount" },
    ]);
  });

  test("keeps a prose answer that ignored the JSON contract, without references", async () => {
    vi.mocked(generateTaggedText).mockResolvedValueOnce(
      "Doc A costs the most.",
    );
    const result = await ask();
    expect(result).toEqual({
      ok: true,
      answer: "Doc A costs the most.",
      references: [],
    });
  });

  test("fails cleanly when the model produced nothing usable", async () => {
    vi.mocked(generateTaggedText).mockResolvedValueOnce(null);
    const result = await ask();
    expect(result.ok).toBe(false);
  });

  test("serializes flags and marks unfinished cells by status", async () => {
    vi.mocked(generateTaggedText).mockResolvedValueOnce(
      JSON.stringify({ answer: "ok", references: [] }),
    );
    await ask();
    const prompt = vi.mocked(generateTaggedText).mock.calls.at(-1)?.[0]
      ?.prompt as string;
    expect(prompt).toContain("(flag: red)");
    expect(prompt).toContain("(pending)");
    expect(prompt).toContain("row row-1 — Doc A:");
  });
});
