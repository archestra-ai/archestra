import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LlmProviderApiKeyResponse } from "@/components/llm-provider-api-key-form";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { SubscriptionProviderCards } from "./subscription-provider-cards";
import type { SubscriptionOffer } from "./subscription-offers";

vi.mock("@/lib/auth/auth.query");

beforeEach(() => {
  vi.mocked(useHasPermissions).mockReturnValue({
    data: false,
  } as ReturnType<typeof useHasPermissions>);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
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
        scope: "personal",
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
  currentUserId?: string;
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

describe("SubscriptionProviderCards", () => {
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
    const { onDisconnect } = renderCards({ credential: credential({}) });
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

  it("keeps the permission gate for another person's personal key", async () => {
    // An admin's key list can include another user's personal key, and the
    // offers can pair it into a card. The backend refuses that delete even
    // with permission, so the control must not act without a permission
    // check — here the member has none.
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

  it("stays disabled when disconnect is blocked, even for the owner", () => {
    const { onDisconnect } = renderCards({
      credential: credential({}),
      blockedReason: "This API key is used for knowledge base embedding.",
    });
    const disconnect = screen.getByRole("button", { name: "Disconnect" });
    expect(disconnect).toHaveProperty("disabled", true);
    expect(onDisconnect).not.toHaveBeenCalled();
  });
});
