import type { RowSelectionState } from "@tanstack/react-table";
import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { TableCard } from "@/components/table-card-view";
import { useBulkCardSelection } from "./use-bulk-card-selection";

const rows = ["one", "two", "three", "four", "five"].map((id) => ({ id }));

describe("useBulkCardSelection", () => {
  it("selects and deselects anchored ranges across cards", () => {
    render(<TestCards />);

    fireEvent.click(screen.getByRole("checkbox", { name: "Select two" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Select four" }), {
      shiftKey: true,
    });

    expect(selectedCards()).toEqual([
      "Select two",
      "Select three",
      "Select four",
    ]);

    fireEvent.click(screen.getByRole("checkbox", { name: "Select three" }), {
      shiftKey: true,
    });

    expect(selectedCards()).toEqual(["Select two"]);
  });

  it("keeps disabled cards out of plain and Shift selections", () => {
    render(<TestCards disabledId="three" />);

    fireEvent.click(screen.getByRole("checkbox", { name: "Select two" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Select four" }), {
      shiftKey: true,
    });

    expect(
      screen.getByRole("checkbox", { name: "Select three" }),
    ).toBeDisabled();
    expect(selectedCards()).toEqual(["Select two", "Select four"]);
  });
});

function TestCards({ disabledId }: { disabledId?: string }) {
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
  const cardSelection = useBulkCardSelection({
    rows,
    getRowId: (row) => row.id,
    rowSelection,
    setRowSelection,
    canSelect: (row) => row.id !== disabledId,
  });

  return rows.map((row) => (
    <TableCard
      key={row.id}
      title={row.id}
      {...cardSelection(row)}
      selectionLabel={`Select ${row.id}`}
    />
  ));
}

function selectedCards() {
  return screen
    .getAllByRole("checkbox")
    .filter((checkbox) => checkbox.getAttribute("data-state") === "checked")
    .map((checkbox) => checkbox.getAttribute("aria-label"));
}
