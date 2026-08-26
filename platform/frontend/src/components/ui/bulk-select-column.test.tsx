import type { RowSelectionState } from "@tanstack/react-table";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useMemo, useState } from "react";
import { describe, expect, it } from "vitest";
import { useControlledRowSelection } from "@/lib/hooks/use-bulk-selection";
import { createSelectColumn } from "./bulk-select-column";
import { DataTable } from "./data-table";

type TestRow = {
  id: string;
  name: string;
  fixed: boolean;
};

const rangeRows = ["one", "two", "three", "four", "five"].map((name) => ({
  id: name,
  name: `Row ${name}`,
}));
type RangeRow = (typeof rangeRows)[number];

describe("createSelectColumn", () => {
  it("shows disabled rows and explains why they cannot be selected", async () => {
    const user = userEvent.setup();
    render(<TestTable />);

    const disabledCheckbox = screen.getByRole("checkbox", {
      name: "Select Predefined",
    });
    expect(disabledCheckbox).toBeDisabled();

    await user.hover(screen.getByTitle("Predefined rows cannot be deleted"));
    expect(
      await screen.findByRole("tooltip", {
        name: "Predefined rows cannot be deleted",
      }),
    ).toBeVisible();
  });

  it("selects only rows that the bulk action can change", async () => {
    const user = userEvent.setup();
    render(<TestTable />);

    await user.click(screen.getByRole("checkbox", { name: "Select all rows" }));

    expect(
      screen.getByRole("checkbox", { name: "Select Custom one" }),
    ).toBeChecked();
    expect(
      screen.getByRole("checkbox", { name: "Select Custom two" }),
    ).toBeChecked();
    expect(
      screen.getByRole("checkbox", { name: "Select Predefined" }),
    ).not.toBeChecked();
  });

  it("selects the visible range from the last plain-clicked row", () => {
    render(<RangeTable />);

    fireEvent.click(screen.getByRole("checkbox", { name: "Select Row two" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Row four" }), {
      shiftKey: true,
    });

    expect(selectedRangeRows()).toEqual([
      "Select Row two",
      "Select Row three",
      "Select Row four",
    ]);
  });

  it("advances the anchor after each Shift-click", () => {
    render(<RangeTable />);

    fireEvent.click(screen.getByRole("checkbox", { name: "Select Row three" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Row one" }), {
      shiftKey: true,
    });
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Row two" }), {
      shiftKey: true,
    });

    expect(selectedRangeRows()).toEqual(["Select Row three"]);
  });

  it("deselects the range when the Shift-clicked row is selected", () => {
    render(<RangeTable />);

    fireEvent.click(screen.getByRole("checkbox", { name: "Select Row two" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Row four" }), {
      shiftKey: true,
    });
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Select Row three" }),
      { shiftKey: true },
    );

    expect(selectedRangeRows()).toEqual(["Select Row two"]);
  });

  it("uses the first Shift-click as the anchor when none exists", () => {
    render(<RangeTable />);

    fireEvent.click(
      screen.getByRole("checkbox", { name: "Select Row three" }),
      { shiftKey: true },
    );
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Row one" }), {
      shiftKey: true,
    });

    expect(selectedRangeRows()).toEqual([
      "Select Row one",
      "Select Row two",
      "Select Row three",
    ]);
  });

  it("deselects a Shift range and exits all-matching selection", () => {
    render(<EscalatedRangeTable />);

    fireEvent.click(screen.getByRole("checkbox", { name: "Select Row two" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Row four" }), {
      shiftKey: true,
    });

    expect(screen.getByTestId("all-matching-selection")).toHaveTextContent(
      "inactive",
    );
    expect(selectedRangeRows()).toEqual(["Select Row one", "Select Row five"]);
  });

  it("renders visible rows checked during all-matching selection", () => {
    render(<EscalatedRangeTable />);

    for (const row of rangeRows) {
      expect(
        screen.getByRole("checkbox", { name: `Select ${row.name}` }),
      ).toBeChecked();
    }
  });
});

function TestTable() {
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
  const data: TestRow[] = [
    { id: "fixed", name: "Predefined", fixed: true },
    { id: "custom-one", name: "Custom one", fixed: false },
    { id: "custom-two", name: "Custom two", fixed: false },
  ];

  return (
    <DataTable
      columns={[
        createSelectColumn<TestRow>({
          rowLabel: (row) => `Select ${row.name}`,
          allLabel: "Select all rows",
          canSelect: (row) => !row.fixed,
          disabledReason: () => "Predefined rows cannot be deleted",
        }),
        { accessorKey: "name", header: "Name" },
      ]}
      data={data}
      getRowId={(row) => row.id}
      rowSelection={rowSelection}
      onRowSelectionChange={setRowSelection}
    />
  );
}

function RangeTable() {
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
  const columns = useMemo(
    () => [
      createSelectColumn<RangeRow>({
        rowLabel: (row) => `Select ${row.name}`,
      }),
      { accessorKey: "name", header: "Name" },
    ],
    [],
  );

  return (
    <DataTable
      columns={columns}
      data={rangeRows}
      getRowId={(row) => row.id}
      rowSelection={rowSelection}
      onRowSelectionChange={setRowSelection}
    />
  );
}

function EscalatedRangeTable() {
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
  const [allMatchingSelected, setAllMatchingSelected] = useState(true);
  const { effectiveRowSelection, onRowSelectionChange } =
    useControlledRowSelection({
      rowSelection,
      setRowSelection,
      rows: rangeRows,
      getRowId: (row) => row.id,
      allMatchingSelected,
      clearEscalation: () => setAllMatchingSelected(false),
    });
  const columns = useMemo(
    () => [
      createSelectColumn<RangeRow>({
        rowLabel: (row) => `Select ${row.name}`,
      }),
      { accessorKey: "name", header: "Name" },
    ],
    [],
  );

  return (
    <>
      <output data-testid="all-matching-selection">
        {allMatchingSelected ? "active" : "inactive"}
      </output>
      <DataTable
        columns={columns}
        data={rangeRows}
        getRowId={(row) => row.id}
        rowSelection={effectiveRowSelection}
        onRowSelectionChange={onRowSelectionChange}
      />
    </>
  );
}

function selectedRangeRows() {
  return screen
    .getAllByRole("checkbox", { name: /^Select Row/ })
    .filter((checkbox) => checkbox.getAttribute("data-state") === "checked")
    .map((checkbox) => checkbox.getAttribute("aria-label"));
}
