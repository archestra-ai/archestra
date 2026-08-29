import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSession } from "@/lib/auth/auth.query";
import { useUpdateConversation } from "@/lib/chat/chat.query";
import {
  type LlmProviderApiKey,
  useAvailableLlmProviderApiKeys,
} from "@/lib/llm-provider-api-keys.query";

vi.mock("@/lib/auth/auth.query");

vi.mock("@/lib/chat/chat.query", () => ({
  useUpdateConversation: vi.fn(),
}));

vi.mock("@/lib/llm-provider-api-keys.query", () => ({
  useAvailableLlmProviderApiKeys: vi.fn(),
}));

vi.mock("@/components/llm-provider-api-key-dropdown", () => ({
  LlmProviderApiKeyDropdown: ({
    availableKeys,
    onAddApiKey,
    onSelectKey,
    selectedApiKeyId,
  }: {
    availableKeys: Array<{
      id: string;
      name: string;
      connectRequired?: boolean;
    }>;
    onSelectKey: (id: string) => void;
    onAddApiKey?: () => void;
    selectedApiKeyId: string | null;
  }) => (
    <div>
      {onAddApiKey && (
        <button type="button" onClick={onAddApiKey}>
          Add provider key
        </button>
      )}
      {availableKeys.map((key) => (
        <button key={key.id} type="button" onClick={() => onSelectKey(key.id)}>
          {key.name} {key.connectRequired ? "Connect" : "Connected"}
          {selectedApiKeyId === key.id ? <span> Selected</span> : null}
        </button>
      ))}
    </div>
  ),
}));

vi.mock("@/components/create-llm-provider-api-key-dialog", () => ({
  CreateLlmProviderApiKeyDialog: ({
    title,
    defaultValues,
    onSuccess,
    open,
    reconnectKeyId,
    requiresExactSubscriptionCredential,
  }: {
    title: string;
    defaultValues?: { provider?: string; authMethod?: string };
    onSuccess?: (keyId?: string) => void;
    open: boolean;
    reconnectKeyId?: string;
    requiresExactSubscriptionCredential?: boolean;
  }) =>
    open ? (
      <div>
        <span>{title}</span>
        <span>{defaultValues?.provider}</span>
        <span>{defaultValues?.authMethod}</span>
        {reconnectKeyId && <span>{`reconnect:${reconnectKeyId}`}</span>}
        {requiresExactSubscriptionCredential && (
          <span>exact-subscription-required</span>
        )}
        <button type="button" onClick={() => onSuccess?.("new-key-id")}>
          Create key
        </button>
      </div>
    ) : null,
}));

import { LlmProviderApiKeySelector } from "./llm-provider-api-key-selector";

