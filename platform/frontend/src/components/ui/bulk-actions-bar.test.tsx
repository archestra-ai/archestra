import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { BulkActions, BulkActionsBar } from "./bulk-actions-bar";

describe("BulkActionsBar", () => {
  it("renders no bar until something is selected", () => {
    const { container, rerender } = render(
      <BulkActionsBar count={0} noun="skill">
        <button type="button">Delete</button>
      </BulkActionsBar>,
    );

    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();

    // The live region is still mounted at zero, so the first selection is
    // announced as a change to an existing region rather than silently
    // inserted with its text already in place.
    const liveRegion = container.querySelector('[aria-live="polite"]');
    expect(liveRegion).not.toBeNull();
    expect(liveRegion?.textContent).toBe("");

    rerender(
      <BulkActionsBar count={2} noun="skill">
        <button type="button">Delete</button>
      </BulkActionsBar>,
    );

    expect(screen.getByRole("button", { name: "Delete" })).toBeTruthy();
    expect(container.querySelector('[aria-live="polite"]')?.textContent).toBe(
      "2 skills selected",
    );
  });

  it("pluralizes the count, honouring an irregular plural", () => {
    // The wording appears twice by design — once in the live region, once
    // visibly — so assert on the visible count rather than the document.
    const visibleCount = () => screen.getByTestId("count").textContent;

    const { rerender } = render(
      <BulkActionsBar count={1} noun="skill" countTestId="count" />,
    );
    expect(visibleCount()).toBe("1 skill selected");

    rerender(<BulkActionsBar count={3} noun="skill" countTestId="count" />);
    expect(visibleCount()).toBe("3 skills selected");

    rerender(
      <BulkActionsBar
        count={3}
        noun="entry"
        plural="entries"
        countTestId="count"
      />,
    );
    expect(visibleCount()).toBe("3 entries selected");
  });

  it("shows a caller-supplied label when the action count differs from the row count", () => {
    // One directory is ticked, but the action applies to the 7 documents in it.
    render(
      <BulkActionsBar
        count={1}
        noun="document"
        label="7 documents selected"
        countTestId="count"
      />,
    );

    expect(screen.getByTestId("count").textContent).toBe(
      "7 documents selected",
    );
    expect(screen.queryByText("1 document selected")).toBeNull();
  });

  it("offers Clear only when the caller can handle it", () => {
    const onClear = vi.fn();
    const { rerender } = render(<BulkActionsBar count={2} noun="skill" />);
    expect(screen.queryByRole("button", { name: "Clear" })).toBeNull();

    rerender(<BulkActionsBar count={2} noun="skill" onClear={onClear} />);
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it("reserves a compact in-flow slot by default for collection actions", () => {
    const { container, rerender } = render(
      <BulkActions count={0} noun="skill" countTestId="count" />,
    );

    const emptySlot = container.querySelector('[data-slot="bulk-actions-bar"]');
    expect(emptySlot?.className).toContain("h-[42px]");
    expect(emptySlot?.className).toContain("!mb-3");
    expect(emptySlot?.className).toContain("[&+*]:!mt-0");
    expect(screen.queryByRole("button")).toBeNull();
    expect(container.querySelector('[aria-live="polite"]')?.textContent).toBe(
      "",
    );

    rerender(<BulkActions count={2} noun="skill" countTestId="count" />);

    const selectedSlot = container.querySelector(
      '[data-slot="bulk-actions-bar"]',
    );
    expect(selectedSlot?.className).toContain("w-full");
    expect(selectedSlot?.className).toContain("h-[42px]");
    expect(selectedSlot?.className).toContain("!mb-3");
    expect(selectedSlot?.className).toContain("[&+*]:!mt-0");
    expect(selectedSlot?.querySelector("div")?.className).toContain(
      "flex-nowrap",
    );
    expect(selectedSlot?.querySelector("div")?.className).toContain(
      "overflow-x-auto",
    );
    expect(screen.getByTestId("count").textContent).toBe("2 skills selected");
  });

  it("lets a caller-owned contextual toolbar render the compact bar without an empty reserved slot", () => {
    const { container, rerender } = render(
      <BulkActions count={0} noun="skill" reserveSpace={false} />,
    );

    expect(
      container.querySelector('[data-slot="bulk-actions-bar"]'),
    ).toBeNull();
    expect(container.querySelector('[aria-live="polite"]')).not.toBeNull();

    rerender(
      <BulkActions
        count={1}
        noun="skill"
        reserveSpace={false}
        countTestId="count"
      />,
    );

    expect(screen.getByTestId("count").textContent).toBe("1 skill selected");
  });

  it("blocks an ID-list action above the default bulk limit", () => {
    render(
      <BulkActions count={501} noun="skill">
        <button type="button">Delete</button>
      </BulkActions>,
    );

    expect(screen.getByRole("button", { name: "Delete" })).toBeDisabled();
    expect(
      screen.getByText("Select at most 500 items at a time."),
    ).toBeVisible();
  });

  it("disables actions while the matching set or mutation is busy", () => {
    render(
      <BulkActions count={2} noun="skill" busy>
        <button type="button">Delete</button>
      </BulkActions>,
    );

    expect(screen.getByRole("button", { name: "Delete" })).toBeDisabled();
  });

  describe("selecting past the current page", () => {
    const selectAll = (over: Partial<Parameters<typeof BulkActionsBar>[0]>) =>
      render(
        <BulkActionsBar
          count={10}
          noun="skill"
          countTestId="count"
          selectAllMatching={{
            total: 203,
            pageFullySelected: true,
            active: false,
            onSelectAll: vi.fn(),
            matchDescription: "match this search query",
          }}
          {...over}
        />,
      );

    const offer = () => screen.queryByRole("button", { name: /^Select all/ });

    it("offers the whole matching set once the page is exhausted", () => {
      selectAll({});

      expect(offer()?.textContent).toBe(
        "Select all 203 skills that match this search query.",
      );
      expect(screen.getByText("10 skills on this page selected.")).toBeTruthy();
    });

    it("stays quiet until every row on the page is ticked", () => {
      selectAll({
        selectAllMatching: {
          total: 203,
          pageFullySelected: false,
          active: false,
          onSelectAll: vi.fn(),
        },
      });

      expect(offer()).toBeNull();
    });

    it("withholds the escalation while bulk actions are busy", () => {
      selectAll({ busy: true });

      expect(offer()).toBeNull();
    });

    it("stays quiet when the page already holds everything that matches", () => {
      selectAll({
        count: 203,
        selectAllMatching: {
          total: 203,
          pageFullySelected: true,
          active: false,
          onSelectAll: vi.fn(),
        },
      });

      expect(offer()).toBeNull();
    });

    it("withholds the offer when the batch would exceed what the action can carry", () => {
      selectAll({
        selectAllMatching: {
          total: 501,
          pageFullySelected: true,
          active: false,
          onSelectAll: vi.fn(),
          max: 500,
        },
      });

      expect(offer()).toBeNull();
    });

    /**
     * The counterpart to the test above: `max` exists for callers that send an
     * id list, and a caller that sends the FILTER instead has no such ceiling.
     * Withholding the offer there would hide the escalation from exactly the
     * corpora it exists for — a connector with 22,921 documents.
     */
    it("offers the whole set however large it is when no cap is declared", () => {
      selectAll({
        noun: "document",
        selectAllMatching: {
          total: 22_921,
          pageFullySelected: true,
          active: false,
          onSelectAll: vi.fn(),
        },
      });

      expect(offer()?.textContent).toContain("22921");
    });

    it("reports the whole set once escalated, and stops re-offering it", () => {
      const onSelectAll = vi.fn();
      selectAll({
        selectAllMatching: {
          total: 203,
          pageFullySelected: true,
          active: true,
          onSelectAll,
          matchDescription: "match this search query",
        },
      });

      expect(screen.getByTestId("count").textContent).toBe(
        "All 203 skills selected",
      );
      expect(offer()).toBeNull();
    });

    it("escalates through the caller's handler", () => {
      const onSelectAll = vi.fn();
      selectAll({
        selectAllMatching: {
          total: 203,
          pageFullySelected: true,
          active: false,
          onSelectAll,
        },
      });

      fireEvent.click(screen.getByRole("button", { name: /^Select all/ }));
      expect(onSelectAll).toHaveBeenCalledTimes(1);
    });
  });
});
