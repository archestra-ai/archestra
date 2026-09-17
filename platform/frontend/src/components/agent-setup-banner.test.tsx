import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AgentSetupBanner } from "./agent-setup-banner";

describe("AgentSetupBanner", () => {
  it("keeps resolved work visible, removes its action, and resets for another agent", async () => {
    const show = vi.fn();
    const item = {
      id: "key",
      label: "Choose a connection",
      status: "now" as const,
      action: (
        <button type="button" onClick={show}>
          Show
        </button>
      ),
    };
    const { rerender } = render(
      <AgentSetupBanner items={[item]} resetKey="agent-1" />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Show" }));
    expect(show).toHaveBeenCalledOnce();
    rerender(<AgentSetupBanner items={[]} resetKey="agent-1" />);
    expect(screen.getByText("Ready to run.")).toBeVisible();
    expect(
      within(screen.getByRole("listitem")).getByText("Done"),
    ).toBeVisible();
    expect(screen.queryByRole("button", { name: "Show" })).toBeNull();
    rerender(<AgentSetupBanner items={[]} resetKey="agent-2" />);
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
