import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  CollectionFilters,
  FilterBar,
  FilterBarContextualActions,
  FilterSelect,
} from "@/components/filter-bar";

const ITEMS = [
  { value: "all", label: "All actions" },
  { value: "create", label: "Create" },
];

describe("CollectionFilters", () => {
  it("owns the 12px gap to the next sibling even inside a space-y stack", () => {
    const { container } = render(
      <div className="space-y-6">
        <CollectionFilters>filters</CollectionFilters>
        <div>table</div>
      </div>,
    );

    const slot = container.querySelector('[data-slot="collection-filters"]');
    expect(slot?.className).toContain("mb-3");
    expect(slot?.className).toContain("[&+*]:!mt-0");
  });
});

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

  it("accents the trigger once the value leaves the inactive sentinel", () => {
    const { rerender } = render(
      <FilterSelect
        value="all"
        onValueChange={vi.fn()}
        placeholder="Filter by action"
        items={ITEMS}
      />,
    );
    const idle = screen.getByRole("combobox", { name: "Filter by action" });
    expect(idle.className).not.toContain("bg-primary/10");

    rerender(
      <FilterSelect
        value="create"
        onValueChange={vi.fn()}
        placeholder="Filter by action"
        items={ITEMS}
      />,
    );
    expect(
      screen.getByRole("combobox", { name: "Filter by action" }).className,
    ).toContain("bg-primary/10");
  });
});
