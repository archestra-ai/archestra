import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LlmProviderApiKeyResponse } from "@/components/llm-provider-api-key-form";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { hasPermissions } from "@/lib/auth/auth.utils";
import { OrganizationSubscriptionCards } from "./organization-subscription-cards";

vi.mock("@/lib/auth/auth.query");

beforeEach(() => {
  vi.mocked(useHasPermissions).mockImplementation(
    (permissions) =>
      ({
        data: hasPermissions(
          { llmProviderApiKey: ["read", "create", "update", "delete"] },
          permissions,
        ),
      }) as ReturnType<typeof useHasPermissions>,
  );
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const appKey = (overrides?: Partial<LlmProviderApiKeyResponse>) =>
  ({
    id: "key-1",
    provider: "github-copilot",
    name: "GitHub Copilot (my-org)",
    scope: "org",
    userId: null,
    isGithubAppKey: true,
    githubOrganization: "my-org",
    requiresReauthentication: false,
    ...overrides,
  }) as LlmProviderApiKeyResponse;

function renderCards(
  credentials: LlmProviderApiKeyResponse[],
  blockedReason: string | null = null,
) {
  const handlers = {
    onConnect: vi.fn(),
    onReconnect: vi.fn(),
    onManage: vi.fn(),
    onDisconnect: vi.fn(),
  };
  render(
    <OrganizationSubscriptionCards
      name="GitHub Copilot Organization"
      credentials={credentials}
      isLoading={false}
      disconnectBlockedReason={() => blockedReason}
      {...handlers}
    />,
  );
  return handlers;
}

describe("OrganizationSubscriptionCards", () => {
  it("offers Connect when no organization is connected", async () => {
    const user = userEvent.setup();
    const handlers = renderCards([]);

    expect(screen.getByText("GitHub Copilot Organization")).toBeInTheDocument();
    expect(
      screen.getByText("Connect your enterprise GitHub Copilot plan."),
    ).toBeInTheDocument();
    expect(screen.getByText("Not connected")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Connect" }));
    expect(handlers.onConnect).toHaveBeenCalledOnce();
  });

  it("names a connected card after its GitHub organization", () => {
    renderCards([appKey()]);

    expect(screen.getByText("GitHub Copilot my-org")).toBeInTheDocument();
    expect(screen.queryByText("GitHub Copilot Organization")).toBeNull();
  });

  it("keeps the plan's name on a connected card whose organization is unknown", () => {
    renderCards([appKey({ githubOrganization: null })]);

    expect(screen.getByText("GitHub Copilot Organization")).toBeInTheDocument();
  });

  it("shows a connected organization like a personal subscription, with Manage and Disconnect", async () => {
    const user = userEvent.setup();
    const handlers = renderCards([appKey()]);

    expect(
      screen.getByText(
        "Your organization's Copilot plan is linked through a GitHub App. Usage is billed to my-org.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("GitHub Copilot my-org")).toBeInTheDocument();
    expect(screen.getByText("Connected")).toBeInTheDocument();
    // One card per organization, no extra header or menu actions.
    expect(
      screen.queryByRole("button", { name: /Connect another/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Manage access" }),
    ).not.toBeInTheDocument();
    // The plan's card lists no models; the chat and Connect pickers do.
    const plan = screen
      .getByText("GitHub Copilot my-org")
      .closest<HTMLElement>('[data-slot="card"]');
    expect(within(plan as HTMLElement).queryByText(/models/)).toBeNull();

    await user.click(screen.getByRole("button", { name: "Manage" }));
    expect(handlers.onManage).toHaveBeenCalledWith(appKey());
    await user.click(screen.getByRole("button", { name: "Disconnect" }));
    expect(handlers.onDisconnect).toHaveBeenCalledWith(appKey());
  });

  it("names each organization's plan and offers another organization to someone who can add plans", async () => {
    const user = userEvent.setup();
    const handlers = renderCards([
      appKey(),
      appKey({
        id: "key-2",
        name: "GitHub Copilot (other-org)",
        githubOrganization: "other-org",
        githubOrganizationName: "Other Org Inc",
      }),
    ]);

    expect(screen.getByText("GitHub Copilot my-org")).toBeInTheDocument();
    expect(
      screen.getByText("GitHub Copilot Other Org Inc"),
    ).toBeInTheDocument();
    expect(screen.getAllByText("Connected")).toHaveLength(2);
    const another = screen.getByTestId("copilot-plan-connect-another");
    expect(another).toHaveTextContent(
      "Connect other GitHub Copilot organization",
    );
    expect(another).toHaveTextContent("Not connected");
    await user.click(screen.getByRole("button", { name: "Connect" }));
    expect(handlers.onConnect).toHaveBeenCalledOnce();
    expect(handlers.onReconnect).not.toHaveBeenCalled();
  });

  it("offers no other organization to someone who cannot add plans", () => {
    vi.mocked(useHasPermissions).mockImplementation(
      (permissions) =>
        ({
          data: hasPermissions(
            { llmProviderApiKey: ["read", "update", "delete"] },
            permissions,
          ),
        }) as ReturnType<typeof useHasPermissions>,
    );
    renderCards([appKey()]);

    expect(screen.getByText("GitHub Copilot my-org")).toBeInTheDocument();
    expect(screen.queryByTestId("copilot-plan-connect-another")).toBeNull();
  });

  it("asks for a reconnect when GitHub refused the App", async () => {
    const user = userEvent.setup();
    const handlers = renderCards([appKey({ requiresReauthentication: true })]);

    expect(screen.getByText("Reconnect required")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Reconnect" }));
    expect(handlers.onReconnect).toHaveBeenCalledOnce();
    expect(
      screen.queryByRole("button", { name: "Manage" }),
    ).not.toBeInTheDocument();
  });

  it("blocks Disconnect while the key is in use, like personal cards", () => {
    renderCards([appKey()], "Used for knowledge base embedding");

    const disconnect = screen.getByRole("button", { name: "Disconnect" });
    expect(disconnect).toHaveAttribute("aria-disabled", "true");
    expect(disconnect).toHaveAccessibleDescription(
      "Used for knowledge base embedding",
    );
  });
});
