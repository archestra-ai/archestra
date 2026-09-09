import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/config/config.query");
vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/organization.query");
vi.mock("@/lib/teams/team.query");
vi.mock("@/lib/llm-provider-api-keys.query", () => ({
  useLlmProviderApiKeys: () => ({ data: undefined }),
  useCreateLlmProviderApiKey: () => ({
    mutateAsync: vi.fn(),
    isPending: false,
  }),
  useReconnectLlmProviderApiKey: () => ({
    mutateAsync: vi.fn(),
    isPending: false,
  }),
}));

import { useHasPermissions } from "@/lib/auth/auth.query";
import { useFeature, useProviderBaseUrls } from "@/lib/config/config.query";
import {
  useAppearanceSettings,
  useOrganization,
} from "@/lib/organization.query";
import { useTeams } from "@/lib/teams/team.query";
import { CreateLlmProviderApiKeyDialog } from "./create-llm-provider-api-key-dialog";

Element.prototype.hasPointerCapture = vi.fn().mockReturnValue(false);
Element.prototype.setPointerCapture = vi.fn();
Element.prototype.releasePointerCapture = vi.fn();
Element.prototype.scrollIntoView = vi.fn();

describe("CreateLlmProviderApiKeyDialog integration", () => {
  beforeEach(() => {
    vi.mocked(useFeature).mockReturnValue(
      false as ReturnType<typeof useFeature>,
    );
    vi.mocked(useProviderBaseUrls).mockReturnValue({
      data: {},
    } as ReturnType<typeof useProviderBaseUrls>);
    vi.mocked(useHasPermissions).mockReturnValue({
      data: false,
    } as ReturnType<typeof useHasPermissions>);
    vi.mocked(useOrganization).mockReturnValue({
      data: undefined,
    } as ReturnType<typeof useOrganization>);
    vi.mocked(useAppearanceSettings).mockReturnValue({
      data: undefined,
    } as ReturnType<typeof useAppearanceSettings>);
    vi.mocked(useTeams).mockReturnValue({
      data: [],
    } as unknown as ReturnType<typeof useTeams>);
  });

  it("keeps the generic title for a multi-provider form after an equivalent refresh", () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const renderDialog = (allowedProviders: ["anthropic", "openai"]) => (
      <QueryClientProvider client={client}>
        <CreateLlmProviderApiKeyDialog
          open
          onOpenChange={vi.fn()}
          title="Add API Key"
          description="Shared dialog"
          allowedProviders={allowedProviders}
        />
      </QueryClientProvider>
    );

    const view = render(renderDialog(["anthropic", "openai"]));
    view.rerender(renderDialog(["anthropic", "openai"]));

    expect(screen.getByRole("dialog", { name: "Add API Key" })).toBeVisible();
    expect(screen.getByLabelText("Provider")).toBeVisible();
  });

  it("names a generic single-provider form after its visible provider", () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    render(
      <QueryClientProvider client={client}>
        <CreateLlmProviderApiKeyDialog
          open
          onOpenChange={vi.fn()}
          title="Add API Key"
          description="Shared dialog"
          allowedProviders={["openai"]}
        />
      </QueryClientProvider>,
    );

    expect(
      screen.getByRole("dialog", { name: "Add OpenAI API Key" }),
    ).toBeVisible();
    expect(screen.queryByLabelText("Provider")).not.toBeInTheDocument();
  });

  it("omits providers outside the runtime allowlist from the picker", async () => {
    const user = userEvent.setup();
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    render(
      <QueryClientProvider client={client}>
        <CreateLlmProviderApiKeyDialog
          open
          onOpenChange={vi.fn()}
          title="Add API Key"
          description="Shared dialog"
          allowedProviders={["anthropic", "bedrock", "openai"]}
        />
      </QueryClientProvider>,
    );

    await user.click(screen.getByLabelText("Provider"));

    expect(
      screen.getByRole("button", { name: /Anthropic/ }),
    ).not.toBeDisabled();
    expect(
      screen.getByRole("button", { name: /AWS Bedrock/ }),
    ).not.toBeDisabled();
    expect(screen.getByRole("button", { name: /OpenAI/ })).not.toBeDisabled();
    expect(
      screen.queryByRole("button", { name: /Gemini/ }),
    ).not.toBeInTheDocument();
  });
});
