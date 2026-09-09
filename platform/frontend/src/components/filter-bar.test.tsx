import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FilterBar,
  FilterBarContextualActions,
  FilterSelect,
} from "@/components/filter-bar";

const ITEMS = [
  { value: "all", label: "All actions" },
  { value: "create", label: "Create" },
];

describe("FilterBar", () => {
  it("renders a Clear control only while filters are applied", async () => {
    const onClearFilters = vi.fn();
    const { rerender } = render(<FilterBar>filters</FilterBar>);
    expect(
      screen.queryByRole("button", { name: "Clear" }),
    ).not.toBeInTheDocument();

    rerender(<FilterBar onClearFilters={onClearFilters}>filters</FilterBar>);
    await userEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(onClearFilters).toHaveBeenCalledOnce();
  });

  it("swaps selection actions into the existing toolbar slot without hiding them from assistive technology", () => {
    render(
      <FilterBar contextualActions={<span>2 skills selected</span>}>
        <button type="button">Filter by action</button>
      </FilterBar>,
    );

    expect(screen.getByText("2 skills selected")).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Filter by action" }),
    ).toBeInTheDocument();
  });

  it("accepts collection-owned contextual actions without lifting their state", () => {
    const view = (active: boolean) => (
      <>
        <FilterBar contextualActionsTargetId="test-actions">
          <button type="button">Filter by action</button>
        </FilterBar>
        <FilterBarContextualActions targetId="test-actions" active={active}>
          <button type="button">Delete selected</button>
        </FilterBarContextualActions>
      </>
    );
    const { rerender } = render(view(true));

    expect(
      screen.getByRole("button", { name: "Delete selected" }),
    ).toBeVisible();
    expect(
      screen
        .getByRole("button", { name: "Filter by action", hidden: true })
        .closest('[data-slot="filter-controls"]'),
    ).toHaveAttribute("inert");

    rerender(view(false));
    expect(
      screen.queryByRole("button", { name: "Delete selected" }),
    ).not.toBeInTheDocument();
    expect(
      screen
        .getByRole("button", { name: "Filter by action" })
        .closest('[data-slot="filter-controls"]'),
    ).not.toHaveAttribute("inert");
  });

  describe("moreFilters", () => {
    const renderWithOverflow = (active: boolean) =>
      render(
        <FilterBar
          moreFilters={[
            {
              key: "actorType",
              label: "Actor type",
              active,
              control: <button type="button">actor type control</button>,
            },
          ]}
        >
          <span>primary filters</span>
        </FilterBar>,
      );

    it("tucks an idle filter behind More filters, and still opens it", async () => {
      renderWithOverflow(false);

      expect(screen.queryByText("actor type control")).not.toBeInTheDocument();

      await userEvent.click(
        screen.getByRole("button", { name: /More filters/ }),
      );
      expect(screen.getByText("actor type control")).toBeVisible();
    });

    it("shows an applied filter inline instead, so nothing narrows the table invisibly", () => {
      renderWithOverflow(true);

      expect(screen.getByText("actor type control")).toBeVisible();
      // Nothing left to tuck away, so the popover trigger goes too.
      expect(
        screen.queryByRole("button", { name: /More filters/ }),
      ).not.toBeInTheDocument();
    });
  });
});

describe("FilterSelect", () => {
  it("names its trigger, which role=combobox does not take from its contents", () => {
    render(
      <FilterSelect
        value="all"
        onValueChange={vi.fn()}
        placeholder="Filter by action"
        items={ITEMS}
      />,
    );

    expect(
      screen.getByRole("combobox", { name: "Filter by action" }),
    ).toBeInTheDocument();
  });

  it("prefers an explicit ariaLabel over the placeholder", () => {
    render(
      <FilterSelect
        value="all"
        onValueChange={vi.fn()}
        placeholder="Filter by action"
        ariaLabel="Audit action"
        items={ITEMS}
      />,
    );

    expect(
      screen.getByRole("combobox", { name: "Audit action" }),
    ).toBeInTheDocument();
  });
});

describe("compact filters", () => {
  let compact: boolean;
  let listeners: Set<() => void>;

  beforeEach(() => {
    compact = true;
    listeners = new Set();
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query === "(max-width: 1023px)" && compact,
      media: query,
      addEventListener: (_event: string, listener: () => void) =>
        listeners.add(listener),
      removeEventListener: (_event: string, listener: () => void) =>
        listeners.delete(listener),
    }));
  });
  afterEach(() => vi.unstubAllGlobals());

  function FilteredList() {
    const [action, setAction] = useState("all");
    return (
      <>
        <FilterBar
          search={<input aria-label="Search entries" />}
          onClearFilters={action !== "all" ? () => setAction("all") : undefined}
          moreFilters={[
            {
              key: "actor",
              label: "Actor",
              active: false,
              control: <button type="button">All actors</button>,
            },
          ]}
        >
          <FilterSelect
            value={action}
            onValueChange={setAction}
            placeholder="Filter by action"
            items={ITEMS}
          />
        </FilterBar>
        <ul>
          {(action === "all"
            ? ["Created entry", "Deleted entry"]
            : ["Created entry"]
          ).map((entry) => (
            <li key={entry}>{entry}</li>
          ))}
        </ul>
      </>
    );
  }

  it("keeps search visible and applies and clears a filter inside the popover", async () => {
    render(<FilteredList />);
    expect(
      screen.getByRole("textbox", { name: "Search entries" }),
    ).toBeVisible();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Filters" }));
    expect(screen.getByRole("button", { name: "All actors" })).toBeVisible();
    expect(
      screen.queryByRole("button", { name: /More filters/ }),
    ).not.toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("combobox", { name: "Filter by action" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(screen.queryByText("Deleted entry")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Filters (active)" }),
    ).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(screen.getByText("Deleted entry")).toBeVisible();
  });

  it("retains search and selected filters when resizing between compact and desktop layouts", async () => {
    render(<FilteredList />);
    await userEvent.type(screen.getByRole("textbox"), "entry");
    await userEvent.click(screen.getByRole("button", { name: "Filters" }));
    await userEvent.click(
      screen.getByRole("combobox", { name: "Filter by action" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Create" }));
    act(() => {
      compact = false;
      listeners.forEach((listener) => {
        listener();
      });
    });
    expect(
      screen.queryByRole("button", { name: "Filters (active)" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("combobox", { name: "Filter by action" }),
    ).toHaveTextContent("Create");
    expect(screen.getByRole("textbox")).toHaveValue("entry");
    act(() => {
      compact = true;
      listeners.forEach((listener) => {
        listener();
      });
    });
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Filters (active)" }),
    ).toBeVisible();
    expect(screen.queryByText("Deleted entry")).not.toBeInTheDocument();
  });

  it("does not show a filter button on search-only lists", () => {
    render(<FilterBar search={<input aria-label="Search" />} />);
    expect(screen.getByRole("textbox")).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Filters" }),
    ).not.toBeInTheDocument();
  });
});
