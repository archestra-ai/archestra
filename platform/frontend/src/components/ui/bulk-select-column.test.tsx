import type { RowSelectionState } from "@tanstack/react-table";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { createSelectColumn } from "./bulk-select-column";
import { DataTable } from "./data-table";

type TestRow = {
  id: string;
  name: string;
  fixed: boolean;
};

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
      screen.getByRole("checkbox", { name: "Select Custom" }),
    ).toBeChecked();
    expect(
      screen.getByRole("checkbox", { name: "Select Predefined" }),
    ).not.toBeChecked();
  });
});

function TestTable() {
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
  const data: TestRow[] = [
    { id: "fixed", name: "Predefined", fixed: true },
    { id: "custom", name: "Custom", fixed: false },
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
