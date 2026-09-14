import { SupportedProviders } from "@archestra/shared";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useOrganization } from "@/lib/organization.query";
import { NoApiKeySetup } from "./no-api-key-setup";

// This empty state resolves what it may offer through
// useModelProviderCatalog() -> useOrganization(); no organization data means
// "no admin overrides", i.e. every provider available.
vi.mock("@/lib/organization.query");

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
  beforeEach(() => {
    vi.mocked(useOrganization).mockReturnValue({
      data: undefined,
    } as unknown as ReturnType<typeof useOrganization>);
  });

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

  it("drops a subscription whose provider the organization turned off", () => {
    vi.mocked(useOrganization).mockReturnValue({
      data: { modelProviderOverrides: { xai: { hidden: true } } },
    } as unknown as ReturnType<typeof useOrganization>);

    render(<NoApiKeySetup />);

    expect(
      screen.queryByRole("button", { name: "Sign in with Grok" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Sign in with ChatGPT" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Add API Key" }),
    ).toBeInTheDocument();
  });

  it("offers nothing to add when every provider is turned off", () => {
    vi.mocked(useOrganization).mockReturnValue({
      data: {
        modelProviderOverrides: Object.fromEntries(
          SupportedProviders.map((provider) => [provider, { hidden: true }]),
        ),
      },
    } as unknown as ReturnType<typeof useOrganization>);

    render(<NoApiKeySetup />);

    expect(
      screen.queryByRole("button", { name: "Add API Key" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(
      screen.getByText(/No model providers are available/),
    ).toBeInTheDocument();
  });
});
