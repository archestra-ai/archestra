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
    expect(screen.getByText("Ready to run")).toBeVisible();
    expect(
      within(screen.getByRole("listitem")).getByText("Done"),
    ).toBeVisible();
    expect(screen.queryByRole("button", { name: "Show" })).toBeNull();
    rerender(<AgentSetupBanner items={[]} resetKey="agent-2" />);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("dismisses the settled banner but not work the agent still needs", async () => {
    const { rerender } = render(<AgentSetupBanner items={[]} showReady />);
    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("status")).toBeNull();

    rerender(
      <AgentSetupBanner
        items={[
          { id: "key", label: "Connect your Claude account", status: "now" },
        ]}
        showReady
      />,
    );
    expect(screen.getByText("Before it runs")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull();
  });

  it("keeps many requirements to two rows until asked for the rest", async () => {
    const items = Array.from({ length: 10 }, (_, index) => ({
      id: `key-${index}`,
      label: `Credential ${index + 1}`,
      status: "now" as const,
      action: <button type="button">{`Set up ${index + 1}`}</button>,
    }));
    render(<AgentSetupBanner items={items} />);

    expect(screen.getByText("Credential 5")).toBeVisible();
    expect(screen.queryByText("Credential 6")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Show 5 more" }));
    expect(screen.getByRole("button", { name: "Set up 10" })).toBeVisible();
  });
});
