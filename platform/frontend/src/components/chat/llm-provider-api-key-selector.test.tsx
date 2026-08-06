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
    onSelectKey,
    selectedApiKeyId,
  }: {
    availableKeys: Array<{
      id: string;
      name: string;
      connectRequired?: boolean;
    }>;
    onSelectKey: (id: string) => void;
    selectedApiKeyId: string | null;
  }) => (
    <div>
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
    reconnectKeyId,
  }: {
    title: string;
    defaultValues: { provider?: string; openaiAuthMethod?: string };
    reconnectKeyId?: string;
  }) => (
    <div>
      <span>{title}</span>
      <span>{defaultValues.provider}</span>
      <span>{defaultValues.openaiAuthMethod}</span>
      {reconnectKeyId && <span>{`reconnect:${reconnectKeyId}`}</span>}
    </div>
  ),
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
  });

  it("does not duplicate a connected subscription", () => {
    const chatgptKey = {
      id: "chatgpt-key",
      name: "My ChatGPT",
      provider: "openai",
      scope: "personal",
      userId: "current-user",
      isChatgptSubscription: true,
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
      isChatgptSubscription: true,
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

  it("recognizes a pinned ChatGPT subscription when secret metadata is unavailable", () => {
    const agentOwnerKey = {
      id: "agent-owner-chatgpt-key",
      name: "ChatGPT Subscription",
      provider: "openai",
      scope: "personal",
      userId: "another-user",
      isChatgptSubscription: false,
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
        name: /^ChatGPT Subscription Connect\s*Selected$/,
      }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", {
        name: /^ChatGPT Subscription Connected\s*Selected$/,
      }),
    ).not.toBeInTheDocument();
  });

  it("opens the pinned subscription flow when the composer requests connection", () => {
    const agentOwnerKey = {
      id: "agent-owner-chatgpt-key",
      name: "ChatGPT Subscription",
      provider: "openai",
      scope: "personal",
      userId: "another-user",
      isChatgptSubscription: false,
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
    expect(screen.getByText("chatgpt-subscription")).toBeInTheDocument();
  });

  it("re-opens the sign-in flow to reconnect a connected subscription that is already selected", async () => {
    const user = userEvent.setup();
    const chatgptKey = {
      id: "chatgpt-key",
      name: "ChatGPT Subscription",
      provider: "openai",
      scope: "personal",
      userId: "current-user",
      isChatgptSubscription: true,
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
    expect(screen.getByText("chatgpt-subscription")).toBeInTheDocument();
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
