import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSession } from "@/lib/auth/auth.query";
import { useAvailableLlmProviderApiKeys } from "@/lib/llm-provider-api-keys.query";
import { ProviderAuthRequiredCard } from "./provider-auth-required-card";

const createMutateAsync = vi.fn();
const reconnectMutateAsync = vi.fn();

vi.mock("@/lib/llm-provider-api-keys.query", () => ({
  useCreateLlmProviderApiKey: () => ({
    isPending: false,
    mutateAsync: createMutateAsync,
  }),
  useReconnectLlmProviderApiKey: () => ({
    isPending: false,
    mutateAsync: reconnectMutateAsync,
  }),
  useAvailableLlmProviderApiKeys: vi.fn(),
}));

vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/config/config.query");

// Complete the sign-in on click so the save path is exercised directly.
vi.mock("@/components/subscription-sign-in", () => ({
  SubscriptionSignIn: ({
    onSecret,
  }: {
    onSecret: (secret: string) => void | Promise<void>;
  }) => (
    <button type="button" onClick={() => onSecret("chatgpt-oauth:fresh")}>
      Sign in
    </button>
  ),
}));

const chatgptKey = {
  id: "key-existing",
  provider: "openai",
  scope: "personal",
  userId: "user-1",
  isPrimary: false,
  createdAt: "2026-01-01T00:00:00.000Z",
  subscriptionKind: "chatgpt",
};

describe("ProviderAuthRequiredCard", () => {
  beforeEach(() => {
    createMutateAsync.mockReset().mockResolvedValue({ id: "key-new" });
    reconnectMutateAsync.mockReset().mockResolvedValue({ id: "key-existing" });
    vi.mocked(useSession).mockReturnValue({
      data: { user: { id: "user-1" } },
    } as ReturnType<typeof useSession>);
    vi.mocked(useAvailableLlmProviderApiKeys).mockReturnValue({
      data: [],
    } as unknown as ReturnType<typeof useAvailableLlmProviderApiKeys>);
  });

  it("reconnects the user's existing personal subscription key in place", async () => {
    // The card usually appears because an existing key's sign-in expired.
    // Creating a second row would leave conversations pinned to the dead one
    // still failing — the sign-in must rotate the existing row instead.
    vi.mocked(useAvailableLlmProviderApiKeys).mockReturnValue({
      data: [chatgptKey],
    } as unknown as ReturnType<typeof useAvailableLlmProviderApiKeys>);
    const user = userEvent.setup();

    render(
      <ProviderAuthRequiredCard
        provider="openai"
        providerLabel="ChatGPT Subscription"
      />,
    );
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    expect(reconnectMutateAsync).toHaveBeenCalledWith({
      id: "key-existing",
      apiKey: "chatgpt-oauth:fresh",
    });
    expect(createMutateAsync).not.toHaveBeenCalled();
  });

  it("creates a personal key when the user has none for this subscription", async () => {
    const user = userEvent.setup();

    render(
      <ProviderAuthRequiredCard
        provider="openai"
        providerLabel="ChatGPT Subscription"
      />,
    );
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    expect(createMutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai",
        apiKey: "chatgpt-oauth:fresh",
        scope: "personal",
      }),
    );
    expect(reconnectMutateAsync).not.toHaveBeenCalled();
  });

  it("does not reconnect another user's key or a plain API key", async () => {
    vi.mocked(useAvailableLlmProviderApiKeys).mockReturnValue({
      data: [
        { ...chatgptKey, id: "someone-elses", userId: "user-2" },
        {
          ...chatgptKey,
          id: "plain-api-key",
          subscriptionKind: null,
        },
      ],
    } as unknown as ReturnType<typeof useAvailableLlmProviderApiKeys>);
    const user = userEvent.setup();

    render(
      <ProviderAuthRequiredCard
        provider="openai"
        providerLabel="ChatGPT Subscription"
      />,
    );
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    expect(createMutateAsync).toHaveBeenCalled();
    expect(reconnectMutateAsync).not.toHaveBeenCalled();
  });
});
