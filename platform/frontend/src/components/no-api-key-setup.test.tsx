import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { NoApiKeySetup } from "./no-api-key-setup";

vi.mock("@/components/create-llm-provider-api-key-dialog", () => ({
  CreateLlmProviderApiKeyDialog: ({
    open,
    title,
    defaultValues,
  }: {
    open: boolean;
    title: string;
    defaultValues?: { provider?: string; authMethod?: string };
  }) =>
    open ? (
      <div role="dialog" aria-label={title}>
        <span>{defaultValues?.provider}</span>
        <span>{defaultValues?.authMethod}</span>
      </div>
    ) : null,
}));

describe("NoApiKeySetup", () => {
  it("offers subscriptions alongside the API key setup", async () => {
    const user = userEvent.setup();
    render(<NoApiKeySetup />);

    expect(
      screen.getByRole("button", { name: "Sign in with ChatGPT" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Sign in with GitHub Copilot" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: "Sign in with Microsoft 365 Copilot",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Sign in with Grok" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Add API Key" }),
    ).toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: "Sign in with ChatGPT" }),
    );

    expect(
      screen.getByRole("dialog", { name: "Sign in with ChatGPT" }),
    ).toBeInTheDocument();
    expect(screen.getByText("openai")).toBeInTheDocument();
    expect(screen.getByText("subscription")).toBeInTheDocument();
  });
});
