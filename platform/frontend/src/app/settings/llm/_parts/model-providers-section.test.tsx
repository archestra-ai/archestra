import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

let mockOrganization: Record<string, unknown> | null = null;
const mockMutateAsync = vi.fn();

vi.mock("next/navigation");
vi.mock("@/lib/organization.query");
vi.mock("@/lib/auth/auth.query");

import {
  useHasPermissions,
  useMissingPermissions,
} from "@/lib/auth/auth.query";
import {
  useOrganization,
  useUpdateIntegrationSettings,
} from "@/lib/organization.query";
import { ModelProvidersSection } from "./model-providers-section";

beforeEach(() => {
  vi.clearAllMocks();
  mockMutateAsync.mockResolvedValue({});
  mockOrganization = { modelProviderOverrides: null };
  vi.mocked(useHasPermissions).mockReturnValue({
    data: true,
    isPending: false,
  } as ReturnType<typeof useHasPermissions>);
  vi.mocked(useMissingPermissions).mockReturnValue(
    [] as unknown as ReturnType<typeof useMissingPermissions>,
  );
  vi.mocked(useOrganization).mockImplementation(
    () =>
      ({
        data: mockOrganization,
        isPending: false,
      }) as ReturnType<typeof useOrganization>,
  );
  vi.mocked(useUpdateIntegrationSettings).mockReturnValue({
    mutateAsync: mockMutateAsync,
    isPending: false,
  } as unknown as ReturnType<typeof useUpdateIntegrationSettings>);
});

const save = async () =>
  userEvent.click(await screen.findByRole("button", { name: "Save" }));

describe("ModelProvidersSection — single-plan personal subscription providers", () => {
  it("notes GitHub Copilot and Microsoft 365 Copilot as personal subscriptions, and no API-key card", () => {
    render(<ModelProvidersSection />);

    expect(
      screen.getByTestId("model-provider-row-github-copilot"),
    ).toHaveTextContent("Personal subscription");
    expect(
      screen.getByTestId("model-provider-row-microsoft-365-copilot"),
    ).toHaveTextContent("Personal subscription");
    expect(
      screen.getByTestId("model-provider-row-openai"),
    ).not.toHaveTextContent("Personal subscription");
    expect(
      screen.queryByTestId("model-provider-row-github-copilot-enterprise"),
    ).toBeNull();
  });

  it("turns off and renames GitHub Copilot via its provider override", async () => {
    render(<ModelProvidersSection />);

    await userEvent.click(
      screen.getByRole("switch", {
        name: "Make GitHub Copilot personal subscription available",
      }),
    );
    await userEvent.type(
      screen.getByRole("textbox", {
        name: "GitHub Copilot personal subscription display name",
      }),
      "Company Copilot",
    );
    await save();

    expect(mockMutateAsync).toHaveBeenCalledWith({
      modelProviderOverrides: {
        "github-copilot": { hidden: true, displayName: "Company Copilot" },
      },
    });
  });
});

