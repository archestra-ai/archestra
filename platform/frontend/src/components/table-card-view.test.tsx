import type { RowSelectionState } from "@tanstack/react-table";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FilterBar } from "@/components/filter-bar";
import { BulkActions } from "@/components/ui/bulk-actions-bar";
import { createSelectColumn } from "@/components/ui/bulk-select-column";
import { DataTable } from "@/components/ui/data-table";
import { useBulkRangeSelectionController } from "@/lib/bulk-range-selection-context";
import { useBulkCardSelection } from "@/lib/hooks/use-bulk-card-selection";
import {
  TableCard,
  TableCardList,
  TableCardSelectionScope,
  TableCardView,
  TableCardViewContent,
  TableCardViewToggle,
} from "./table-card-view";

describe("TableCardView", () => {
  beforeEach(() => {
    window.localStorage.clear();
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 1024,
    });
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => createMediaQueryList()),
    );
  });

  it("persists and restores the selected desktop layout", async () => {
    window.localStorage.setItem("test-view", "table");

    render(<TestView />);

    await waitFor(() =>
      expect(screen.getByLabelText("View as table")).toHaveAttribute(
        "aria-pressed",
        "true",
      ),
    );

    fireEvent.click(screen.getByLabelText("View as cards"));

    expect(window.localStorage.getItem("test-view")).toBe("cards");
    expect(screen.getByText("Cards")).toBeVisible();
  });

  it("keeps cards rendered for mobile when table mode is selected", async () => {
    window.localStorage.setItem("test-view", "table");
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 500,
    });

    render(<TestView />);

    await waitFor(() =>
      expect(screen.getByLabelText("View as table")).toHaveAttribute(
        "aria-pressed",
        "true",
      ),
    );

    await waitFor(() => expect(screen.getByText("Cards")).toBeVisible());
    expect(screen.queryByText("Table")).not.toBeInTheDocument();
    expect(screen.getByLabelText("View as table").closest("div")).toHaveClass(
      "hidden",
      "md:inline-flex",
    );
  });

  it("keeps expensive layouts mounted when a caller opts into warm switching", () => {
    render(
      <TableCardView storageKey="warm-view" defaultMode="table">
        <TableCardViewToggle />
        <TableCardViewContent
          keepMounted
          table={<span>Warm table</span>}
          cards={<span>Warm cards</span>}
        />
      </TableCardView>,
    );

    expect(screen.getByText("Warm table").parentElement).toHaveAttribute(
      "data-active",
      "true",
    );
    expect(screen.getByText("Warm cards").parentElement).toHaveAttribute(
      "data-active",
      "false",
    );
    fireEvent.click(screen.getByLabelText("View as cards"));
    expect(screen.getByText("Warm table").parentElement).toHaveAttribute(
      "data-active",
      "false",
    );
    expect(screen.getByText("Warm cards").parentElement).toHaveAttribute(
      "data-active",
      "true",
    );
  });

  it("navigates from the card shell without shadowing nested controls", () => {
    const onNavigate = vi.fn();
    const onAction = vi.fn();
    const { container } = render(
      <TableCard
        title="Navigable card"
        onNavigate={onNavigate}
        actions={
          <button type="button" onClick={onAction}>
            Card action
          </button>
        }
      />,
    );
    const card = container.firstElementChild;
    expect(card).toBeInstanceOf(HTMLElement);
    if (!(card instanceof HTMLElement)) throw new Error("Card did not render");

    fireEvent.click(card);
    expect(onNavigate).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole("button", { name: "Card action" }));
    expect(onAction).toHaveBeenCalledOnce();
    expect(onNavigate).toHaveBeenCalledOnce();
  });

  it("keeps the Shift-range anchor when switching between table and cards", () => {
    render(<SharedRangeView />);

    fireEvent.click(screen.getByRole("checkbox", { name: "Select two" }));
    fireEvent.click(screen.getByRole("button", { name: "View as cards" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Select four" }), {
      shiftKey: true,
    });

    for (const id of ["two", "three", "four"]) {
      expect(
        screen.getByRole("checkbox", { name: `Select ${id}` }),
      ).toBeChecked();
    }
    expect(
      screen.getByRole("checkbox", { name: "Select one" }),
    ).not.toBeChecked();
  });

  it("replaces scoped filters with bulk actions without a separate reserved bar", async () => {
    const { container } = render(<ScopedBulkActionsView />);

    expect(
      screen.getByRole("button", { name: "Filter by action" }),
    ).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Delete selected" }),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Select a skill" }));

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Delete selected" }),
      ).toBeVisible(),
    );
    expect(
      screen
        .getByRole("button", { name: "Filter by action", hidden: true })
        .closest('[data-slot="filter-controls"]'),
    ).toHaveAttribute("inert");

    const bars = container.querySelectorAll('[data-slot="bulk-actions-bar"]');
    expect(bars).toHaveLength(1);
    expect(bars[0]?.parentElement).toHaveAttribute(
      "data-slot",
      "contextual-actions",
    );
  });

  it("keeps bulk selection available on cards", () => {
    const onSelectedChange = vi.fn();

    render(
      <TableCard
        title="Knowledge source"
        selected={false}
        onSelectedChange={onSelectedChange}
        selectionLabel="Select Knowledge source"
      />,
    );

    const selectionControl = screen.getByLabelText("Select Knowledge source");
    fireEvent.click(selectionControl);

    expect(onSelectedChange).toHaveBeenCalledWith(true);
  });

  it("explains why a card cannot be selected", async () => {
    const user = userEvent.setup();
    const onSelectedChange = vi.fn();

    render(
      <TableCard
        title="Unavailable source"
        selected={false}
        selectionDisabled
        selectionDisabledTooltip="Install this source before selecting it"
        onSelectedChange={onSelectedChange}
        selectionLabel="Select unavailable source"
      />,
    );

    const selectionControl = screen.getByLabelText("Select unavailable source");
    expect(selectionControl).toBeDisabled();
    await user.hover(selectionControl.parentElement ?? selectionControl);

    expect(await screen.findByRole("tooltip")).toHaveTextContent(
      "Install this source before selecting it",
    );
    fireEvent.click(selectionControl);
    expect(onSelectedChange).not.toHaveBeenCalled();
  });

  it("reports the rows visible in card mode", () => {
    const onVisibleRowIdsChange = vi.fn();

    render(
      <TableCardSelectionScope
        rowIds={["one", "two"]}
        onVisibleRowIdsChange={onVisibleRowIdsChange}
      >
        <span>Cards</span>
      </TableCardSelectionScope>,
    );

    expect(onVisibleRowIdsChange).toHaveBeenCalledWith(["one", "two"]);
  });

  it("says nothing about an empty result while cards are still loading", () => {
    render(
      <TableCardList itemCount={0} isLoading emptyMessage="No agents found">
        {null}
      </TableCardList>,
    );

    expect(screen.queryByText("No agents found")).not.toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("offers to clear filters from the empty state when filters are applied", () => {
    const onClearFilters = vi.fn();
    render(
      <TableCardList
        itemCount={0}
        hasActiveFilters
        filteredEmptyMessage="No agents match your filters"
        onClearFilters={onClearFilters}
      >
        <div />
      </TableCardList>,
    );

    expect(screen.getByText("No agents match your filters")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /clear filters/i }));
    expect(onClearFilters).toHaveBeenCalledTimes(1);
  });

  it("reports an empty result once the fetch has settled", () => {
    render(
      <TableCardList itemCount={0} emptyMessage="No agents found">
        {null}
      </TableCardList>,
    );

    expect(screen.getByText("No agents found")).toBeVisible();
  });
});

