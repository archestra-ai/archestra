import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CompactFilterExtrasProvider,
  FilterBar,
  FilterBarContextualActions,
  FilterSelect,
  overflowFiltersThatFit,
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
    const filter = (key: string, active: boolean) => ({
      key,
      label: key,
      active,
      control: <button type="button">{`${key} control`}</button>,
    });
    const renderWithOverflow = (filters: Array<ReturnType<typeof filter>>) =>
      render(
        <FilterBar moreFilters={filters}>
          <span>primary filters</span>
        </FilterBar>,
      );
    // By role: the bar keeps hidden copies of the idle controls to measure,
    // which are not part of what a person can reach.
    const control = (key: string) =>
      screen.queryByRole("button", { name: `${key} control` });
    const more = () => screen.queryByRole("button", { name: /More filters/ });

    it("tucks idle filters that have no room behind More filters, and still opens them", async () => {
      // No layout in this environment, so the row has room for none of them.
      renderWithOverflow([filter("actor", false), filter("source", false)]);

      expect(control("actor")).not.toBeInTheDocument();
      expect(control("source")).not.toBeInTheDocument();

      await userEvent.click(more() as HTMLElement);
      expect(control("actor")).toBeVisible();
      expect(control("source")).toBeVisible();
    });

    it("shows an applied filter inline instead, so nothing narrows the table invisibly", () => {
      renderWithOverflow([
        filter("actor", true),
        filter("source", false),
        filter("status", false),
      ]);

      expect(control("actor")).toBeVisible();
      expect(control("source")).not.toBeInTheDocument();
      expect(more()).toBeVisible();
    });

    it("never opens a menu for one filter: a single leftover goes on the bar", () => {
      renderWithOverflow([filter("actor", true), filter("source", false)]);

      expect(control("source")).toBeVisible();
      expect(more()).not.toBeInTheDocument();
    });
  });
});

describe("overflowFiltersThatFit", () => {
  const candidates = [
    { key: "platform", width: 130 },
    { key: "source", width: 120 },
    { key: "repository", width: 150 },
  ];
  const fit = (width: number) =>
    overflowFiltersThatFit({
      width,
      gap: 6,
      // Search, three primary controls and the view toggle: 760 with gaps.
      fixed: [320, 180, 100, 80, 56],
      candidates,
      moreWidth: 125,
    });

  it("puts every filter on a row that has room for all of them", () => {
    // 760 + 136 + 126 + 156 = 1178; the last one needs no menu after it.
    expect(fit(1178)).toEqual(["platform", "source", "repository"]);
  });

  it("keeps room for the menu while filters remain for it", () => {
    // Platform and Source fit only if Repository's menu (131) fits after them.
    expect(fit(1177)).toEqual(["platform", "source"]);
    expect(fit(760 + 136 + 126 + 131)).toEqual(["platform", "source"]);
    expect(fit(760 + 136 + 126 + 130)).toEqual(["platform"]);
  });

  it("puts none on a row the fixed controls already fill, or one with no layout", () => {
    expect(fit(800)).toEqual([]);
    expect(fit(0)).toEqual([]);
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
    await userEvent.click(screen.getByRole("option", { name: "Create" }));
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
    await userEvent.click(screen.getByRole("option", { name: "Create" }));
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

  it("moves secondary actions into the filter popover only when asked", async () => {
    const onExport = vi.fn();
    const bar = (tuck: boolean) => (
      <FilterBar
        search={<input aria-label="Search" />}
        tuckActionsWhenCompact={tuck}
        actions={
          <button type="button" onClick={onExport}>
            Export
          </button>
        }
      >
        <FilterSelect
          value="all"
          onValueChange={() => {}}
          placeholder="Filter by action"
          items={ITEMS}
        />
      </FilterBar>
    );

    const { rerender } = render(bar(true));
    expect(
      screen.queryByRole("button", { name: "Export" }),
    ).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Filters" }));
    await userEvent.click(screen.getByRole("button", { name: "Export" }));
    expect(onExport).toHaveBeenCalledTimes(1);

    rerender(bar(false));
    await userEvent.keyboard("{Escape}");
    expect(screen.getByRole("button", { name: "Export" })).toBeVisible();
  });

  it("moves a page-level control into the filter popover, and back out without a popover to hold it", async () => {
    const page = (withFilters: boolean) => (
      <CompactFilterExtrasProvider
        extras={<button type="button">Any time</button>}
      >
        {({ claimed }) => (
          <>
            <header>
              {claimed ? null : <button type="button">Any time</button>}
            </header>
            <FilterBar search={<input aria-label="Search" />}>
              {withFilters ? (
                <FilterSelect
                  value="all"
                  onValueChange={() => {}}
                  placeholder="Filter by action"
                  items={ITEMS}
                />
              ) : null}
            </FilterBar>
          </>
        )}
      </CompactFilterExtrasProvider>
    );

    const { rerender } = render(page(true));
    expect(
      screen.queryByRole("button", { name: "Any time" }),
    ).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Filters" }));
    expect(screen.getByRole("button", { name: "Any time" })).toBeVisible();

    await userEvent.keyboard("{Escape}");
    rerender(page(false));
    expect(screen.getAllByRole("button", { name: "Any time" })).toHaveLength(1);
    expect(
      screen.queryByRole("button", { name: "Filters" }),
    ).not.toBeInTheDocument();
  });

  it("does not show a filter button on search-only lists", () => {
    render(<FilterBar search={<input aria-label="Search" />} />);
    expect(screen.getByRole("textbox")).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Filters" }),
    ).not.toBeInTheDocument();
  });
});
