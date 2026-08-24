import type { ColumnDef } from "@tanstack/react-table";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Checkbox } from "./checkbox";
import { DataTable } from "./data-table";
import { DATA_TABLE_SELECT_COLUMN_SIZE } from "./data-table.constants";

type Row = { name: string; files: number };

describe("DataTable page index clamping", () => {
  const columns: ColumnDef<Row>[] = [
    { id: "name", accessorKey: "name", header: "Name" },
  ];
  const makeRows = (count: number): Row[] =>
    Array.from({ length: count }, (_, i) => ({ name: `row-${i}`, files: i }));

  it("resets to the last valid page when filtered data shrinks below the current page", async () => {
    const { rerender } = render(
      <DataTable columns={columns} data={makeRows(40)} />,
    );

    fireEvent.click(
      screen.getAllByRole("button", { name: "Go to last page" })[0],
    );
    expect(screen.getAllByText("Page 4 of 4").length).toBeGreaterThan(0);

    // Simulate applying a filter that leaves a single page of results
    rerender(<DataTable columns={columns} data={makeRows(5)} />);

    await waitFor(() => {
      expect(screen.getAllByText("Page 1 of 1").length).toBeGreaterThan(0);
    });
    expect(screen.getByText("row-0")).toBeInTheDocument();
  });

  it("notifies the parent when a controlled page index exceeds the shrunken page count", async () => {
    const onPaginationChange = vi.fn();
    const { rerender } = render(
      <DataTable
        columns={columns}
        data={makeRows(10)}
        manualPagination
        pagination={{ pageIndex: 3, pageSize: 10, total: 35 }}
        onPaginationChange={onPaginationChange}
      />,
    );
    expect(onPaginationChange).not.toHaveBeenCalled();

    rerender(
      <DataTable
        columns={columns}
        data={makeRows(5)}
        manualPagination
        pagination={{ pageIndex: 3, pageSize: 10, total: 5 }}
        onPaginationChange={onPaginationChange}
      />,
    );

    await waitFor(() => {
      expect(onPaginationChange).toHaveBeenCalledWith({
        pageIndex: 0,
        pageSize: 10,
      });
    });
  });

  it("uses the shared loading state without rendering the table or pagination", () => {
    const onPaginationChange = vi.fn();
    const { container } = render(
      <DataTable
        columns={columns}
        data={[]}
        isLoading
        manualPagination
        pagination={{ pageIndex: 3, pageSize: 10, total: 0 }}
        onPaginationChange={onPaginationChange}
      />,
    );

    expect(onPaginationChange).not.toHaveBeenCalled();
    expect(
      screen.getByRole("status", { name: "Loading results…" }),
    ).toBeVisible();
    expect(container.querySelector("table")).toBeNull();
    expect(screen.queryByText("Page 4 of 0")).toBeNull();
  });
});

