/**
 * Accessibility contract for the "Limited for complex tasks" chip: the
 * guidance must be reachable without a mouse hover. The chip is a real button
 * opening a Popover, so keyboard users can focus it and open it with
 * Enter/Space, and touch users get it on tap.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { NotRecommendedForAgentsNoticeBadge } from "./agent-recommendation-notice";

// Radix popper positioning uses ResizeObserver, which jsdom lacks.
global.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
} as typeof ResizeObserver;

const guidance = /works best for simple questions/i;

describe("NotRecommendedForAgentsNoticeBadge", () => {
  it("opens and closes the guidance from the keyboard", async () => {
    const user = userEvent.setup();
    render(<NotRecommendedForAgentsNoticeBadge />);

    const trigger = screen.getByRole("button", {
      name: /limited for complex tasks/i,
    });
    await user.tab();
    expect(trigger).toHaveFocus();

    await user.keyboard("{Enter}");
    expect(screen.getByText(guidance)).toBeInTheDocument();

    await user.keyboard("{Escape}");
    expect(screen.queryByText(guidance)).not.toBeInTheDocument();
  });

  it("opens the guidance on click (the touch path)", async () => {
    const user = userEvent.setup();
    render(<NotRecommendedForAgentsNoticeBadge />);

    await user.click(
      screen.getByRole("button", { name: /limited for complex tasks/i }),
    );
    expect(screen.getByText(guidance)).toBeInTheDocument();
  });
});