function TestView() {
  return (
    <TableCardView storageKey="test-view">
      <TableCardViewToggle />
      <TableCardViewContent
        table={<span>Table</span>}
        cards={<span>Cards</span>}
      />
    </TableCardView>
  );
}

const rangeRows = ["one", "two", "three", "four"].map((id) => ({ id }));

function SharedRangeView() {
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
  const rangeSelection = useBulkRangeSelectionController();
  const cardSelection = useBulkCardSelection({
    rows: rangeRows,
    getRowId: (row) => row.id,
    rowSelection,
    setRowSelection,
    rangeSelection,
  });

  return (
    <TableCardView storageKey="shared-range" defaultMode="table">
      <TableCardViewToggle />
      <TableCardViewContent
        table={
          <DataTable
            columns={[
              createSelectColumn<(typeof rangeRows)[number]>({
                rowLabel: (row) => `Select ${row.id}`,
              }),
              { accessorKey: "id", header: "Name" },
            ]}
            data={rangeRows}
            getRowId={(row) => row.id}
            rowSelection={rowSelection}
            onRowSelectionChange={setRowSelection}
            rangeSelection={rangeSelection}
          />
        }
        cards={rangeRows.map((row) => (
          <TableCard
            key={row.id}
            title={row.id}
            {...cardSelection(row)}
            selectionLabel={`Select ${row.id}`}
          />
        ))}
      />
    </TableCardView>
  );
}

function ScopedBulkActionsView() {
  const [count, setCount] = useState(0);

  return (
    <TableCardView storageKey="scoped-bulk-actions-view">
      <FilterBar>
        <button type="button">Filter by action</button>
      </FilterBar>
      <BulkActions count={count} noun="skill">
        <button type="button">Delete selected</button>
      </BulkActions>
      <button type="button" onClick={() => setCount(1)}>
        Select a skill
      </button>
    </TableCardView>
  );
}

function createMediaQueryList(): MediaQueryList {
  return {
    matches: false,
    media: "(max-width: 767px)",
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  };
}
