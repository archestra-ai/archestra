import type { ColumnDef } from "@tanstack/react-table";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DataTable } from "./data-table";

type Row = { name: string; files: number };

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

// autoResetPageIndex is off, so shrinking the (client-side) row count below the
// current page used to strand the table on a nonexistent page ("Page 4 of 1"
// with an empty body). The table must clamp back to the last valid page. #6639
describe("DataTable client-side page clamping", () => {
  const columns: ColumnDef<Row>[] = [
    { id: "name", accessorKey: "name", header: "Name" },
  ];
  const makeRows = (n: number): Row[] =>
    Array.from({ length: n }, (_, i) => ({ name: `row-${i}`, files: i }));

  it("clamps to the last valid page when a filter shrinks the rows", async () => {
    // 25 rows / pageSize 10 => 3 pages.
    const { rerender } = render(
      <DataTable columns={columns} data={makeRows(25)} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Go to last page" }));
    // Page 3 shows rows 20-24, not row-0.
    expect(screen.getByText("row-20")).toBeInTheDocument();
    expect(screen.queryByText("row-0")).not.toBeInTheDocument();

    // Filter down to 3 rows => a single page. Stranded on page 3 without the fix.
    rerender(<DataTable columns={columns} data={makeRows(3)} />);

    expect(await screen.findByText("row-0")).toBeInTheDocument();
    expect(screen.getByText("Page 1 of 1")).toBeInTheDocument();
  });
});
