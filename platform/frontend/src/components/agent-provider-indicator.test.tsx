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

  it("explains missing configuration without implying a runtime default", async () => {
    render(<AgentProviderIndicator />);
    await userEvent.setup().tab();
    const tooltip = await screen.findByRole("tooltip");
    expect(within(tooltip).getByText("No key configured")).toBeInTheDocument();
    expect(within(tooltip).getByText("No model pinned")).toBeInTheDocument();
  });
});
