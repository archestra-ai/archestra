import { cleanup, render, screen } from "@testing-library/react";
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

    expect(screen.getByText("GitHub Copilot")).toBeInTheDocument();
    expect(
      screen.getByText("Connect your enterprise GitHub Copilot plan."),
    ).toBeInTheDocument();
    expect(screen.getByText("Not connected")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Connect" }));
    expect(handlers.onConnect).toHaveBeenCalledOnce();
  });

  it("shows a connected organization like a personal subscription, with Manage and Disconnect", async () => {
    const user = userEvent.setup();
    const handlers = renderCards([appKey()]);

    expect(
      screen.getByText(
        "Your organization's Copilot plan is linked through a GitHub App. Usage is billed to my-org.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("Connected")).toBeInTheDocument();
    // One card per organization, no extra header or menu actions.
    expect(screen.queryByText("Not connected")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Connect another/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Manage access" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/models/)).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Manage" }));
    expect(handlers.onManage).toHaveBeenCalledWith(appKey());
    await user.click(screen.getByRole("button", { name: "Disconnect" }));
    expect(handlers.onDisconnect).toHaveBeenCalledWith(appKey());
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
