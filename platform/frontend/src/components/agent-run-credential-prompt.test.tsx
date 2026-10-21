import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { throwOnApiError } from "@/lib/utils/api";
import {
  AgentRuntimeCredentialPrompt,
  AgentRuntimePreflightError,
} from "./agent-run-credential-prompt";

describe("AgentRuntimeCredentialPrompt", () => {
  it("shows a recovery link for an incompatible runtime", async () => {
    const user = userEvent.setup();
    render(
      <AgentRuntimeCredentialPrompt
        agentId="agent-1"
        missing={[]}
        declarations={[]}
        incompatible="This managed agent image expects the Anthropic API."
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

  it("shows only the admin-only notice when an organization credential blocks the run", () => {
    render(
      <AgentRuntimeCredentialPrompt
        agentId="agent-1"
        missing={[
          {
            key: "MIRROR_TOKEN",
            label: "Private mirror sync",
            canConnect: false,
            adminOnly: true,
          },
          {
            key: "NITPICK_KEY",
            label: "Nitpicker model-router key",
            canConnect: false,
            adminOnly: true,
          },
          { key: "GITHUB_TOKEN", label: "GitHub account" },
          { key: "OTHER", label: "Other secret", canConnect: false },
        ]}
        declarations={[]}
        incompatible="This model is not supported."
        onConnected={vi.fn()}
      />,
    );

    expect(screen.getAllByText("Only admins can run this agent")).toHaveLength(
      1,
    );
    expect(
      screen.getByText(
        "It uses Private mirror sync and Nitpicker model-router key from your organization. Ask an admin to run it for you or change its setup.",
      ),
    ).toBeInTheDocument();
    // Connecting anything else would not let them run it, so nothing else is asked.
    expect(screen.queryByRole("button", { name: "Connect" })).toBeNull();
    expect(screen.queryByText(/GitHub account/)).toBeNull();
    expect(screen.queryByText(/Other secret/)).toBeNull();
    expect(screen.queryByText(/not supported/)).toBeNull();
  });
});

describe("AgentRuntimePreflightError", () => {
  it("says a refused setup check is about access and offers no retry", () => {
    render(
      <AgentRuntimePreflightError
        error={queryErrorFor("api_authorization_error")}
        onRetry={vi.fn()}
      />,
    );

    expect(
      screen.getByText(
        "You don't have access to it. Ask an admin if you need it.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("offers a retry when the setup check did not get through", async () => {
    const onRetry = vi.fn();
    render(
      <AgentRuntimePreflightError
        error={new TypeError("Failed to fetch")}
        onRetry={onRetry}
      />,
    );

    expect(screen.getByText(/internet connection/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});

function queryErrorFor(type: string): unknown {
  try {
    throwOnApiError(
      { error: { message: "Refused", type } },
      { toastOnError: false },
    );
  } catch (error) {
    return error;
  }
  throw new Error("throwOnApiError did not throw");
}