describe("ModelProvidersSection — personal subscriptions beside API keys", () => {
  const pairs = [
    { provider: "openai", apiKeys: "OpenAI", personal: "ChatGPT" },
    { provider: "anthropic", apiKeys: "Anthropic", personal: "Claude Code" },
    { provider: "xai", apiKeys: "xAI", personal: "SuperGrok" },
  ] as const;
  const apiKeySwitch = (label: string) =>
    screen.getByRole("switch", { name: `Make ${label} API keys available` });
  const personalSwitch = (label: string) =>
    screen.getByRole("switch", {
      name: `Make ${label} personal subscription available`,
    });

  it.each(pairs)("shows $apiKeys API keys and $personal as two cards", ({
    provider,
    apiKeys,
    personal,
  }) => {
    render(<ModelProvidersSection />);

    const apiKeyCard = screen.getByTestId(`model-provider-row-${provider}`);
    expect(apiKeyCard).toHaveTextContent(apiKeys);
    expect(apiKeyCard).toHaveTextContent("API keys");
    expect(apiKeyCard).not.toHaveTextContent("Personal subscription");
    const personalCard = screen.getByTestId(
      `model-provider-row-${provider}-personal`,
    );
    expect(personalCard).toHaveTextContent(personal);
    expect(personalCard).toHaveTextContent("Personal subscription");
    expect(
      screen.getByRole("textbox", {
        name: `${personal} personal subscription display name`,
      }),
    ).toHaveAttribute("placeholder", `Show as “${personal}”`);
  });

  it.each(pairs)("turns off $personal alone", async ({
    provider,
    personal,
  }) => {
    render(<ModelProvidersSection />);

    await userEvent.click(personalSwitch(personal));
    await save();

    expect(mockMutateAsync).toHaveBeenCalledWith({
      modelProviderOverrides: {
        [provider]: { plans: { personal: { hidden: true } } },
      },
    });
  });

  it.each(pairs)("stores both $apiKeys cards off as the provider off", async ({
    provider,
    apiKeys,
    personal,
  }) => {
    render(<ModelProvidersSection />);

    await userEvent.click(apiKeySwitch(apiKeys));
    await userEvent.click(personalSwitch(personal));
    await save();

    expect(mockMutateAsync).toHaveBeenCalledWith({
      modelProviderOverrides: { [provider]: { hidden: true } },
    });
  });

  it.each(
    pairs,
  )("shows $apiKeys turned off as both cards off, and turns one back on", async ({
    provider,
    apiKeys,
    personal,
  }) => {
    mockOrganization = {
      modelProviderOverrides: { [provider]: { hidden: true } },
    };
    render(<ModelProvidersSection />);

    expect(apiKeySwitch(apiKeys)).not.toBeChecked();
    expect(personalSwitch(personal)).not.toBeChecked();

    await userEvent.click(personalSwitch(personal));
    await save();

    expect(mockMutateAsync).toHaveBeenCalledWith({
      modelProviderOverrides: {
        [provider]: { plans: { apiKey: { hidden: true } } },
      },
    });
  });

  it("names the personal subscription apart from its provider's API keys", async () => {
    render(<ModelProvidersSection />);

    await userEvent.type(
      screen.getByRole("textbox", {
        name: "ChatGPT personal subscription display name",
      }),
      "My ChatGPT",
    );
    await userEvent.type(
      screen.getByRole("textbox", { name: "OpenAI API keys display name" }),
      "OpenAI (company)",
    );
    await save();

    expect(mockMutateAsync).toHaveBeenCalledWith({
      modelProviderOverrides: {
        openai: {
          displayName: "OpenAI (company)",
          plans: { personal: { displayName: "My ChatGPT" } },
        },
      },
    });
  });

  it("keeps a personal subscription's name while it is off", async () => {
    mockOrganization = {
      modelProviderOverrides: {
        xai: { plans: { personal: { displayName: "Grok" } } },
      },
    };
    render(<ModelProvidersSection />);

    expect(
      screen.getByRole("textbox", {
        name: "SuperGrok personal subscription display name",
      }),
    ).toHaveValue("Grok");
    await userEvent.click(personalSwitch("SuperGrok"));
    await save();

    expect(mockMutateAsync).toHaveBeenCalledWith({
      modelProviderOverrides: {
        xai: { plans: { personal: { hidden: true, displayName: "Grok" } } },
      },
    });
  });

  it.each([
    ["Claude Code", "model-provider-row-anthropic-personal"],
    ["My Grok", "model-provider-row-xai-personal"],
    ["Anthropic", "model-provider-row-anthropic-personal"],
    ["personal subscription", "model-provider-row-openai-personal"],
    ["personal subscription", "model-provider-row-microsoft-365-copilot"],
  ])("finds a personal subscription card by %j", async (query, testId) => {
    mockOrganization = {
      modelProviderOverrides: {
        xai: { plans: { personal: { displayName: "My Grok" } } },
      },
    };
    render(<ModelProvidersSection />);

    await userEvent.type(
      screen.getByPlaceholderText("Search providers…"),
      query,
    );

    await waitFor(() =>
      expect(screen.queryByTestId("model-provider-row-gemini")).toBeNull(),
    );
    expect(screen.getByTestId(testId)).toBeInTheDocument();
  });
});
