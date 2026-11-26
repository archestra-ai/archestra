import type { ColumnDef } from "@tanstack/react-table";
import { fireEvent, render, screen } from "@testing-library/react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DataTable } from "./data-table";

vi.mock("next/navigation");

type Row = { name: string };

const columns: ColumnDef<Row>[] = [
  { id: "name", accessorKey: "name", header: "Name" },
];
const rows: Row[] = Array.from({ length: 25 }, (_, index) => ({
  name: `row-${String(index + 1).padStart(2, "0")}`,
}));
const push = vi.fn();

function openAt(query: string) {
  vi.mocked(useSearchParams).mockReturnValue(
    new URLSearchParams(query) as ReturnType<typeof useSearchParams>,
  );
  return render(<DataTable columns={columns} data={rows} urlPagination />);
}

const shownRows = () =>
  screen
    .getAllByRole("row")
    .slice(1)
    .map((row) => row.textContent);

describe("DataTable with its page in the URL", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(usePathname).mockReturnValue("/plugins");
    vi.mocked(useRouter).mockReturnValue({
      push,
    } as unknown as ReturnType<typeof useRouter>);
  });

  it("opens the page the URL names, so a reload or a shared link shows the same rows", () => {
    openAt("page=3");

    expect(shownRows()).toEqual(rows.slice(20).map((row) => row.name));
    expect(screen.getAllByText("Page 3 of 3").length).toBeGreaterThan(0);
  });

  it("writes the page to the URL when the pager moves, keeping the filters", () => {
    openAt("search=row");

    fireEvent.click(
      screen.getAllByRole("button", { name: "Go to next page" })[0],
    );

    expect(push).toHaveBeenCalledWith(
      "/plugins?search=row&page=2&pageSize=10",
      {
        scroll: false,
      },
    );
  });

  it("follows the URL back to the first page after a search wrote page=1", () => {
    const view = openAt("page=3");
    expect(screen.getAllByText("Page 3 of 3").length).toBeGreaterThan(0);

    // What `SearchInput` writes when the reader types.
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams("search=row&page=1") as ReturnType<
        typeof useSearchParams
      >,
    );
    view.rerender(<DataTable columns={columns} data={rows} urlPagination />);

    expect(screen.getAllByText("Page 1 of 3").length).toBeGreaterThan(0);
    expect(shownRows()[0]).toBe("row-01");
  });

  it("sends a page past the end to the last one", () => {
    openAt("page=99");

    expect(push).toHaveBeenCalledWith("/plugins?page=3&pageSize=10", {
      scroll: false,
    });
  });

  it("reads a page that is not a number as the first page", () => {
    openAt("page=abc");

    expect(screen.getAllByText("Page 1 of 3").length).toBeGreaterThan(0);
    expect(push).not.toHaveBeenCalled();
  });

  it("leaves the URL alone for a table the caller pages itself", () => {
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams("page=3") as ReturnType<typeof useSearchParams>,
    );
    render(
      <DataTable
        columns={columns}
        data={rows.slice(0, 10)}
        urlPagination
        manualPagination
        pagination={{ pageIndex: 0, pageSize: 10, total: 25 }}
        onPaginationChange={vi.fn()}
      />,
    );

    // The caller's page wins over the URL's.
    expect(screen.getAllByText("Page 1 of 3").length).toBeGreaterThan(0);
  });
});