// The table renders with table-fixed layout, where absolute pixel column
// widths force the table wider than its container and hide trailing columns
// behind the horizontal scroll. Sized columns must therefore get percentage
// widths (their share of the summed sizes) so they shrink to fit, while the
// actions column keeps its pixel width because its icon buttons cannot shrink.
describe("DataTable column widths", () => {
  const columns: ColumnDef<Row>[] = [
    { id: "name", accessorKey: "name", header: "Name", size: 700 },
    { id: "files", accessorKey: "files", header: "Files", size: 150 },
    { id: "actions", header: "Actions", size: 150, cell: () => null },
  ];
  const data: Row[] = [{ name: "a-skill", files: 1 }];

  it("gives sized columns a percentage share instead of a pixel width", () => {
    const { container } = render(<DataTable columns={columns} data={data} />);

    const name = container.querySelector('th[data-column-id="name"]');
    const files = container.querySelector('th[data-column-id="files"]');
    // Flexible shares split the width left after the fixed 150px actions.
    expect(name).toHaveStyle({ width: "calc(82.3529% - 123.53px)" });
    expect(files).toHaveStyle({ width: "calc(17.6471% - 26.47px)" });
  });

  it("keeps a pixel width on the actions column", () => {
    const { container } = render(<DataTable columns={columns} data={data} />);

    const actions = container.querySelector('th[data-column-id="actions"]');
    expect(actions).toHaveStyle({ width: "150px" });
  });

  it("keeps selection controls at the shared fixed square width", () => {
    const compactColumns: ColumnDef<Row>[] = [
      { id: "select", header: "Select", size: 36, cell: () => null },
      { id: "name", accessorKey: "name", header: "Name", size: 300 },
    ];
    const { container } = render(
      <DataTable columns={compactColumns} data={data} />,
    );

    const select = container.querySelector('th[data-column-id="select"]');
    expect(select).toHaveStyle({
      width: `${DATA_TABLE_SELECT_COLUMN_SIZE}px`,
      minWidth: `${DATA_TABLE_SELECT_COLUMN_SIZE}px`,
      maxWidth: `${DATA_TABLE_SELECT_COLUMN_SIZE}px`,
    });
    expect(select).toHaveClass("!p-0");
  });

  it("keeps utility columns fixed and lets the server column grow past its minimum", () => {
    const flexibleColumns: ColumnDef<Row>[] = [
      { id: "select", header: "Select", size: 36, cell: () => null },
      { id: "name", accessorKey: "name", header: "Name", size: 540 },
      { id: "issue", header: "Issue", size: 220, cell: () => null },
      { id: "owner", header: "Owner", size: 220, cell: () => null },
      { id: "actions", header: "Actions", size: 160, cell: () => null },
    ];
    const { container } = render(
      <DataTable
        columns={flexibleColumns}
        data={data}
        fixedWidthColumnIds={["select", "issue", "owner", "actions"]}
        flexibleColumnIds={["name"]}
      />,
    );

    expect(container.querySelector("table")).toHaveClass("w-full");
    expect(container.querySelector("table")).toHaveStyle({
      minWidth: "1196px",
    });
    expect(
      (container.querySelector('th[data-column-id="name"]') as HTMLElement)
        .style.width,
    ).toBe("");
    expect(container.querySelector('th[data-column-id="issue"]')).toHaveStyle({
      width: "220px",
    });
    expect(container.querySelector('th[data-column-id="owner"]')).toHaveStyle({
      width: "220px",
    });
  });
});

describe("DataTable selection cells", () => {
  it("forwards the full selection cell to its checkbox without clicking the row", () => {
    const onCheckedChange = vi.fn();
    const onRowClick = vi.fn();
    const columns: ColumnDef<Row>[] = [
      {
        id: "select",
        header: "Select",
        cell: () => (
          <Checkbox
            aria-label="Select a-skill"
            onCheckedChange={onCheckedChange}
          />
        ),
      },
      { id: "name", accessorKey: "name", header: "Name" },
    ];
    const { container } = render(
      <DataTable
        columns={columns}
        data={[{ name: "a-skill", files: 1 }]}
        onRowClick={onRowClick}
      />,
    );

    const selectionCell = container.querySelector(
      'td[data-column-id="select"]',
    );
    if (!selectionCell) throw new Error("Selection cell not rendered");
    expect(selectionCell).toHaveClass("!p-0");
    expect(selectionCell).toHaveStyle({
      width: `${DATA_TABLE_SELECT_COLUMN_SIZE}px`,
      minWidth: `${DATA_TABLE_SELECT_COLUMN_SIZE}px`,
      maxWidth: `${DATA_TABLE_SELECT_COLUMN_SIZE}px`,
    });
    fireEvent.click(selectionCell);

    expect(onCheckedChange).toHaveBeenCalledWith(true);
    expect(onRowClick).not.toHaveBeenCalled();

    const nameCell = container.querySelector('td[data-column-id="name"]');
    if (!nameCell) throw new Error("Name cell not rendered");
    fireEvent.click(nameCell);
    expect(onRowClick).toHaveBeenCalledTimes(1);
  });
});
