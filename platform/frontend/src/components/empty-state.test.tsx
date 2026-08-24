import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Bot } from "lucide-react";
import { describe, expect, it, vi } from "vitest";
import { EmptyState } from "./empty-state";

describe("EmptyState", () => {
  it("states what is missing and why, as a heading over a hint", () => {
    render(
      <EmptyState
        icon={Bot}
        title="No agents match your filters"
        description="Try adjusting your search or filters."
      />,
    );

    expect(
      screen.getByRole("heading", { name: "No agents match your filters" }),
    ).toBeVisible();
    expect(
      screen.getByText("Try adjusting your search or filters."),
    ).toBeVisible();
  });

  it("offers to clear filters only when a handler says filters are applied", async () => {
    const onClearFilters = vi.fn();
    const { rerender } = render(<EmptyState title="No agents yet" />);

    // Nothing is filtering, so there is nothing to reset — offering it would
    // make a genuinely empty list look like a mistake the user could undo.
    expect(
      screen.queryByRole("button", { name: /clear filters/i }),
    ).not.toBeInTheDocument();

    rerender(
      <EmptyState
        title="No agents match your filters"
        onClearFilters={onClearFilters}
      />,
    );

    await userEvent.click(
      screen.getByRole("button", { name: /clear filters/i }),
    );
    expect(onClearFilters).toHaveBeenCalledTimes(1);
  });

  it("renders a call to action for a list nothing has been added to yet", () => {
    render(
      <EmptyState
        title="No skills yet"
        action={<button type="button">Add your first skill</button>}
      />,
    );

    expect(
      screen.getByRole("button", { name: "Add your first skill" }),
    ).toBeVisible();
  });
});
