import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { BulkActionsBar } from "./bulk-actions-bar";

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
});
