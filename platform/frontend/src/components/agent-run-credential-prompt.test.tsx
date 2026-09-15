import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AgentRuntimeCredentialPrompt } from "./agent-run-credential-prompt";

describe("AgentRuntimeCredentialPrompt", () => {
  it("shows a recovery link for an incompatible runtime", async () => {
    const user = userEvent.setup();
    render(
      <AgentRuntimeCredentialPrompt
        agentId="agent-1"
        missing={[]}
        declarations={[]}
        incompatible="This Agent Runtime image expects the Anthropic API."
        onConnected={vi.fn()}
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent(
      "This model is not supported by the runtime.",
    );
    const detailsLink = screen.getByRole("link", { name: "Agent details" });
    expect(detailsLink).toHaveAttribute("href", "/agents/agent-1");
    await user.tab();
    expect(detailsLink).toHaveFocus();
    expect(
      screen.queryByText(/connections are required/),
    ).not.toBeInTheDocument();
  });
});
