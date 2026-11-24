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

    expect(screen.getByText("No agents match your filters")).toBeVisible();
    // The title must not be a heading: it would make every page-title
    // locator ambiguous, "Agents" being a substring of "No agents found".
    expect(
      screen.queryByRole("heading", { name: /no agents/i }),
    ).not.toBeInTheDocument();
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

  it("first use: shows both actions to someone who can act, and the reader line to someone who can't", () => {
    const props = {
      variant: "firstUse" as const,
      title: "Send each session to the right model",
      action: <button type="button">Create an auto router</button>,
      secondaryAction: <a href="/docs">How auto routing works</a>,
      readerMessage: "Your admins haven't created an auto router yet.",
    };
    const { rerender } = render(<EmptyState {...props} canAct />);
    expect(
      screen.getByRole("button", { name: "Create an auto router" }),
    ).toBeVisible();
    expect(
      screen.getByRole("link", { name: "How auto routing works" }),
    ).toBeVisible();
    expect(screen.queryByText(props.readerMessage)).not.toBeInTheDocument();

    rerender(<EmptyState {...props} canAct={false} />);
    expect(screen.getByText(props.readerMessage)).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Create an auto router" }),
    ).not.toBeInTheDocument();

    // Permissions still loading: neither, so nothing flickers.
    rerender(<EmptyState {...props} canAct={undefined} />);
    expect(screen.queryByText(props.readerMessage)).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Create an auto router" }),
    ).not.toBeInTheDocument();
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
