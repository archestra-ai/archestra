import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AgentProviderIndicator } from "./agent-provider-indicator";

describe("AgentProviderIndicator", () => {
  it("reveals the configured key and model on keyboard focus without opening the agent", async () => {
    const navigate = vi.fn();
    const user = userEvent.setup();
    render(
      // biome-ignore lint/a11y/noStaticElementInteractions: simulates the surrounding clickable table row
      <div onClick={navigate} onKeyDown={navigate}>
        <AgentProviderIndicator
          provider="openai"
          keyName="Research workspace"
          modelName="gpt-5.4"
        />
      </div>,
    );

    expect(screen.queryByText("Research workspace")).not.toBeInTheDocument();
    await user.tab();
    const tooltip = await screen.findByRole("tooltip");
    expect(within(tooltip).getByText("Research workspace")).toBeInTheDocument();
    expect(within(tooltip).getByText("gpt-5.4")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button"));
    expect(navigate).not.toHaveBeenCalled();
  });

  it("identifies an unpinned agent as using the organization default", async () => {
    render(<AgentProviderIndicator usesOrganizationDefault />);
    await userEvent.setup().tab();
    const tooltip = await screen.findByRole("tooltip");
    expect(within(tooltip).getAllByText("Organization default")).toHaveLength(
      2,
    );
    expect(
      within(tooltip).queryByText("No key configured"),
    ).not.toBeInTheDocument();
    expect(
      within(tooltip).queryByText("No model pinned"),
    ).not.toBeInTheDocument();
  });
});
