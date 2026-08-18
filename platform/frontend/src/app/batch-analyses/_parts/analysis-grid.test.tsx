import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  useHasPermissions,
  useMissingPermissions,
} from "@/lib/auth/auth.query";
import { AnalysisGrid } from "./analysis-grid";

vi.mock("@/lib/auth/auth.query");

beforeEach(() => {
  vi.mocked(useHasPermissions).mockReturnValue({
    data: true,
  } as unknown as ReturnType<typeof useHasPermissions>);
  vi.mocked(useMissingPermissions).mockReturnValue({});
  // jsdom has no layout: without real dimensions the grid virtualizes all but
  // the first column out of the DOM.
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1920);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(1080);
});

type GridProps = Parameters<typeof AnalysisGrid>[0];

const columns = [
  { key: "amount", name: "Amount", format: "number", prompt: "…" },
  { key: "quote", name: "Clause", format: "exact_quote", prompt: "…" },
] as GridProps["columns"];

const rows = [
  {
    id: "row-1",
    analysisId: "a-1",
    label: "contract.pdf",
    sourceType: "kb_file",
    source: { type: "kb_file", fileId: "f-1" },
    sortIndex: 0,
    createdAt: new Date().toISOString(),
    sourceFile: {
      id: "f-1",
      filename: "contract.pdf",
      mimeType: "application/pdf",
    },
  },
  {
    id: "row-2",
    analysisId: "a-1",
    label: "Pasted text",
    sourceType: "inline_text",
    source: { type: "inline_text", text: "hello" },
    sortIndex: 1,
    createdAt: new Date().toISOString(),
    sourceFile: null,
  },
] as unknown as GridProps["rows"];

const cells = new Map([
  [
    "row-1:amount",
    { rowId: "row-1", columnKey: "amount", status: "done", content: "42 EUR" },
  ],
  ["row-1:quote", { rowId: "row-1", columnKey: "quote", status: "error" }],
]) as GridProps["cellsByRowAndColumn"];

function renderGrid(overrides: Partial<GridProps> = {}) {
  const onSelectCell = vi.fn();
  const onPreviewFile = vi.fn();
  const onPreviewText = vi.fn();
  const onAddRow = vi.fn();
  render(
    <AnalysisGrid
      columns={columns}
      rows={rows}
      cellsByRowAndColumn={cells}
      onSelectCell={onSelectCell}
      onPreviewFile={onPreviewFile}
      onPreviewText={onPreviewText}
      onDeleteRow={vi.fn()}
      deleteRowDisabled={false}
      onAddRow={onAddRow}
      onAddColumn={vi.fn()}
      {...overrides}
    />,
  );
  return { onSelectCell, onPreviewFile, onPreviewText, onAddRow };
}

describe("AnalysisGrid", () => {
  it("renders sources, answers, and per-cell status", () => {
    renderGrid();
    expect(screen.getByRole("grid")).toBeInTheDocument();
    expect(screen.getByText("contract.pdf")).toBeInTheDocument();
    expect(screen.getByText("42 EUR")).toBeInTheDocument();
    // A failed cell says so instead of rendering blank.
    expect(screen.getByText("Failed")).toBeInTheDocument();
    // A column's answer format is part of the header contract.
    expect(screen.getByText("exact quote")).toBeInTheDocument();
  });

  it("opens the detail sheet for an answer cell, but not for the source column", async () => {
    const user = userEvent.setup();
    const { onSelectCell } = renderGrid();

    await user.click(screen.getByText("42 EUR"));
    expect(onSelectCell).toHaveBeenCalledWith(
      expect.objectContaining({ id: "row-1" }),
      "amount",
    );

    onSelectCell.mockClear();
    await user.click(screen.getByText("Pasted text"));
    expect(onSelectCell).not.toHaveBeenCalled();
  });

  it("opens a pasted source's text from its label", async () => {
    const user = userEvent.setup();
    const { onPreviewText } = renderGrid();

    await user.click(screen.getByRole("button", { name: "Pasted text" }));
    expect(onPreviewText).toHaveBeenCalledWith({
      label: "Pasted text",
      text: "hello",
    });
  });

  it("copies the focused answer cell's text on copy, spreadsheet-style", async () => {
    const user = userEvent.setup();
    renderGrid();

    await user.click(screen.getByText("42 EUR"));
    const setData = vi.fn();
    fireEvent.copy(document.activeElement as Element, {
      clipboardData: { setData },
    });
    expect(setData).toHaveBeenCalledWith("text/plain", "42 EUR");
  });

  it("offers a subtle in-grid Add row from the pinned bottom row", async () => {
    const user = userEvent.setup();
    const { onAddRow } = renderGrid();

    await user.click(screen.getByRole("button", { name: /add row/i }));
    expect(onAddRow).toHaveBeenCalled();
  });

  it("opens the file preview from an uploaded source's label", async () => {
    const user = userEvent.setup();
    const { onPreviewFile } = renderGrid();

    await user.click(screen.getByRole("button", { name: "contract.pdf" }));
    expect(onPreviewFile).toHaveBeenCalledWith({
      name: "contract.pdf",
      mimeType: "application/pdf",
      contentUrl: "/api/knowledge-files/f-1/content",
    });
  });
});
