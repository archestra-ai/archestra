import type { SupportedProvider } from "@archestra/shared";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ClaudeProviderConnections } from "./claude-provider-connections";

vi.mock("@/lib/integration-overrides", () => ({
  useModelProviderCatalog: () => ({
    label: (provider: string) =>
      ({ anthropic: "Anthropic", bedrock: "Amazon Bedrock", openai: "OpenAI" })[
        provider
      ] ?? provider,
  }),
}));

const canRunClaude = (provider: SupportedProvider) =>
  provider === "anthropic" || provider === "bedrock";

describe("ClaudeProviderConnections", () => {
  it("lists only connections that can run Claude, and says how many are hidden", async () => {
    const onSelect = vi.fn();
    render(
      <ClaudeProviderConnections
        keys={[
          {
            id: "k1",
            name: "Platform key",
            provider: "anthropic",
            scope: "team",
            teamName: "Platform",
          },
          { id: "k2", name: "prod", provider: "bedrock", scope: "org" },
          { id: "k3", name: "OpenAI main", provider: "openai", scope: "org" },
        ]}
        selectedKeyId={null}
        onSelect={onSelect}
        canRunClaude={canRunClaude}
        onUseSubscription={vi.fn()}
      />,
    );

    expect(screen.getAllByRole("radio")).toHaveLength(2);
    expect(screen.getByText("Anthropic · Platform team")).toBeVisible();
    expect(screen.getByText("Amazon Bedrock · Organization")).toBeVisible();
    expect(screen.queryByText("OpenAI main")).toBeNull();
    expect(screen.getByText(/1 other is hidden/)).toBeVisible();

    await userEvent.click(screen.getByRole("radio", { name: /prod/ }));
    expect(onSelect).toHaveBeenCalledWith("k2");
  });

  it("offers adding a key or switching to subscriptions when none can run Claude", async () => {
    const onAddApiKey = vi.fn();
    const onUseSubscription = vi.fn();
    render(
      <ClaudeProviderConnections
        keys={[{ id: "k3", name: "OpenAI main", provider: "openai" }]}
        selectedKeyId={null}
        onSelect={vi.fn()}
        canRunClaude={canRunClaude}
        onAddApiKey={onAddApiKey}
        onUseSubscription={onUseSubscription}
      />,
    );

    expect(screen.getByText("No connection here can run Claude")).toBeVisible();
    await userEvent.click(
      screen.getByRole("button", { name: "Add an Anthropic key" }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Use each person's subscription" }),
    );
    expect(onAddApiKey).toHaveBeenCalledOnce();
    expect(onUseSubscription).toHaveBeenCalledOnce();
  });
});
