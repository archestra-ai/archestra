import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TablePagination } from "./table-pagination";

describe("TablePagination navigation", () => {
  it.each([
    false,
    true,
  ])("moves both desktop and mobile controls one page at a time (compact=%s)", (compact) => {
    const onPaginationChange = vi.fn();
    render(
      <TablePagination
        pageIndex={1}
        pageSize={10}
        total={35}
        compact={compact}
        onPaginationChange={onPaginationChange}
      />,
    );

    for (const button of screen.getAllByRole("button", {
      name: "Go to previous page",
    })) {
      fireEvent.click(button);
      expect(onPaginationChange).toHaveBeenLastCalledWith({
        pageIndex: 0,
        pageSize: 10,
      });
    }
    for (const button of screen.getAllByRole("button", {
      name: "Go to next page",
    })) {
      fireEvent.click(button);
      expect(onPaginationChange).toHaveBeenLastCalledWith({
        pageIndex: 2,
        pageSize: 10,
      });
    }
    expect(onPaginationChange).toHaveBeenCalledTimes(4);
    expect(screen.getByText("2 / 4")).toBeInTheDocument();
  });

  it.each([
    { pageIndex: 0, total: 35, previousDisabled: true, nextDisabled: false },
    { pageIndex: 3, total: 35, previousDisabled: false, nextDisabled: true },
    { pageIndex: 0, total: 0, previousDisabled: true, nextDisabled: true },
  ])("disables navigation beyond the available pages (page=$pageIndex, total=$total)", ({
    pageIndex,
    total,
    previousDisabled,
    nextDisabled,
  }) => {
    const onPaginationChange = vi.fn();
    render(
      <TablePagination
        pageIndex={pageIndex}
        pageSize={10}
        total={total}
        onPaginationChange={onPaginationChange}
      />,
    );

    for (const [name, disabled] of [
      ["Go to previous page", previousDisabled],
      ["Go to next page", nextDisabled],
    ] as const) {
      for (const button of screen.getAllByRole("button", { name })) {
        expect((button as HTMLButtonElement).disabled).toBe(disabled);
        if (disabled) fireEvent.click(button);
      }
    }
    expect(onPaginationChange).not.toHaveBeenCalled();
  });
});
