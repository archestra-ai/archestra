import type { ColumnDef } from "@tanstack/react-table";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DataTable } from "./data-table";

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

  it("does not clamp while loading", () => {
    const onPaginationChange = vi.fn();
    render(
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
    // total size = 700 + 150 + 150 = 1000
    expect(name).toHaveStyle({ width: "70.0000%" });
    expect(files).toHaveStyle({ width: "15.0000%" });
  });

  it("keeps a pixel width on the actions column", () => {
    const { container } = render(<DataTable columns={columns} data={data} />);

    const actions = container.querySelector('th[data-column-id="actions"]');
    expect(actions).toHaveStyle({ width: "150px" });
  });
});
