import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { ClaudeCodeInferenceSettings } from "./claude-code-inference-settings";

Element.prototype.hasPointerCapture = vi.fn().mockReturnValue(false);
Element.prototype.setPointerCapture = vi.fn();
Element.prototype.releasePointerCapture = vi.fn();
Element.prototype.scrollIntoView = vi.fn();

describe("Claude Code inference settings", () => {
  it.each([
    false,
    true,
  ])("changes the billing and credential controls when switching providers (Vertex: %s)", async (vertexEnabled) => {
    const user = userEvent.setup();
    function Settings() {
      const [provider, setProvider] = useState<"anthropic" | "bedrock">(
        "anthropic",
      );
      return (
        <ClaudeCodeInferenceSettings
          provider={provider}
          vertexEnabled={vertexEnabled}
          availableProviders={["anthropic", "bedrock"]}
          onProviderChange={setProvider}
          apiKeySelector={<button type="button">Provider connection</button>}
          modelSelector={<button type="button">Selected model</button>}
          subscriptionCredential={
            <button type="button">Connect subscription</button>
          }
        />
      );
    }
    render(<Settings />);
    expect(
      screen.getByRole("combobox", { name: "Pay with" }),
    ).toHaveTextContent(
      vertexEnabled ? "Google Cloud (Vertex AI)" : "Claude subscription",
    );
    if (vertexEnabled) {
      expect(
        screen.queryByRole("button", { name: "Connect subscription" }),
      ).not.toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Provider connection" }),
      ).toBeVisible();
      expect(
        screen.getByText(/subscription token is not sent or required/),
      ).toBeVisible();
    } else {
      expect(
        screen.getByRole("button", { name: "Connect subscription" }),
      ).toBeVisible();
      expect(
        screen.queryByRole("button", { name: "Provider connection" }),
      ).not.toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Model catalog" }));
      expect(
        screen.getByRole("button", { name: "Provider connection" }),
      ).toBeVisible();
    }
    await user.click(screen.getByRole("combobox", { name: "Pay with" }));
    await user.click(screen.getByRole("option", { name: "Amazon Bedrock" }));
    expect(
      screen.getByRole("combobox", { name: "Pay with" }),
    ).toHaveTextContent("Amazon Bedrock");
    expect(
      screen.queryByRole("button", { name: "Connect subscription" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Model catalog" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Provider connection" }),
    ).toBeVisible();
    expect(screen.getByText(/cloud provider billing/)).toBeVisible();
  });
});