describe("LlmProviderApiKeySelector subscriptions", () => {
  beforeEach(() => {
    vi.mocked(useSession).mockReturnValue({
      data: { user: { id: "current-user" } },
      isPending: false,
    } as ReturnType<typeof useSession>);
    vi.mocked(useUpdateConversation).mockReturnValue({
      mutate: vi.fn(),
    } as unknown as ReturnType<typeof useUpdateConversation>);
    vi.mocked(useAvailableLlmProviderApiKeys).mockReturnValue({
      data: [],
      isLoading: false,
    } as unknown as ReturnType<typeof useAvailableLlmProviderApiKeys>);
  });

  it("shows every subscription when none are connected", () => {
    renderSelector();

    expect(
      screen.getByRole("button", { name: "ChatGPT Subscription Connect" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "GitHub Copilot Connect" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Microsoft 365 Copilot Connect" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "SuperGrok Connect" }),
    ).toBeInTheDocument();
  });

  it("does not duplicate a connected subscription", () => {
    const chatgptKey = {
      id: "chatgpt-key",
      name: "My ChatGPT",
      provider: "openai",
      scope: "personal",
      userId: "current-user",
      subscriptionKind: "chatgpt",
    } as LlmProviderApiKey;
    vi.mocked(useAvailableLlmProviderApiKeys).mockReturnValue({
      data: [chatgptKey],
      isLoading: false,
    } as unknown as ReturnType<typeof useAvailableLlmProviderApiKeys>);
    renderSelector();

    expect(
      screen.getByRole("button", { name: "My ChatGPT Connected" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "ChatGPT Subscription Connect" }),
    ).not.toBeInTheDocument();
  });

  it("does not treat an agent owner's subscription as the viewer's", () => {
    const agentOwnerKey = {
      id: "agent-owner-chatgpt-key",
      name: "Agent owner's ChatGPT",
      provider: "openai",
      scope: "personal",
      userId: "another-user",
      subscriptionKind: "chatgpt",
      isAgentKey: true,
    } as LlmProviderApiKey;
    vi.mocked(useAvailableLlmProviderApiKeys).mockReturnValue({
      data: [agentOwnerKey],
      isLoading: false,
    } as unknown as ReturnType<typeof useAvailableLlmProviderApiKeys>);

    renderSelector();

    expect(
      screen.getByRole("button", { name: "ChatGPT Subscription Connect" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", {
        name: "Agent owner's ChatGPT Connected",
      }),
    ).not.toBeInTheDocument();
  });

  it("marks the connect option selected when the agent pins another user's subscription", () => {
    const onApiKeyChange = vi.fn();
    const agentOwnerKey = {
      id: "agent-owner-github-copilot-key",
      name: "Agent owner's GitHub Copilot",
      provider: "github-copilot",
      scope: "personal",
      userId: "another-user",
      isAgentKey: true,
    } as LlmProviderApiKey;
    const fallbackKey = {
      id: "organization-openai-key",
      name: "Organization OpenAI",
      provider: "openai",
      scope: "org",
      userId: null,
    } as LlmProviderApiKey;
    vi.mocked(useAvailableLlmProviderApiKeys).mockReturnValue({
      data: [agentOwnerKey, fallbackKey],
      isLoading: false,
    } as unknown as ReturnType<typeof useAvailableLlmProviderApiKeys>);

    render(
      <LlmProviderApiKeySelector
        agentLlmApiKeyId={agentOwnerKey.id}
        currentConversationChatApiKeyId={agentOwnerKey.id}
        currentProvider="github-copilot"
        onApiKeyChange={onApiKeyChange}
        suppressAutoSelect
      />,
    );

    expect(
      screen.getByRole("button", {
        name: /^GitHub Copilot Connect\s*Selected$/,
      }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", {
        name: "Agent owner's GitHub Copilot Connected",
      }),
    ).not.toBeInTheDocument();
    expect(onApiKeyChange).not.toHaveBeenCalled();
  });

  it("does not infer a pinned ChatGPT subscription from its mutable name", () => {
    const agentOwnerKey = {
      id: "agent-owner-chatgpt-key",
      name: "ChatGPT Subscription",
      provider: "openai",
      scope: "personal",
      userId: "another-user",
      isAgentKey: true,
    } as LlmProviderApiKey;
    vi.mocked(useAvailableLlmProviderApiKeys).mockReturnValue({
      data: [agentOwnerKey],
      isLoading: false,
    } as unknown as ReturnType<typeof useAvailableLlmProviderApiKeys>);

    render(
      <LlmProviderApiKeySelector
        agentLlmApiKeyId={agentOwnerKey.id}
        currentConversationChatApiKeyId={agentOwnerKey.id}
        currentProvider="openai"
        onApiKeyChange={() => {}}
        suppressAutoSelect
      />,
    );

    expect(
      screen.getByRole("button", {
        name: /^ChatGPT Subscription Connected\s*Selected$/,
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: /^ChatGPT Subscription Connect$/,
      }),
    ).toBeInTheDocument();
  });

  it("opens the pinned subscription flow when the composer requests connection", () => {
    const agentOwnerKey = {
      id: "agent-owner-chatgpt-key",
      name: "ChatGPT Subscription",
      provider: "openai",
      scope: "personal",
      userId: "another-user",
      subscriptionKind: "chatgpt",
      isAgentKey: true,
    } as LlmProviderApiKey;
    vi.mocked(useAvailableLlmProviderApiKeys).mockReturnValue({
      data: [agentOwnerKey],
      isLoading: false,
    } as unknown as ReturnType<typeof useAvailableLlmProviderApiKeys>);

    render(
      <LlmProviderApiKeySelector
        agentLlmApiKeyId={agentOwnerKey.id}
        currentConversationChatApiKeyId={agentOwnerKey.id}
        currentProvider="openai"
        onApiKeyChange={() => {}}
        suppressAutoSelect
        connectRequestToken={1}
      />,
    );

    expect(screen.getByText("Sign in with ChatGPT")).toBeInTheDocument();
    expect(screen.getByText("subscription")).toBeInTheDocument();
    expect(screen.getByText("exact-subscription-required")).toBeInTheDocument();
  });

  it("re-opens the sign-in flow to reconnect a connected subscription that is already selected", async () => {
    const user = userEvent.setup();
    const chatgptKey = {
      id: "chatgpt-key",
      name: "ChatGPT Subscription",
      provider: "openai",
      scope: "personal",
      userId: "current-user",
      subscriptionKind: "chatgpt",
    } as LlmProviderApiKey;
    vi.mocked(useAvailableLlmProviderApiKeys).mockReturnValue({
      data: [chatgptKey],
      isLoading: false,
    } as unknown as ReturnType<typeof useAvailableLlmProviderApiKeys>);

    render(
      <LlmProviderApiKeySelector
        currentConversationChatApiKeyId="chatgpt-key"
        currentProvider="openai"
        onApiKeyChange={() => {}}
        suppressAutoSelect
      />,
    );

    await user.click(
      screen.getByRole("button", {
        name: /^ChatGPT Subscription Connected\s*Selected$/,
      }),
    );

    // The dialog opens in reconnect mode, targeting the existing credential
    // so the sign-in rotates its secret instead of creating a duplicate.
    expect(
      screen.getByText("Reconnect ChatGPT Subscription"),
    ).toBeInTheDocument();
    expect(screen.getByText("reconnect:chatgpt-key")).toBeInTheDocument();
  });

  it("opens the provider-specific subscription flow", async () => {
    const user = userEvent.setup();
    renderSelector();

    await user.click(
      screen.getByRole("button", { name: "ChatGPT Subscription Connect" }),
    );

    expect(screen.getByText("Sign in with ChatGPT")).toBeInTheDocument();
    expect(screen.getByText("openai")).toBeInTheDocument();
    expect(screen.getByText("subscription")).toBeInTheDocument();
  });

  it("creates a provider key in chat and selects it after the keys refetch", async () => {
    const user = userEvent.setup();
    const onApiKeyChange = vi.fn();
    const onProviderChange = vi.fn();
    const { rerender } = render(
      <LlmProviderApiKeySelector
        currentConversationChatApiKeyId={null}
        currentProvider="anthropic"
        onApiKeyChange={onApiKeyChange}
        onProviderChange={onProviderChange}
        suppressAutoSelect
      />,
    );

    await user.click(screen.getByRole("button", { name: "Add provider key" }));
    expect(screen.getByText("Add API Key")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Create key" }));

    vi.mocked(useAvailableLlmProviderApiKeys).mockReturnValue({
      data: [
        {
          id: "new-key-id",
          name: "New OpenAI key",
          provider: "openai",
          scope: "personal",
          userId: "current-user",
        } as LlmProviderApiKey,
      ],
      isLoading: false,
    } as unknown as ReturnType<typeof useAvailableLlmProviderApiKeys>);
    rerender(
      <LlmProviderApiKeySelector
        currentConversationChatApiKeyId={null}
        currentProvider="anthropic"
        onApiKeyChange={onApiKeyChange}
        onProviderChange={onProviderChange}
        suppressAutoSelect
      />,
    );

    expect(onApiKeyChange).toHaveBeenCalledWith("new-key-id");
    expect(onProviderChange).toHaveBeenCalledWith("openai", "new-key-id");
  });

  it("does not override a manual key choice while a created key is refetching", async () => {
    const user = userEvent.setup();
    const onApiKeyChange = vi.fn();
    const onProviderChange = vi.fn();
    const existingKey = {
      id: "existing-key-id",
      name: "Existing Anthropic key",
      provider: "anthropic",
      scope: "personal",
      userId: "current-user",
    } as LlmProviderApiKey;
    vi.mocked(useAvailableLlmProviderApiKeys).mockReturnValue({
      data: [existingKey],
      isLoading: false,
    } as unknown as ReturnType<typeof useAvailableLlmProviderApiKeys>);
    const { rerender } = render(
      <LlmProviderApiKeySelector
        currentConversationChatApiKeyId={null}
        currentProvider="anthropic"
        onApiKeyChange={onApiKeyChange}
        onProviderChange={onProviderChange}
        suppressAutoSelect
      />,
    );

    await user.click(screen.getByRole("button", { name: "Add provider key" }));
    await user.click(screen.getByRole("button", { name: "Create key" }));
    await user.click(
      screen.getByRole("button", { name: "Existing Anthropic key Connected" }),
    );

    vi.mocked(useAvailableLlmProviderApiKeys).mockReturnValue({
      data: [
        existingKey,
        {
          id: "new-key-id",
          name: "New OpenAI key",
          provider: "openai",
          scope: "personal",
          userId: "current-user",
        } as LlmProviderApiKey,
      ],
      isLoading: false,
    } as unknown as ReturnType<typeof useAvailableLlmProviderApiKeys>);
    rerender(
      <LlmProviderApiKeySelector
        currentConversationChatApiKeyId={null}
        currentProvider="anthropic"
        onApiKeyChange={onApiKeyChange}
        onProviderChange={onProviderChange}
        suppressAutoSelect
      />,
    );

    expect(onApiKeyChange).toHaveBeenCalledTimes(1);
    expect(onApiKeyChange).toHaveBeenCalledWith("existing-key-id");
    expect(onProviderChange).toHaveBeenCalledTimes(1);
    expect(onProviderChange).toHaveBeenCalledWith(
      "anthropic",
      "existing-key-id",
    );
  });

  it("recognizes a SuperGrok key as connected without absorbing plain xAI API keys", () => {
    // Both keys live on the `xai` provider; only the subscriptionKind the
    // backend read off the stored secret distinguishes the subscription.
    const xPremiumKey = {
      id: "x-premium-key",
      name: "SuperGrok",
      provider: "xai",
      scope: "personal",
      userId: "current-user",
      subscriptionKind: "x-premium",
    } as LlmProviderApiKey;
    const xaiApiKey = {
      id: "xai-api-key",
      name: "Plain xAI key",
      provider: "xai",
      scope: "org",
      userId: null,
    } as LlmProviderApiKey;
    vi.mocked(useAvailableLlmProviderApiKeys).mockReturnValue({
      data: [xPremiumKey, xaiApiKey],
      isLoading: false,
    } as unknown as ReturnType<typeof useAvailableLlmProviderApiKeys>);

    renderSelector();

    expect(
      screen.getByRole("button", { name: "SuperGrok Connected" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "SuperGrok Connect" }),
    ).not.toBeInTheDocument();
    // The plain key stays an ordinary credential row, untouched by the
    // subscription matching.
    expect(
      screen.getByRole("button", { name: "Plain xAI key Connected" }),
    ).toBeInTheDocument();
  });

  it("does not let a mutable name turn an ordinary xAI key into a subscription", () => {
    const nameOnlyXPremiumKey = {
      id: "x-premium-name-only",
      name: "SuperGrok",
      provider: "xai",
      scope: "personal",
      userId: "current-user",
    } as LlmProviderApiKey;
    const xaiApiKey = {
      id: "xai-api-key",
      name: "Plain xAI key",
      provider: "xai",
      scope: "org",
      userId: null,
    } as LlmProviderApiKey;
    vi.mocked(useAvailableLlmProviderApiKeys).mockReturnValue({
      data: [nameOnlyXPremiumKey, xaiApiKey],
      isLoading: false,
    } as unknown as ReturnType<typeof useAvailableLlmProviderApiKeys>);

    renderSelector();

    expect(
      screen.getByRole("button", { name: "SuperGrok Connected" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "SuperGrok Connect" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Plain xAI key Connected" }),
    ).toBeInTheDocument();
  });

  it("re-opens the SuperGrok sign-in flow to reconnect a selected SuperGrok key", async () => {
    const user = userEvent.setup();
    const xPremiumKey = {
      id: "x-premium-key",
      name: "SuperGrok",
      provider: "xai",
      scope: "personal",
      userId: "current-user",
      subscriptionKind: "x-premium",
    } as LlmProviderApiKey;
    vi.mocked(useAvailableLlmProviderApiKeys).mockReturnValue({
      data: [xPremiumKey],
      isLoading: false,
    } as unknown as ReturnType<typeof useAvailableLlmProviderApiKeys>);

    render(
      <LlmProviderApiKeySelector
        currentConversationChatApiKeyId="x-premium-key"
        currentProvider="xai"
        onApiKeyChange={() => {}}
        suppressAutoSelect
      />,
    );

    await user.click(
      screen.getByRole("button", {
        name: /^SuperGrok Connected\s*Selected$/,
      }),
    );

    expect(screen.getByText("Reconnect SuperGrok")).toBeInTheDocument();
    expect(screen.getByText("reconnect:x-premium-key")).toBeInTheDocument();
  });
});

function renderSelector() {
  return render(
    <LlmProviderApiKeySelector
      currentConversationChatApiKeyId={null}
      onApiKeyChange={() => {}}
    />,
  );
}
