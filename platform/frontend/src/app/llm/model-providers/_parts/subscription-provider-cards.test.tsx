import {
  SUBSCRIPTION_CREDENTIAL_KINDS,
  SUBSCRIPTION_CREDENTIALS,
} from "@archestra/shared";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LlmProviderApiKeyResponse } from "@/components/llm-provider-api-key-form";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { hasPermissions } from "@/lib/auth/auth.utils";
import {
  buildSubscriptionOffers,
  type SubscriptionOffer,
} from "./subscription-offers";
import { SubscriptionProviderCards } from "./subscription-provider-cards";

vi.mock("@/lib/auth/auth.query");

beforeEach(() => {
  vi.mocked(useHasPermissions).mockImplementation(
    (permissions) =>
      ({
        data: hasPermissions({}, permissions),
      }) as ReturnType<typeof useHasPermissions>,
  );
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("SubscriptionProviderCards", () => {
  it.each(
    SUBSCRIPTION_CREDENTIAL_KINDS,
  )("shows and recovers from rejected authentication for %s", async (kind) => {
    const user = userEvent.setup();
    const own = credential({
      provider: SUBSCRIPTION_CREDENTIALS[kind].provider,
      subscriptionKind: kind,
      requiresReauthentication: false,
    });
    const onConnect = vi.fn();
    const cards = (requiresReauthentication: boolean) => (
      <SubscriptionProviderCards
        offers={buildSubscriptionOffers([
          { ...own, requiresReauthentication },
        ]).filter((offer) => offer.kind === kind)}
        isLoading={false}
        currentUserId="user-1"
        onConnect={onConnect}
        onManage={vi.fn()}
        onDisconnect={vi.fn()}
        disconnectBlockedReason={() => null}
      />
    );
    const { rerender } = render(cards(false));
    expect(screen.getByText("Connected")).toBeVisible();
    rerender(cards(true));
    expect(screen.queryByText("Connected")).toBeNull();
    expect(screen.getByText("Reconnect required")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Manage" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Reconnect" }));
    expect(onConnect).toHaveBeenCalledWith(
      expect.objectContaining({
        kind,
        credential: expect.objectContaining({ id: own.id }),
      }),
    );
    rerender(cards(false));
    expect(screen.getByText("Connected")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Reconnect" })).toBeNull();
  });

  it("offers Connect when nothing is linked", () => {
    const { onDisconnect } = renderCards({ credential: null });
    expect(screen.getByRole("button", { name: "Connect" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Disconnect" })).toBeNull();
    expect(onDisconnect).not.toHaveBeenCalled();
  });

  it("lets a member without llmProviderApiKey:delete disconnect their own subscription", () => {
    // useHasPermissions is mocked false for every permission, standing in for
    // a regular member. The backend allows an owner to delete their own
    // personal key without that permission, so the card must not gate on it.
    renderCards({ credential: credential({}) });
    const disconnect = screen.getByRole("button", { name: "Disconnect" });
    expect(disconnect).toBeTruthy();
    expect(disconnect).not.toHaveAttribute("aria-disabled");
    expect(disconnect).toHaveProperty("disabled", false);
  });

  it("calls onDisconnect when the owner clicks Disconnect", async () => {
    const user = userEvent.setup();
    const own = credential({});
    const { onDisconnect } = renderCards({ credential: own });
    await user.click(screen.getByRole("button", { name: "Disconnect" }));
    expect(onDisconnect).toHaveBeenCalledWith(own);
  });

  it.each([
    false,
    true,
  ])("refuses another person's key even with delete permission: %s", async (hasPermission) => {
    vi.mocked(useHasPermissions).mockReturnValue({
      data: hasPermission,
    } as ReturnType<typeof useHasPermissions>);
    const user = userEvent.setup();
    const someoneElses = credential({ userId: "user-2" });
    const { onDisconnect } = renderCards({
      credential: someoneElses,
      currentUserId: "user-1",
    });
    const disconnect = screen.getByRole("button", { name: "Disconnect" });
    expect(disconnect).toHaveAttribute("aria-disabled", "true");
    await user.click(disconnect);
    expect(onDisconnect).not.toHaveBeenCalled();
  });

  it("refuses disconnect while the session identity is unavailable", async () => {
    const user = userEvent.setup();
    const { onDisconnect } = renderCards({
      credential: credential({}),
      currentUserId: null,
    });
    await user.click(screen.getByRole("button", { name: "Disconnect" }));
    expect(onDisconnect).not.toHaveBeenCalled();
  });

  it("explains a blocked disconnect to keyboard users and refuses activation", async () => {
    const user = userEvent.setup();
    const { onDisconnect } = renderCards({
      credential: credential({}),
      blockedReason: "This API key is used for knowledge base embedding.",
    });
    const disconnect = screen.getByRole("button", { name: "Disconnect" });
    expect(disconnect).toHaveAttribute("aria-disabled", "true");
    expect(disconnect).toHaveAccessibleDescription(
      "This API key is used for knowledge base embedding.",
    );
    disconnect.focus();
    expect(disconnect).toHaveFocus();
    await user.keyboard("{Enter} ");
    await user.click(disconnect);
    expect(onDisconnect).not.toHaveBeenCalled();
  });
});

function credential(
  overrides: Partial<LlmProviderApiKeyResponse>,
): LlmProviderApiKeyResponse {
  return {
    id: "key-1",
    name: "GitHub Copilot",
    provider: "github-copilot",
    scope: "personal",
    userId: "user-1",
    ...overrides,
  } as LlmProviderApiKeyResponse;
}

function offers(
  credential: LlmProviderApiKeyResponse | null,
): SubscriptionOffer[] {
  return [
    {
      kind: "github-copilot",
      name: "GitHub Copilot",
      provider: "github-copilot",
      credential,
      defaultValues: {
        name: "GitHub Copilot",
        provider: "github-copilot",
        shared: false,
      },
    },
  ];
}

function renderCards({
  credential,
  currentUserId = "user-1",
  blockedReason = null,
}: {
  credential: LlmProviderApiKeyResponse | null;
  currentUserId?: string | null;
  blockedReason?: string | null;
}) {
  const onConnect = vi.fn();
  const onManage = vi.fn();
  const onDisconnect = vi.fn();
  render(
    <SubscriptionProviderCards
      offers={offers(credential)}
      isLoading={false}
      currentUserId={currentUserId}
      onConnect={onConnect}
      onManage={onManage}
      onDisconnect={onDisconnect}
      disconnectBlockedReason={() => blockedReason}
    />,
  );
  return { onConnect, onManage, onDisconnect };
}
