import type { ColumnDef } from "@tanstack/react-table";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Button } from "./button";
import { DataTable } from "./data-table";

type TestRow = {
  name: string;
};

describe("DataTable", () => {
  it("reserves stable space for actions columns", () => {
    const columns: ColumnDef<TestRow>[] = [
      {
        accessorKey: "name",
        header: "Name",
      },
      {
        id: "actions",
        header: "Actions",
        cell: () => (
          <fieldset aria-label="Row actions">
            <Button type="button">Edit</Button>
            <Button type="button">Delete</Button>
          </fieldset>
        ),
      },
    ];

    const { container } = render(
      <DataTable
        columns={columns}
        data={[{ name: "Build agent" }]}
        hidePaginationWhenSinglePage
      />,
    );

    const actionsHeader = screen.getByRole("columnheader", {
      name: "Actions",
    });
    const actionsCell = container.querySelector('td[data-column-id="actions"]');

    expect(actionsHeader).toHaveStyle({ width: "288px" });
    expect(actionsHeader).toHaveClass("whitespace-nowrap");
    expect(actionsCell).toHaveStyle({ width: "288px" });
    expect(actionsCell).toHaveClass("whitespace-nowrap");
  });
});
